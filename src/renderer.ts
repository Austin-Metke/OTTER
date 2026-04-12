/**
 * renderer.ts
 *
 * OTTER Read-Only Prototype – Renderer Process
 *
 * This file implements the user interface logic for the OTTER demonstration app.
 * It runs in Electron's renderer process and is responsible for:
 *
 *   • Displaying the main audio waveform
 *   • Displaying a transcript with word-level timing
 *   • Synchronizing transcript selection with audio playback
 *   • Rendering a secondary "detail" waveform for a selected word
 *   • Highlighting and playing a bounded audio region corresponding to a word
 *
 * This renderer intentionally treats the transcript as a *first-class interaction
 * surface*: clicking on text seeks the audio, and playback updates the playhead word.
 *
 * Architectural Notes
 * -------------------
 * • The renderer does NOT access the filesystem or spawn processes directly.
 *   All privileged operations (file selection, ffmpeg, transcription) are
 *   delegated to the main process via IPC exposed through preload.ts.
 *
 * • Audio visualization and playback are handled by WaveSurfer.js.
 *   The Regions plugin is used in the detail view to visualize and adjust
 *   approximate word boundaries.
 *
 * • Transcript word timings are approximate (derived from ASR output).
 *   The detail waveform exists specifically to demonstrate why manual
 *   boundary adjustment ("nudging") may be required for precise editing.
 *
 * Scope and Intent
 * ----------------
 * This file is part of a *read-only proof of concept*. It intentionally:
 *
 *   • Does NOT perform destructive editing
 *   • Does NOT persist project state
 *   • Does NOT attempt to be a production-ready editor
 *
 * Its purpose is to demonstrate feasibility, interaction patterns, and
 * architectural separation for a transcript-driven media editor, serving
 * as a conceptual foundation for a future capstone project.
 */


type TranscriptWord = {
  word: string;
  start: number;
  end: number;
  [key: string]: unknown;
  breakAfter?: number;
};

type TranscriptResult =
  | TranscriptWord[]
  | {
      words: TranscriptWord[];
      language?: string;
      [key: string]: unknown;
    };

type TranscribeSpec =
  | { mode: "file"; name: string }
  | { mode: "json"; jsonText: string };

// ---------------------------------------------------------------------------
// Piece Table types
//
// A piece table tracks edits as an ordered sequence of "pieces", each
// referencing a span in either the original buffer (ASR transcript) or
// an add buffer (user-added words). Deleted words remain in the table
// with status "deleted" so they can be displayed with strikethrough
// styling and restored via undo/redo.
//
// The source audio is never modified. Edits are "virtual" until the
// user explicitly exports via "Save Edits".
// ---------------------------------------------------------------------------

type WordStatus = "active" | "deleted" | "added" | "moved";

type PieceEntry = {
  id: string;
  word: string;
  sourceStart: number;
  sourceEnd: number;
  breakAfter?: number;
};

type Piece = {
  source: "original" | "add";
  offset: number;          // index into source buffer
  length: number;          // number of entries in this piece
  status: WordStatus;      // all entries in this piece share this status
};

type PieceTableData = {
  originalBuffer: PieceEntry[];
  addBuffer: PieceEntry[];
  pieces: Piece[];
  sourceFile: string;
  createdAt: string;
  modifiedAt: string;
};

type ViewEntry = {
  entry: PieceEntry;
  status: WordStatus;
  visualIndex: number;
};

type EdlV1Entry = {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  label: string;
  muted: boolean;
};

type OtterApi = {
  chooseAudioFile: () => Promise<string | null>;
  transcribeAudio: (audioPath: string, spec?: TranscribeSpec) => Promise<TranscriptResult>;
  onTranscribeLog: (cb: (msg: string) => void) => void;
  probeAudio: (audioPath: string) => Promise<{ start_time: number; sample_rate: number | null }>;
  onTranscribeProgress: (cb: (pct: number) => void) => void;
  makeSnippet: (audioPath: string, startSec: number, durSec: number) => Promise<string>;
  readFileAsArrayBuffer: (filePath: string) => Promise<ArrayBuffer>;
  listSpecFiles: () => Promise<string[]>;
  readSpecFile: (name: string) => Promise<string>;
  readDefaultSpec: () => Promise<string>;
  pauseTranscription: () => Promise<boolean>;
  resumeTranscription: () => Promise<boolean>;
  cancelTranscription: () => Promise<boolean>;
  saveEdl: (edlJson: string) => Promise<string | null>;
  loadEdl: () => Promise<{ path: string; content: string } | null>;
  exportEdlAudio: (edlJson: string) => Promise<string | null>;
  renderEditedPreview: (edlJson: string) => Promise<string>;
};

declare global {
  interface Window {
    WaveSurfer: any;
    otter: OtterApi;
  }
}

//
// Constants
//
const SEEK_EPS = 0.01;
const DETAIL_PAD_BEFORE = 0.25; // seconds
const DETAIL_PAD_AFTER  = 0.25; // seconds


//
// Global State
//
const WaveSurfer = window.WaveSurfer as any;
const otter = window.otter;

let audioPath: string | null = null;
let words: TranscriptWord[] = [];
let selectionStart: number | null = null;
let selectionEnd: number | null = null;
let selectionAnchor: number | null = null;
let selectedIndices: number[] = [];
let playheadIndex = -1;
let isDragging = false;

type UndoSnapshot = {
  pieces: Piece[];
  originalBuffer: PieceEntry[];
  addBuffer: PieceEntry[];
  words: TranscriptWord[];
};

let pieceTable: PieceTableData | null = null;
let undoStack: UndoSnapshot[] = [];
let redoStack: UndoSnapshot[] = [];

let detailSelStart: number | null = null;
let detailSelEnd: number | null = null;
let isMouseSelecting = false;
let mouseSelectionMoved = false;
let dragMoveSourceIndices: number[] = [];
let isEditedPreviewMode = false;
let previewWordTimes: Array<{ start: number; end: number }> = [];
let previewRefreshToken = 0;
let isRefreshingPreview = false;

//
// Utility Functions
//
function getCssVar(el: HTMLElement | null, name: string, fallback: string) {
  if (!el) return fallback;
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

// Format seconds as 0.00 (or choose your preferred format)
function fmtSec(x: number) {
  return Number(x).toFixed(2);
}

function setStatus(text: string, cls = "info") {
  if (!text) {
    statusEl.textContent = "";
    statusEl.className = "";
    statusEl.style.display = "none";
    return;
  }

  statusEl.textContent = text;
  statusEl.className = cls;
  statusEl.style.display = "inline-block";
}

function shortenFilenameMiddle(filename: string, maxLength = 40) {
  if (filename.length <= maxLength) return filename;

  const dot = filename.lastIndexOf('.');
  const ext = dot !== -1 ? filename.slice(dot) : '';
  const base = dot !== -1 ? filename.slice(0, dot) : filename;

  const maxBase = maxLength - ext.length - 1;
  const front = Math.ceil(maxBase / 2);
  const back = Math.floor(maxBase / 2);

  return (
    base.slice(0, front) +
    '…' +
    base.slice(-back) +
    ext
  );
}

function mustGetEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element: ${id}`);
  return el as T;
}


// ---------------------------------------------------------------------------
// Piece Table utility functions
// ---------------------------------------------------------------------------

/**
 * Build an initial piece table from a completed transcript.
 *
 * Creates the "identity" table where every word is a single active piece.
 * Subsequent edits (remove, restore, etc.) mutate the pieces array without
 * ever touching the original audio file.
 */
function buildPieceTableFromTranscript(
  transcriptWords: TranscriptWord[],
  sourceFile: string
): PieceTableData {
  const now = new Date().toISOString();
  const originalBuffer: PieceEntry[] = transcriptWords.map((w, i) => ({
    id: `w${i}_${crypto.randomUUID().slice(0, 8)}`,
    word: w.word,
    sourceStart: w.start,
    sourceEnd: w.end,
    breakAfter: w.breakAfter,
  }));

  return {
    originalBuffer,
    addBuffer: [],
    pieces: originalBuffer.length > 0
      ? [{ source: "original" as const, offset: 0, length: originalBuffer.length, status: "active" as const }]
      : [],
    sourceFile,
    createdAt: now,
    modifiedAt: now,
  };
}

/**
 * Walk the piece table and produce a flat array of view entries.
 *
 * Each view entry pairs a PieceEntry reference with its current status
 * and sequential visual index. Deleted entries are included (they are
 * displayed with strikethrough styling).
 */
function getViewEntries(pt: PieceTableData): ViewEntry[] {
  const result: ViewEntry[] = [];
  let vi = 0;
  for (const p of pt.pieces) {
    const buf = p.source === "original" ? pt.originalBuffer : pt.addBuffer;
    for (let j = 0; j < p.length; j++) {
      result.push({
        entry: buf[p.offset + j],
        status: p.status,
        visualIndex: vi++,
      });
    }
  }
  return result;
}

/**
 * Return only the non-deleted view entries (for export / playback).
 */
function getActiveEntries(pt: PieceTableData): ViewEntry[] {
  return getViewEntries(pt).filter(v => v.status !== "deleted");
}

/**
 * Merge adjacent pieces that reference contiguous spans in the same
 * buffer with the same status. Keeps the piece list compact.
 */
function mergePieces(pieces: Piece[]): Piece[] {
  if (pieces.length === 0) return pieces;
  const merged: Piece[] = [{ ...pieces[0] }];
  for (let i = 1; i < pieces.length; i++) {
    const last = merged[merged.length - 1];
    const p = pieces[i];
    if (
      last.source === p.source &&
      last.status === p.status &&
      last.offset + last.length === p.offset
    ) {
      last.length += p.length;
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

function snapshotState(pt: PieceTableData): UndoSnapshot {
  return {
    pieces: pt.pieces.map(p => ({ ...p })),
    originalBuffer: pt.originalBuffer.map(e => ({ ...e })),
    addBuffer: pt.addBuffer.map(e => ({ ...e })),
    words: words.map(w => ({ ...w })),
  };
}

function pushUndo(): void {
  if (!pieceTable) return;
  undoStack.push(snapshotState(pieceTable));
  redoStack = [];
}

function restoreSnapshot(pt: PieceTableData, snap: UndoSnapshot): void {
  pt.pieces = snap.pieces.map(p => ({ ...p }));
  pt.originalBuffer = snap.originalBuffer.map(e => ({ ...e }));
  pt.addBuffer = snap.addBuffer.map(e => ({ ...e }));
  words = snap.words.map(w => ({ ...w }));
  pt.modifiedAt = new Date().toISOString();
}

function performUndo(): boolean {
  if (!pieceTable || undoStack.length === 0) return false;
  redoStack.push(snapshotState(pieceTable));
  restoreSnapshot(pieceTable, undoStack.pop()!);
  return true;
}

function performRedo(): boolean {
  if (!pieceTable || redoStack.length === 0) return false;
  undoStack.push(snapshotState(pieceTable));
  restoreSnapshot(pieceTable, redoStack.pop()!);
  return true;
}

function syncBreakAfterToPieceTable(): void {
  if (!pieceTable) return;
  const viewEntries = getViewEntries(pieceTable);
  for (let i = 0; i < viewEntries.length && i < words.length; i++) {
    viewEntries[i].entry.breakAfter = words[i].breakAfter;
  }
}

function syncWordsFromPieceTable(): void {
  if (!pieceTable) return;

  const oldWords = words;
  const viewEntries = getViewEntries(pieceTable);

  const newWords: TranscriptWord[] = viewEntries.map(ve => ({
    word: ve.entry.word,
    start: ve.entry.sourceStart,
    end: ve.entry.sourceEnd,
  }));

  for (let i = 0; i < newWords.length; i++) {
    if (oldWords[i]?.breakAfter) {
      newWords[i].breakAfter = oldWords[i].breakAfter;
    }
  }

  words = newWords;
}

async function refreshDetailIfActive(): Promise<void> {
  if (detailSelStart == null || detailSelEnd == null) return;
  if (detailSelStart >= words.length) { detailSelStart = null; detailSelEnd = null; return; }
  const endIdx = Math.min(detailSelEnd, words.length - 1);
  const rangeStart = Number(words[detailSelStart].start);
  const rangeEnd = Number(words[endIdx].end);
  try {
    await loadDetailForRange(rangeStart, rangeEnd);
  } catch (err: unknown) {
    console.error("Failed to refresh detail view:", err);
  }
}


/**
 * Change the status of entries in the visual index range [visualStart, visualEnd]
 * from `fromStatus` → `toStatus`. Pieces are split as needed so only matching
 * entries are affected. Returns true if any change was made.
 */
function applyStatusToRange(
  pt: PieceTableData,
  visualStart: number,
  visualEnd: number,
  fromStatus: WordStatus,
  toStatus: WordStatus
): boolean {
  let runningIndex = 0;
  const newPieces: Piece[] = [];
  let changed = false;

  for (const p of pt.pieces) {
    const pieceStart = runningIndex;
    const pieceEnd = pieceStart + p.length - 1;
    runningIndex += p.length;

    const overlapStart = Math.max(pieceStart, visualStart);
    const overlapEnd = Math.min(pieceEnd, visualEnd);

    if (overlapStart > overlapEnd || p.status !== fromStatus) {
      // No overlap or wrong status — keep piece as-is
      newPieces.push({ ...p });
      continue;
    }

    changed = true;

    // Before overlap
    if (overlapStart > pieceStart) {
      newPieces.push({
        source: p.source,
        offset: p.offset,
        length: overlapStart - pieceStart,
        status: p.status,
      });
    }

    // The overlap — change status
    newPieces.push({
      source: p.source,
      offset: p.offset + (overlapStart - pieceStart),
      length: overlapEnd - overlapStart + 1,
      status: toStatus,
    });

    // After overlap
    if (overlapEnd < pieceEnd) {
      newPieces.push({
        source: p.source,
        offset: p.offset + (overlapEnd - pieceStart + 1),
        length: pieceEnd - overlapEnd,
        status: p.status,
      });
    }
  }

  if (changed) {
    pt.pieces = mergePieces(newPieces);
    pt.modifiedAt = new Date().toISOString();
  }
  return changed;
}

function moveWord(pt: PieceTableData, fromIndex: number, toIndex: number): boolean {
  if (fromIndex === toIndex) return false;

  const entries = getViewEntries(pt);
  if (fromIndex < 0 || fromIndex >= entries.length) return false;
  if (toIndex < 0 || toIndex >= entries.length) return false;

  const moving = entries[fromIndex];

  const withoutSource: ViewEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (i !== fromIndex) withoutSource.push(entries[i]);
  }

  const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
  const reordered: ViewEntry[] = [];
  for (let i = 0; i <= withoutSource.length; i++) {
    if (i === insertAt) reordered.push(moving);
    if (i < withoutSource.length) reordered.push(withoutSource[i]);
  }

  const newPieces: Piece[] = reordered.map(ve => {
    const buf = ve.entry.sourceStart !== undefined
      ? (pt.originalBuffer.indexOf(ve.entry) !== -1 ? "original" as const : "add" as const)
      : "original" as const;
    const bufArr = buf === "original" ? pt.originalBuffer : pt.addBuffer;
    const offset = bufArr.indexOf(ve.entry);
    return {
      source: buf,
      offset,
      length: 1,
      status: ve.status,
    };
  });

  pt.pieces = mergePieces(newPieces);
  pt.modifiedAt = new Date().toISOString();
  return true;
}

function moveRange(
  pt: PieceTableData,
  fromStart: number,
  fromEnd: number,
  toIndex: number
): boolean {
  const entries = getViewEntries(pt);
  if (entries.length === 0) return false;

  const start = Math.min(fromStart, fromEnd);
  const end = Math.max(fromStart, fromEnd);

  if (start < 0 || end >= entries.length) return false;
  if (toIndex < 0 || toIndex > entries.length) return false;

  if (toIndex >= start && toIndex <= end + 1) return false;

  const movedCount = end - start + 1;
  const moved = entries.slice(start, end + 1);
  const remaining = entries.slice(0, start).concat(entries.slice(end + 1));

  const insertAt = toIndex > end ? toIndex - movedCount : toIndex;
  const reordered = remaining.slice(0, insertAt).concat(moved, remaining.slice(insertAt));

  const newPieces: Piece[] = [];
  for (const ve of reordered) {
    const inOriginal = pt.originalBuffer.indexOf(ve.entry) !== -1;
    const source = inOriginal ? ("original" as const) : ("add" as const);
    const buffer = source === "original" ? pt.originalBuffer : pt.addBuffer;
    const offset = buffer.indexOf(ve.entry);

    newPieces.push({
      source,
      offset,
      length: 1,
      status: ve.status,
    });
  }

  pt.pieces = mergePieces(newPieces);
  pt.modifiedAt = new Date().toISOString();
  return true;
}

function moveSelectedIndices(
  pt: PieceTableData,
  indices: number[],
  toIndex: number
): boolean {
  const entries = getViewEntries(pt);
  if (entries.length === 0) return false;

  const unique = Array.from(new Set(indices)).sort((a, b) => a - b);
  if (unique.length === 0) return false;
  if (toIndex < 0 || toIndex > entries.length) return false;

  for (const idx of unique) {
    if (idx < 0 || idx >= entries.length) return false;
  }

  const selectedSet = new Set(unique);
  const selected = entries.filter((_, idx) => selectedSet.has(idx));
  const remaining = entries.filter((_, idx) => !selectedSet.has(idx));

  const selectedBefore = unique.filter((idx) => idx < toIndex).length;
  const insertAt = toIndex - selectedBefore;
  if (insertAt < 0 || insertAt > remaining.length) return false;

  const reordered = remaining
    .slice(0, insertAt)
    .concat(selected, remaining.slice(insertAt));

  const newPieces: Piece[] = [];
  for (const ve of reordered) {
    const inOriginal = pt.originalBuffer.indexOf(ve.entry) !== -1;
    const source = inOriginal ? ("original" as const) : ("add" as const);
    const buffer = source === "original" ? pt.originalBuffer : pt.addBuffer;
    const offset = buffer.indexOf(ve.entry);

    newPieces.push({
      source,
      offset,
      length: 1,
      status: ve.status,
    });
  }

  pt.pieces = mergePieces(newPieces);
  pt.modifiedAt = new Date().toISOString();
  return true;
}

/**
 * Validate a parsed object as a v2 EDL (piece table format).
 */
function isEdlV2(obj: unknown): obj is { version: 2; pieceTable: PieceTableData } {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o.version !== 2) return false;
  const pt = o.pieceTable as Record<string, unknown>;
  if (!pt || typeof pt !== "object") return false;
  if (!Array.isArray(pt.originalBuffer)) return false;
  if (!Array.isArray(pt.addBuffer)) return false;
  if (!Array.isArray(pt.pieces)) return false;
  if (typeof pt.sourceFile !== "string") return false;
  return true;
}

/**
 * Validate a parsed object as a v1 EDL (old mute-based format).
 */
function isEdlV1(obj: unknown): obj is { version: 1; sourceFile: string; entries: EdlV1Entry[]; createdAt: string; modifiedAt: string } {
  if (!obj || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (typeof o.sourceFile !== "string") return false;
  if (!Array.isArray(o.entries)) return false;
  return (o.entries as unknown[]).every((e) => {
    if (!e || typeof e !== "object") return false;
    const entry = e as Record<string, unknown>;
    return (
      typeof entry.id === "string" &&
      typeof entry.sourceStart === "number" &&
      typeof entry.sourceEnd === "number" &&
      typeof entry.label === "string" &&
      typeof entry.muted === "boolean"
    );
  });
}

/**
 * Convert a v1 EDL (mute-based) to a v2 piece table.
 */
function convertV1ToV2(v1: { sourceFile: string; entries: EdlV1Entry[]; createdAt: string; modifiedAt: string }): PieceTableData {
  const originalBuffer: PieceEntry[] = v1.entries.map(e => ({
    id: e.id,
    word: e.label,
    sourceStart: e.sourceStart,
    sourceEnd: e.sourceEnd,
  }));

    const pieces: Piece[] = [];
  let i = 0;
  while (i < v1.entries.length) {
    const muted = v1.entries[i].muted;
    let j = i;
    while (j < v1.entries.length && v1.entries[j].muted === muted) j++;
    pieces.push({
      source: "original" as const,
      offset: i,
      length: j - i,
      status: muted ? "deleted" as const : "active" as const,
    });
    i = j;
  }

  return {
    originalBuffer,
    addBuffer: [],
    pieces,
    sourceFile: v1.sourceFile,
    createdAt: v1.createdAt,
    modifiedAt: v1.modifiedAt,
  };
}

/**
 * Enable or disable editing buttons based on current piece table and selection state.
 */
function updateEditButtonStates() {
  const hasPt = pieceTable != null;
  const hasSel = selectedIndices.length > 0;

  btnRemove.disabled = !hasPt || !hasSel;
  btnRestore.disabled = !hasPt || !hasSel;
  btnUndo.disabled = !hasPt || undoStack.length === 0;
  btnRedo.disabled = !hasPt || redoStack.length === 0;
  btnSaveEdl.disabled = !hasPt;
  btnSaveEdits.disabled = !hasPt;
}

/**
 * Write the detail-region's current bounds back to the corresponding
 * piece table entry (and the parallel words[] array) so that boundary
 * adjustments are persisted.
 */
function writebackRegionBounds() {
  if (!pieceTable || !detailRegion || detailSelStart == null) return;

  const absStart = detailWinStartAbs + detailRegion.start;
  const absEnd = detailWinStartAbs + detailRegion.end;
  const viewEntries = getViewEntries(pieceTable);

  if (detailSelStart === detailSelEnd) {
    const ve = viewEntries[detailSelStart];
    if (ve) {
      ve.entry.sourceStart = absStart;
      ve.entry.sourceEnd = absEnd;
      words[detailSelStart].start = absStart;
      words[detailSelStart].end = absEnd;
    }
  } else if (detailSelEnd != null) {
    const veStart = viewEntries[detailSelStart];
    const veEnd = viewEntries[detailSelEnd];
    if (veStart) {
      veStart.entry.sourceStart = absStart;
      words[detailSelStart].start = absStart;
    }
    if (veEnd) {
      veEnd.entry.sourceEnd = absEnd;
      words[detailSelEnd].end = absEnd;
    }
  }

  pieceTable.modifiedAt = new Date().toISOString();
}


const DELETED_REGION_COLOR = "rgba(180, 180, 180, 0.45)";

/**
 * Sync gray overlay regions on the main waveform with the piece table's
 * deleted entries. Called after every edit so the waveform visually
 * reflects which segments have been removed.
 */
function updateDeletedRegions() {
  mainRegions.clearRegions();
  if (!pieceTable) return;

  const viewEntries = getViewEntries(pieceTable);
  let i = 0;
  while (i < viewEntries.length) {
    if (viewEntries[i].status !== "deleted") { i++; continue; }
    const start = viewEntries[i].entry.sourceStart;
    let end = viewEntries[i].entry.sourceEnd;
    let j = i + 1;
    while (j < viewEntries.length && viewEntries[j].status === "deleted") {
      end = Math.max(end, viewEntries[j].entry.sourceEnd);
      j++;
    }
    mainRegions.addRegion({
      start,
      end,
      drag: false,
      resize: false,
      color: DELETED_REGION_COLOR,
    });
    i = j;
  }
}


//==============================================================================
//
// BEGIN: Primary rendering logic
//
//==============================================================================

const transcriptEl = mustGetEl<HTMLDivElement>("transcript");
const btnChoose = mustGetEl<HTMLButtonElement>("btnChoose");
const btnTranscribe = mustGetEl<HTMLButtonElement>("btnTranscribe");
const btnPause = mustGetEl<HTMLButtonElement>("btnPause");
const btnStop = mustGetEl<HTMLButtonElement>("btnStop");
const statusEl = mustGetEl<HTMLDivElement>("status");

let isPaused = false;

function setTranscribingState(active: boolean) {
  btnTranscribe.hidden = active;
  btnPause.hidden = !active;
  btnStop.hidden = !active;
  if (!active) {
    isPaused = false;
    btnPause.textContent = "⏸ Pause";
  }
}

transcriptEl.addEventListener("dragover", (event: DragEvent) => {
  if (dragMoveSourceIndices.length === 0) return;
  if ((event.target as HTMLElement).closest(".word")) return;
  event.preventDefault();
  clearDropIndicators();
});

transcriptEl.addEventListener("drop", (event: DragEvent) => {
  if (dragMoveSourceIndices.length === 0) return;
  if ((event.target as HTMLElement).closest(".word")) return;
  event.preventDefault();
  clearDropIndicators();
  moveCurrentSelection(words.length);
  dragMoveSourceIndices = [];
  transcriptEl.classList.remove("dragging-words");
});

function normalizeRange(a: number, b: number) {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

// For search function
const findBar = document.getElementById("searchBar")!;
const findInput = document.getElementById("searchInput") as HTMLInputElement;
const findClose = document.getElementById("findClose")!;
findBar.hidden = true;
  



//Ctrl + F keyboard shortcut
window.addEventListener("keydown", (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
  }

  if (event.key === "Escape") {
    findBar.hidden = true;
    clearSearchHighlights();
  }
});

findClose.addEventListener("click", () => {
  findBar.hidden = true;
  clearSearchHighlights();
});


let lastFoundIndex = -1;
let lastSearchQuery = "";
//Search word (Enter key)
findInput.addEventListener("keydown", (event: KeyboardEvent) => {
    if(event.key !== "Enter")
    {
      return;
    }
   
    const searchQuery = findInput.value.trim().toLowerCase();
    if(!searchQuery) 
    {
      return;
    }

    // If the user types in a new word, start from the beginning again
    if (searchQuery !== lastSearchQuery) {
        lastFoundIndex = -1;
        lastSearchQuery = searchQuery;
      }
    let found = false;
      // Go to the next word (same word)
    for(let i = lastFoundIndex + 1; i < words.length; i++)
    {
      if(words[i].word.toLowerCase().includes(searchQuery))
      {
        lastFoundIndex=  i;
        found = true;
        lastSearchQuery = searchQuery;
      const wordFound = words[i];
      setSelectionRange(i, i); //highlights the word
      ws.setTime(Number(wordFound.start) + SEEK_EPS); // also adjusts the word's start time

      const wordElement = transcriptEl.querySelector(
      `.word[data-index="${i}"]`
      ) as HTMLElement | null;

      wordElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      break;
    }

    }

   if(!found)
    {
      //Wrap around search
      for(let i = 0; i < lastFoundIndex; i++)
      {
        if(words[i].word.toLowerCase().includes(searchQuery))
        {
          lastFoundIndex = i;
            lastSearchQuery = searchQuery;
      const wordFound = words[i];
      setSelectionRange(i, i); //highlights the word
      ws.setTime(Number(wordFound.start) + SEEK_EPS); // also adjusts the word's start time

      const wordElement = transcriptEl.querySelector(
      `.word[data-index="${i}"]`
      ) as HTMLElement | null;

      wordElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      break;
        }
      }
    }

  });

  //Reset function for searching
function clearSearchHighlights() {

  const transcriptWords = transcriptEl.querySelectorAll(".word");

  for (let i = 0; i < transcriptWords.length; i++) {

    const wordElement = transcriptWords[i] as HTMLElement;
    const index = Number(wordElement.dataset.index);
    const wordText = words[index].word;    
    wordElement.innerHTML = wordText + " ";
  }
}

  //Highlighting the user's entry in the search bar
  findInput.addEventListener("input", () =>{
    const searchQuery = findInput.value.trim().toLowerCase();
    const transcriptWords = transcriptEl.querySelectorAll(".word");
   
    for(let i = 0; i < transcriptWords.length; i++)
    {
      const wordElement = transcriptWords[i] as HTMLElement;
      const index = Number(wordElement.dataset.index);
      const wordText = words[index].word;
      wordElement.innerHTML = wordText + " ";
      const matchPosition = wordText.toLowerCase().indexOf(searchQuery)
      if(matchPosition === -1)
      {
        continue;
      }
      
      //Slicing the highlights
      const before = wordText.slice(0,matchPosition);
      const matchingChar = wordText.slice(matchPosition, matchPosition + searchQuery.length);
      const after = wordText.slice(matchPosition + searchQuery.length);
      wordElement.innerHTML=  before +'<span class="highlight">' + matchingChar + '</span>' +after +" ";
    }

})



function uniqueSortedIndices(indices: number[]): number[] {
  const unique = Array.from(new Set(indices));
  unique.sort((a, b) => a - b);
  return unique;
}

function isContiguousSelection(indices: number[]): boolean {
  if (indices.length <= 1) return true;
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1] + 1) return false;
  }
  return true;
}

function getSelectedRanges(indices: number[]): Array<{ start: number; end: number }> {
  if (indices.length === 0) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  let start = indices[0];
  let end = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i];
    if (idx === end + 1) {
      end = idx;
    } else {
      ranges.push({ start, end });
      start = idx;
      end = idx;
    }
  }
  ranges.push({ start, end });
  return ranges;
}

function setSelectedIndices(indices: number[], anchor: number | null = selectionAnchor) {
  const next = uniqueSortedIndices(indices).filter((idx) => idx >= 0 && idx < words.length);
  selectedIndices = next;
  selectionAnchor = anchor;

  if (next.length > 0 && isContiguousSelection(next)) {
    selectionStart = next[0];
    selectionEnd = next[next.length - 1];
  } else {
    selectionStart = null;
    selectionEnd = null;
  }

  const selectedSet = new Set(next);
  const nodes = transcriptEl.querySelectorAll<HTMLElement>(".word");
  nodes.forEach((el) => {
    const idx = Number(el.dataset.index);
    el.classList.toggle("selected", selectedSet.has(idx));
  });

  updateEditButtonStates();
}

function clearDropIndicators() {
  const nodes = transcriptEl.querySelectorAll<HTMLElement>(".word.drop-before, .word.drop-after");
  nodes.forEach((n) => {
    n.classList.remove("drop-before");
    n.classList.remove("drop-after");
  });
}

function moveCurrentSelection(toIndex: number) {
  if (!pieceTable || selectedIndices.length === 0) return;

  const sorted = uniqueSortedIndices(selectedIndices);
  const selectedCount = sorted.length;
  const selectedBefore = sorted.filter((idx) => idx < toIndex).length;
  const insertAt = toIndex - selectedBefore;

  pushUndo();

  let changed = false;
  if (sorted.length === 1 && toIndex < words.length) {
    changed = moveWord(pieceTable, sorted[0], toIndex);
  } else if (isContiguousSelection(sorted)) {
    changed = moveRange(pieceTable, sorted[0], sorted[sorted.length - 1], toIndex);
  } else {
    changed = moveSelectedIndices(pieceTable, sorted, toIndex);
  }

  if (!changed) {
    undoStack.pop();
    return;
  }

  syncWordsFromPieceTable();

  const movedSelection: number[] = [];
  for (let i = 0; i < selectedCount; i++) {
    movedSelection.push(insertAt + i);
  }

  setSelectedIndices(movedSelection, movedSelection.length > 0 ? movedSelection[0] : null);

  if (movedSelection.length === 1) {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[0];
  } else if (isContiguousSelection(movedSelection)) {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[movedSelection.length - 1];
  } else {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[0];
  }

  renderTranscript(words);
  void refreshMainWavePreviewFromEdits();
  refreshDetailIfActive();
}

function resetEditedPreviewState() {
  isEditedPreviewMode = false;
  previewWordTimes = [];
}

function buildPreviewWordTimesFromActiveEntries(activeEntries: ViewEntry[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let t = 0;
  for (const ve of activeEntries) {
    const dur = Math.max(0, Number(ve.entry.sourceEnd) - Number(ve.entry.sourceStart));
    out.push({ start: t, end: t + dur });
    t += dur;
  }
  return out;
}

async function loadMainWaveFromPath(filePath: string) {
  const ab = await otter.readFileAsArrayBuffer(filePath);
  const blob = new Blob([ab]);
  await ws.loadBlob(blob);
}

async function refreshMainWavePreviewFromEdits() {
  if (!audioPath) return;

  const token = ++previewRefreshToken;
  isRefreshingPreview = true;

  try {
    if (!pieceTable) {
      resetEditedPreviewState();
      await loadMainWaveFromPath(audioPath);
      return;
    }

    const activeEntries = getActiveEntries(pieceTable);
    if (activeEntries.length === 0) {
      resetEditedPreviewState();
      await loadMainWaveFromPath(audioPath);
      return;
    }

    const payload = {
      version: 1,
      sourceFile: pieceTable.sourceFile,
      entries: activeEntries.map((ve) => ({
        id: ve.entry.id,
        sourceStart: ve.entry.sourceStart,
        sourceEnd: ve.entry.sourceEnd,
        label: ve.entry.word,
        muted: false,
      })),
      createdAt: pieceTable.createdAt,
      modifiedAt: pieceTable.modifiedAt,
    };

    const json = JSON.stringify(payload);
    const previewPath = await otter.renderEditedPreview(json);
    if (token !== previewRefreshToken) return;

    await loadMainWaveFromPath(previewPath);
    if (token !== previewRefreshToken) return;

    previewWordTimes = buildPreviewWordTimesFromActiveEntries(activeEntries);
    isEditedPreviewMode = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(`\nWARN: Failed to refresh edited preview: ${msg}\n`);
    if (token === previewRefreshToken && audioPath) {
      resetEditedPreviewState();
      await loadMainWaveFromPath(audioPath);
    }
  } finally {
    if (token === previewRefreshToken) {
      isRefreshingPreview = false;
    }
  }
}

/**
 * Update the visual "playhead" state to reflect the word currently
 * under the audio playhead. This is independent from any text selection.
 *
 * @param {number} idx - Index of the word to mark as playhead, or -1 to clear.
 */
function setPlayheadIndex(idx: number) {
  if (playheadIndex === idx) return;

  const prev = transcriptEl.querySelector(".word.playhead");
  if (prev) prev.classList.remove("playhead");

  playheadIndex = idx;
  if (idx >= 0) {
    const el = transcriptEl.querySelector(`.word[data-index="${idx}"]`);
    if (el) el.classList.add("playhead");
  }
}

/**
 * Update the visual selection state for a range of words.
 *
 * @param {number|null} start - Start index, or null to clear selection.
 * @param {number|null} end   - End index, or null to clear selection.
 */
function setSelectionRange(start: number | null, end: number | null) {
  if (start == null || end == null) {
    setSelectedIndices([], null);
  } else {
    const range = normalizeRange(start, end);
    const indices: number[] = [];
    for (let i = range.start; i <= range.end; i++) indices.push(i);
    setSelectedIndices(indices, selectionAnchor);
  }
}

// Compute a small snippet window around a word boundary.
// This keeps the detail waveform focused on just the selected word plus context.
function computeDetailWindow(start: number, end: number) {
  const winStart = Math.max(0, start - DETAIL_PAD_BEFORE);
  const winEnd = Math.max(winStart + 0.05, end + DETAIL_PAD_AFTER); // enforce minimum duration
  detailWinStartAbs = winStart; // Remember where this detail starts in "absolute" time
  return { winStart, winEnd, winDur: winEnd - winStart };
}

/**
 * Load/update the detail waveform for a selected range.
 *
 * Steps:
 *   1) Extract a short WAV snippet around the range using ffmpeg (via IPC).
 *   2) Load the snippet into the detail WaveSurfer instance.
 *   3) Create/update a region highlighting the range inside that snippet.
 *   4) Seek the detail playhead to the start of the range.
 *
 * The detail view exists to demonstrate that ASR word boundaries are approximate
 * and that precise editing may require user refinement.
 */
async function loadDetailForRange(start: number, end: number) {
  if (!audioPath) throw new Error("No audio loaded");
  const { winStart, winDur } = computeDetailWindow(start, end);

  // Create a short WAV snippet around the selected word (main process uses ffmpeg)
  const snippetPath = await otter.makeSnippet(audioPath, winStart, winDur);

  // If the detail waveform is currently playing, stop it before swapping media
  if (wsDetail.isPlaying()) wsDetail.pause();

  // Enable/show detail UI now that detail audio exists
  waveDetailPane.hidden = false;
  detailDivider.hidden = false;
  btnDetailPlay.disabled = false;
  btnRegion.disabled = false;
  setDetailPlayIcon(false);

  // Map the range's absolute times into snippet-local times
  const localRangeStart = start - winStart;
  const localRangeEnd = end - winStart;

  // Attach the handler BEFORE calling load() to avoid missing "ready" in fast loads
  wsDetail.once("ready", () => {
    setDetailWordRegion(localRangeStart, localRangeEnd);
    wsDetail.setTime(localRangeStart);
  });

  await wsDetail.load(snippetPath);
}

/**
 * Render the transcript as a sequence of clickable word elements and
 * attach interaction behavior to each word.
 *
 * Each word is rendered as a <span> with a stable index that maps back
 * to the transcript data model. Clicking a word performs several actions:
 *
 *   • Marks the word as selected in the transcript UI
 *   • Seeks the main audio playback to the word's approximate start time
 *   • Loads a short, focused audio snippet into the detail waveform
 *     centered on the selected word
 *
 * The transcript is treated as a first-class interaction surface rather
 * than a passive display: text selection directly drives audio navigation.
 *
 * This function also supports drag selection:
 *
 *   • mousedown on a word: starts drag, establishes anchor
 *   • mouseover while dragging: expands/contracts selection dynamically
 *   • mouseup (global): finalizes selection
 *
 * Both click and drag integration use setSelectionRange() to ensure
 * consistent behavior and normalization of selection order.
 *
 * This function is intentionally simple and imperative for clarity in
 * this proof-of-concept; more advanced implementations might virtualize
 * the transcript or decouple rendering from interaction logic.
 *
 * @param {Array<Object>} words - Transcript words with timing metadata
 *                                (each entry includes at least { word, start, end })
 */
function renderTranscript(words: TranscriptWord[]) {
  transcriptEl.innerHTML = "";
  const viewEntries = pieceTable ? getViewEntries(pieceTable) : [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w.word + " ";
    span.dataset.index = String(i);
    span.draggable = true;

    const ve = viewEntries[i];
    if (ve) {
      if (ve.status === "deleted") span.classList.add("deleted");
      else if (ve.status === "added") span.classList.add("added");
      else if (ve.status === "moved") span.classList.add("moved");
    }

    span.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey) return;

      const alreadySelected = selectedIndices.includes(i);
      if (alreadySelected && selectedIndices.length > 0) {
        mouseSelectionMoved = false;
        return;
      }

      selectionAnchor = i;
      setSelectionRange(i, i);
      isMouseSelecting = true;
      mouseSelectionMoved = false;
      event.preventDefault();
    });

    span.addEventListener("mouseenter", () => {
      if (!isMouseSelecting || selectionAnchor == null) return;
      if (selectionEnd !== i || selectionStart !== selectionAnchor) {
        mouseSelectionMoved = true;
      }
      setSelectionRange(selectionAnchor, i);
    });

    span.addEventListener("dragstart", (event: DragEvent) => {
      if (selectedIndices.includes(i) && selectedIndices.length > 0) {
        dragMoveSourceIndices = selectedIndices.slice();
      } else {
        setSelectedIndices([i], i);
        dragMoveSourceIndices = [i];
      }

      transcriptEl.classList.add("dragging-words");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "move");
      }
    });

    span.addEventListener("dragover", (event: DragEvent) => {
      if (dragMoveSourceIndices.length === 0) return;
      event.preventDefault();

      const rect = span.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;

      clearDropIndicators();
      span.classList.add(before ? "drop-before" : "drop-after");
    });

    span.addEventListener("drop", (event: DragEvent) => {
      if (dragMoveSourceIndices.length === 0) return;
      event.preventDefault();
      event.stopPropagation();

      const rect = span.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      const targetIndex = before ? i : i + 1;

      clearDropIndicators();
      moveCurrentSelection(targetIndex);
      dragMoveSourceIndices = [];
      transcriptEl.classList.remove("dragging-words");
    });

    span.addEventListener("dragend", () => {
      clearDropIndicators();
      dragMoveSourceIndices = [];
      transcriptEl.classList.remove("dragging-words");
    });

    span.addEventListener("click", async (event: MouseEvent) => {
      if (mouseSelectionMoved) {
        mouseSelectionMoved = false;
        return;
      }

      // Transcript click = select word + seek main audio
      if (event.ctrlKey || event.metaKey) {
        if (selectedIndices.includes(i)) {
          setSelectedIndices(selectedIndices.filter((idx) => idx !== i), selectionAnchor);
        } else {
          setSelectedIndices(selectedIndices.concat(i), i);
        }
      } else if (event.shiftKey && selectionAnchor != null) {
        setSelectionRange(selectionAnchor, i);
      } else {
        selectionAnchor = i;
        setSelectionRange(i, i);
      }

      if (!selectedIndices.includes(i)) return;

      const seekTime = isEditedPreviewMode && previewWordTimes[i]
        ? previewWordTimes[i].start
        : Number(w.start);
      ws.setTime(seekTime + SEEK_EPS);
      setPlayheadIndex(i);

      // Load the detail waveform snippet centered on the selected range
      let rangeStartIdx = i;
      let rangeEndIdx = i;
      if (selectedIndices.length > 1 && isContiguousSelection(selectedIndices)) {
        rangeStartIdx = selectedIndices[0];
        rangeEndIdx = selectedIndices[selectedIndices.length - 1];
      }
      const rangeStart = Number(words[rangeStartIdx].start);
      const rangeEnd = Number(words[rangeEndIdx].end);

      detailSelStart = rangeStartIdx;
      detailSelEnd = rangeEndIdx;

      try {
        await loadDetailForRange(rangeStart, rangeEnd);
      } catch (err: unknown) {
        console.error("Failed to load detail snippet:", err);
      }
    });

    // Drag Selection: mousedown
    // When the user presses the mouse button on a word:
    //   • Set isDragging = true to signal that drag is active
    //   • Record selectionAnchor as the origin point (never changes during drag)
    //   • Highlight the starting word immediately
    span.addEventListener("mousedown", (event: MouseEvent) => {
      event.preventDefault();
      isDragging = true;
      selectionAnchor = i;
      setSelectionRange(i, i);
    });

    // Drag Selection: mouseover while dragging
    // As the user moves the cursor across words:
    //   • Check if drag is active (isDragging === true)
    //   • Get the hovered word's index from the DOM
    //   • Call setSelectionRange(anchor, hovered) to expand/contract selection
    //   • Both forward and backward drag work because setSelectionRange()
    //     normalizes the range order internally
    span.addEventListener("mouseover", (event: MouseEvent) => {
      if (!isDragging) return;
      const hoveredIndex = Number((event.target as HTMLElement).dataset.index);
      if (selectionAnchor != null && !isNaN(hoveredIndex)) {
        setSelectionRange(selectionAnchor, hoveredIndex);
      }
    });

    transcriptEl.appendChild(span);

    const breakCount = words[i].breakAfter ?? 0;
    for (let j = 0; j < breakCount; j++) 
    {
      transcriptEl.appendChild(document.createElement("br"));
    }

    
  }

  // Re-apply selection and playhead after re-render (e.g., new transcript)
  const keptSelection = selectedIndices.filter((idx) => idx >= 0 && idx < words.length);
  setSelectedIndices(keptSelection, selectionAnchor);

  if (playheadIndex >= 0 && playheadIndex < words.length) {
    setPlayheadIndex(playheadIndex);
  } else {
    setPlayheadIndex(-1);
  }

  updateDeletedRegions();
}

/**
 * Drag Selection: Global mouseup handler
 *
 * Attach a global listener to window so that drag ends correctly even if
 * the user releases the mouse button outside the transcript pane.
 *
 * This ensures isDragging is always set to false when the button is released,
 * preventing a "stuck" drag state.
 */
function initializeDragEnd() {
  window.addEventListener("mouseup", (_event: MouseEvent) => {
    if (isDragging) {
      isDragging = false;
      // Selection remains as-is; do not modify it further
    }
  });
}

//==============================================================================
//
// BEGIN: Objects and code related to the Wave Pane
//
//==============================================================================

const btnPlay = mustGetEl<HTMLButtonElement>("btnPlay");
const timeEl = mustGetEl<HTMLSpanElement>("time");
const progressEl = mustGetEl<HTMLProgressElement>("transcribeProgress");
const fnameEl = mustGetEl<HTMLSpanElement>("loadedFile");

// Switch between play and pause icons
function setPlayIcon(isPlaying: boolean) {
  btnPlay.textContent = isPlaying ? "⏸︎" : "▶︎";
  btnPlay.title = isPlaying ? "Pause" : "Play";
  btnPlay.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

// Create a Regions plugin instance for the main waveform (deleted-region overlays)
const mainRegions = WaveSurfer.Regions.create();

// Create the waveform visualization object
const ws = WaveSurfer.create({
  container: "#waveform",
  height: 80,
  normalize: true,
  plugins: [mainRegions]
});

// Keep the play/pause button icon in sync with the current status of playback
ws.on("play", () => setPlayIcon(true));
ws.on("pause", () => setPlayIcon(false));
ws.on("finish", () => {
  setPlayIcon(false);
});

// Handle the "Play" button
btnPlay.addEventListener("click", () => {
  ws.playPause();
});


// Highlight the current word based on playback time.
ws.on("timeupdate", (t: number) => {
  timeEl.textContent = `${t.toFixed(2)}s`;
  const te = t + 0.01; // 10ms bias

  // We intentionally apply a small positive time bias (≈10 ms) before
  // comparing against ASR-provided word boundaries. In practice, audio
  // playback time and transcript timestamps are not perfectly aligned:
  //
  //   • decoder latency and frame-based codecs introduce small offsets
  //   • ASR word boundaries are approximate, not sample-accurate
  //   • timeupdate events may fire slightly before perceptual word onset
  //
  // Without this bias, the UI can lag by one word at boundary transitions.
  // The bias nudges the comparison forward so the highlighted word better
  // matches what the user is actually hearing.
  //
  // This is a pragmatic PoC workaround; a production system will
  // use a more robust alignment strategy and allow user-adjusted
  // boundaries to override ASR timings.

  // We use a simple linear scan for this PoC, but
  // a real implementation should be smarter (e.g. binary search)
  let idx = -1;
  for (let i = 0; i < words.length; i++) {
    const start = isEditedPreviewMode && previewWordTimes[i]
      ? previewWordTimes[i].start
      : words[i].start;
    const end = isEditedPreviewMode && previewWordTimes[i]
      ? previewWordTimes[i].end
      : words[i].end;
    if (te >= start && te < end) { idx = i; break; }
  }
  setPlayheadIndex(idx);
});


//==============================================================================
//
// BEGIN: Objects and code related to the Wave Detail Pane
//
//==============================================================================

const btnDetailPlay = mustGetEl<HTMLButtonElement>("btnDetailPlay");
const waveDetailPane = mustGetEl<HTMLDivElement>("waveDetailPane");
const detailDivider = mustGetEl<HTMLHRElement>("detailDivider");
const detailTimeEl = mustGetEl<HTMLSpanElement>("detailTime");
const detailBounds = mustGetEl<HTMLSpanElement>("detailBounds");
const btnRegion = mustGetEl<HTMLButtonElement>("btnRegion");

// Create a Regions plugin instance to manage editable time ranges
const detailRegions = WaveSurfer.Regions.create();

// Create the detail region visualization object
const wsDetail = WaveSurfer.create({
  container: "#waveDetail",
  height: 80,
  plugins: [detailRegions]
});

// Update the UI element showing absolute bounds of the selected region
function updateDetailBounds() {
  if (!detailRegion) {
    detailBounds.textContent = "[— - —]";
    return;
  }

  const absStart = detailWinStartAbs + detailRegion.start;
  const absEnd   = detailWinStartAbs + detailRegion.end;
  detailBounds.textContent = `[${fmtSec(absStart)} - ${fmtSec(absEnd)}]`;
}

/**
 * Create or update the highlighted region in the detail waveform that
 * corresponds to the currently selected transcript word.
 *
 * This function removes any previously displayed region and replaces it
 * with a new one spanning the supplied time range. The region serves as a
 * visual and interactive representation of an approximate word boundary
 * derived from ASR output.
 *
 * Regions are intentionally editable (resize enabled) to demonstrate that
 * transcript-provided word timings are approximate and may require manual
 * refinement for precise audio editing.
 *
 * @param {number} localStart - Start time of the word, in seconds, relative
 *                              to the beginning of the detail waveform.
 * @param {number} localEnd   - End time of the word, in seconds, relative
 *                              to the beginning of the detail waveform.
 */
function setDetailWordRegion(localStart: number, localEnd: number) {
  // remove previous highlight
  if (detailRegion) {
    detailRegion.remove();
    detailRegion = null;
  }

  // add new highlight
  detailRegion = detailRegions.addRegion({
    start: localStart,
    end: localEnd,
    drag: false,
    resize: true,
    color: WORD_REGION_COLOR
  });
  updateDetailBounds();
  detailRegion.on("update", () => {
    updateDetailBounds();
  });
  let regionUndoPushed = false;
  detailRegion.on("update", () => {
    if (!regionUndoPushed) {
      pushUndo();
      regionUndoPushed = true;
    }
  });
  detailRegion.on("update-end", () => {
    writebackRegionBounds();
    void refreshMainWavePreviewFromEdits();
    updateEditButtonStates();
    regionUndoPushed = false;
  });
}

/*
 * -----------------------------------------------------------------------------
 * Detail playback + region playback notes (PoC / WaveSurfer v7)
 *
 * Why this looks more complicated than expected:
 * - WaveSurfer v7 drives playback through the browser's media stack (HTML media),
 *   which does not provide a native "play exactly from A to B and stop" primitive.
 * - We observed that seemingly simpler approaches can be unreliable in practice:
 *     • wsDetail.play(start, end) may ignore `end` and continue to snippet end.
 *     • Seeking and playing from a "finished" state can fail to restart audio
 *       unless we reset state (pause/seek) and avoid stale stop logic.
 *     • Stop-at-end logic based on timeupdate/audioprocess can be flaky because
 *       event cadence isn't guaranteed, and mixing setTime() inside such handlers
 *       can interact badly with plugins like Regions.
 *
 * What we do instead (stable PoC behavior):
 *
 * 1) "Play Region" (btnRegion):
 *    - Clears any prior region stop timer (clearRegionStopTimer()).
 *    - Resets playback state via wsDetail.pause().
 *    - Seeks to region start (wsDetail.setTime(start)) and starts playback.
 *    - Stops after (end-start) using a wall-clock timer (setTimeout).
 *      This is intentionally timer-based, not event-based, to keep the demo
 *      stable across browsers and edge cases.
 *    - Leaves the playhead at region end for clarity (setTime(end)).
 *
 * 2) "Play/Pause Detail" (btnDetailPlay):
 *    - Always clears any region timer first so region playback can't interfere.
 *    - If the playhead is at/near the end, rewinds to 0 so Play produces audio.
 *    - Uses explicit isPlaying()/play()/pause() rather than playPause() to avoid
 *      toggle ambiguity when debugging.
 *
 * It may be tempting to "simplify" this, but any changes require re-testing region
 * playback and detail playback after: repeated plays, starting near EOF, and
 * switching between region play and full-detail play.
 * -----------------------------------------------------------------------------
 */

let regionStopTimer: ReturnType<typeof setTimeout> | null = null;
let detailRegion: any = null;
// Absolute start time (seconds) of the currently-loaded detail snippet
let detailWinStartAbs = 0;

function clearRegionStopTimer() {
  if (regionStopTimer) {
    clearTimeout(regionStopTimer);
    regionStopTimer = null;
  }
}

// Handle the "Play Region" button being pressed
btnRegion.onclick = () => {
  if (!detailRegion) return;

  clearRegionStopTimer();       // cancel any prior region play
  wsDetail.pause();             // reset playback state

  const start = detailRegion.start;
  const end   = detailRegion.end;
  const ms    = Math.max(0, (end - start) * 1000);

  wsDetail.setTime(start);
  wsDetail.play();

  regionStopTimer = setTimeout(() => {
    wsDetail.pause();
    wsDetail.setTime(Math.max(0, end - 0.001));
    regionStopTimer = null;
  }, ms);
};

// Update the time readout for the detail waveform during playback.
// This reflects the current playhead position within the snippet,
// not the absolute time in the source audio.
wsDetail.on("timeupdate", (t: number) => {
  let absT = t + detailWinStartAbs;
  detailTimeEl.textContent = `${absT.toFixed(2)}s`;
});

// Keep the Play Region button in sync with the status of region playback
wsDetail.on("play", () => setDetailPlayIcon(true));
wsDetail.on("pause", () => setDetailPlayIcon(false));
wsDetail.on("finish", () => setDetailPlayIcon(false));

// handle the "Play Region" button
btnDetailPlay.onclick = () => {
  clearRegionStopTimer();

  // If we're at/near end, restart so Play actually plays something.
  const dur = wsDetail.getDuration();
  const t = wsDetail.getCurrentTime();
  if (dur && t >= dur - 0.02) wsDetail.setTime(0);

  // Use explicit play/pause instead of playPause() if you want to be extra deterministic:
  if (wsDetail.isPlaying()) wsDetail.pause();
  else wsDetail.play();
};

// Adjust the icon in the "Play Detail" button
function setDetailPlayIcon(isPlaying: boolean) {
  btnDetailPlay.textContent = isPlaying ? "⏸︎" : "▶︎";
  btnDetailPlay.title = isPlaying ? "Pause Detail" : "Play Detail";
  btnDetailPlay.setAttribute("aria-label", isPlaying ? "Pause Detail" : "Play Detail");
}


//==============================================================================
//
// BEGIN: Objects and code related to Loading and Transcription
//
//==============================================================================

// Handle the "Transcribe" button
btnTranscribe.addEventListener("click", async () => {
  if (!audioPath) return;
  resetEditedPreviewState();
  btnTranscribe.disabled = true;
  setStatus("Preparing to transcribe...", "info");
  appendLog("\n=== Transcription started ===\n");

  try {
    btnChoose.disabled = true;
    progressEl.value = 0;
    progressEl.hidden = false;
    setTranscribingState(true);

    const result = await otter.transcribeAudio(audioPath, getActiveSpecArg());
    words = Array.isArray(result) ? result : (result.words || []);
    const lang = Array.isArray(result) ? undefined : result.language;
    const langSuffix = lang ? `, lang=${lang}` : "";
    setStatus(`Transcript ready (${words.length} words${langSuffix})`, "success");

    pieceTable = buildPieceTableFromTranscript(words, audioPath!);
    undoStack = [];
    redoStack = [];
    updateEditButtonStates();

    renderTranscript(words);
    if (!isRefreshingPreview) {
      await refreshMainWavePreviewFromEdits();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("cancelled")) {
      setStatus("Transcription cancelled.", "info");
    } else {
      setStatus("Transcription failed (see logs).", "error");
      appendLog("\nERROR:\n" + msg + "\n");
    }
  } finally {
    btnChoose.disabled = false;
    btnTranscribe.disabled = false;
    setTranscribingState(false);
    progressEl.hidden = true;
  }
});

// Handle the "Pause / Resume" button
btnPause.addEventListener("click", async () => {
  if (!isPaused) {
    await otter.pauseTranscription();
    isPaused = true;
    btnPause.textContent = "▶ Resume";
    setStatus("Transcription paused.", "info");
  } else {
    await otter.resumeTranscription();
    isPaused = false;
    btnPause.textContent = "⏸ Pause";
    setStatus("Transcribing…", "working");
  }
});

// Handle the "Stop" button
btnStop.addEventListener("click", async () => {
  await otter.cancelTranscription();
});

// Handle the "Choose File" button
btnChoose.addEventListener("click", async () => {
  resetEditedPreviewState();
  setStatus("Choosing file…", "info");

  const selectedPath = await otter.chooseAudioFile();
  if (!selectedPath) {
    setStatus("File selection canceled.", "info");
    return;
  }

  audioPath = selectedPath;

  transcriptEl.innerHTML = "";
  logEl.textContent = "";
  pieceTable = null;
  undoStack = [];
  redoStack = [];
  selectedIndices = [];
  selectionStart = null;
  selectionEnd = null;
  selectionAnchor = null;
  detailSelStart = null;
  detailSelEnd = null;
  updateEditButtonStates();

  btnPlay.disabled = true;
  let fname = audioPath.split("/").pop() ?? audioPath;
  setStatus(`Loaded: ${fname}`, "success");
  setPlayIcon(false);
  btnTranscribe.disabled = false;

  // Load waveform from local file bytes via preload bridge
  const ab = await otter.readFileAsArrayBuffer(audioPath);
  const blob = new Blob([ab]);
  await ws.loadBlob(blob);

  btnPlay.disabled = false;

  fnameEl.textContent = shortenFilenameMiddle(fname);
});

//==============================================================================
//
// BEGIN: Objects and code related to Logging
//
//==============================================================================

const logEl = mustGetEl<HTMLPreElement>("log");

// Add the message to the log area
function appendLog(msg: string) {
  logEl.textContent += msg;
  logEl.scrollTop = logEl.scrollHeight;
}

// We've received a normal log message
otter.onTranscribeLog((msg: string) => appendLog(msg));

// We've received a progress report from the transcirption engine
otter.onTranscribeProgress((pct: number) => {
  progressEl.value = pct;
  progressEl.hidden = false;
  statusEl.textContent = "Transcribing…";
});


//==============================================================================
//
// BEGIN: Objects and code related to developer options
//
//==============================================================================

// Friendly display names for known spec files; unknown files fall back to their filename.
const SPEC_FRIENDLY_LABELS: Record<string, string> = {
  "fw.json":          "Quick",
  "fw_cwt.json":      "Standard",
  "fw_asw_cwt.json":  "Accurate",
  "default_spec.json":"Best Quality",
  "wx_asw_cwt.json":  "Best Quality (alt)",
};

const specSelect = mustGetEl<HTMLSelectElement>("modeSelect");
const chkCustomSpec = mustGetEl<HTMLInputElement>("chkCustomSpec");
const customSpecArea = mustGetEl<HTMLDivElement>("customSpecArea");
const specJsonEl = mustGetEl<HTMLTextAreaElement>("specJson");

// State
let activeSpecName = "default_spec.json";   // currently selected file
let lastLoadedSpecText = "";                // baseline text loaded into textarea
let suppressSpecChange = false;             // prevents recursion when reverting selection


function hasUnsavedCustomEdits() {
  // Only meaningful in customize mode
  if (!chkCustomSpec.checked) return false;
  return (specJsonEl.value || "") !== (lastLoadedSpecText || "");
}

async function loadSelectedSpecIntoTextarea() {
  const name = specSelect.value || "default_spec.json";
  const txt = await otter.readSpecFile(name);
  specJsonEl.value = txt;
  lastLoadedSpecText = txt;
}

function showCustomArea(show: boolean) {
  customSpecArea.hidden = !show;
}

/**
 * Spec argument passed to main.ts when transcribing.
 */
function getActiveSpecArg(): TranscribeSpec {
  if (chkCustomSpec.checked) {
    return { mode: "json", jsonText: specJsonEl.value || "" };
  }
  return { mode: "file", name: specSelect.value || "default_spec.json" };
}

async function populateSpecSelect() {
  const files = await otter.listSpecFiles();

  specSelect.innerHTML = "";
  for (const f of files) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = SPEC_FRIENDLY_LABELS[f] ?? f;
    specSelect.appendChild(opt);
  }

  // Default selection
  if (files.includes("default_spec.json")) {
    specSelect.value = "default_spec.json";
    activeSpecName = "default_spec.json";
  } else if (files.length) {
    specSelect.value = files[0];
    activeSpecName = files[0];
  }
}

// Events


chkCustomSpec.addEventListener("change", async () => {
  if (chkCustomSpec.checked) {
    // Enter customize mode: show textarea and seed it from selected file
    showCustomArea(true);
    try {
      await loadSelectedSpecIntoTextarea();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`\nWARN: Failed to load spec for customization: ${msg}\n`);
    }
  } else {
    // Exit customize mode: hide textarea; spec comes from dropdown
    showCustomArea(false);
  }
});

specSelect.addEventListener("change", async () => {
  if (suppressSpecChange) return;

  const newName = specSelect.value;
  const prevName = activeSpecName;

  // If customizing and edits differ, confirm overwrite
  if (chkCustomSpec.checked && hasUnsavedCustomEdits()) {
    const ok = window.confirm(
      "You have customized the JSON spec. Switching specs will overwrite your changes. Continue?"
    );

    if (!ok) {
      // revert dropdown to previous selection
      suppressSpecChange = true;
      specSelect.value = prevName;
      suppressSpecChange = false;
      return;
    }
  }

  // accept new selection
  activeSpecName = newName;

  // If customizing, reload textarea from newly selected spec file
  if (chkCustomSpec.checked) {
    try {
      await loadSelectedSpecIntoTextarea();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      appendLog(`\nWARN: Failed to load spec "${newName}": ${msg}\n`);
    }
  }
});

// Init
(async function initSpecUi() {
  await populateSpecSelect();

  // Start state: default selected, Customize unchecked, textarea hidden
  chkCustomSpec.checked = false;
  showCustomArea(false);
})();

//==============================================================================
//
// BEGIN: Editing controls (Remove / Restore / Undo / Redo / Save EDL / Load EDL / Save Edits)
//
//==============================================================================

const btnRemove = mustGetEl<HTMLButtonElement>("btnRemove");
const btnRestore = mustGetEl<HTMLButtonElement>("btnRestore");
const btnUndo = mustGetEl<HTMLButtonElement>("btnUndo");
const btnRedo = mustGetEl<HTMLButtonElement>("btnRedo");
const btnSaveEdl = mustGetEl<HTMLButtonElement>("btnSaveEdl");
const btnLoadEdl = mustGetEl<HTMLButtonElement>("btnLoadEdl");
const btnSaveEdits = mustGetEl<HTMLButtonElement>("btnSaveEdits");

//helper function for removing one breakline
function removeOneBreakline(): boolean {
  if (selectedIndices.length === 0) return false;

  const lastSelected = selectedIndices[selectedIndices.length - 1];
  const currentBreaks = words[lastSelected]?.breakAfter ?? 0;

  if (currentBreaks <= 0) return false;

  pushUndo();
  words[lastSelected].breakAfter = currentBreaks - 1;
  renderTranscript(words);
  updateEditButtonStates();
  return true;
}


/**
 * Remove (soft-delete) the currently selected words.
 *
 * Marks the selected range as "deleted" in the piece table. The words
 * remain visible with strikethrough styling so the user can restore them.
 */
function removeSelection() {
  if (!pieceTable || selectedIndices.length === 0) return;
  pushUndo();
  let changedAny = false;
  const ranges = getSelectedRanges(uniqueSortedIndices(selectedIndices));
  for (const r of ranges) {
    const changed = applyStatusToRange(pieceTable, r.start, r.end, "active", "deleted");
    if (changed) changedAny = true;
  }
  if (!changedAny) {
    // Nothing was active in that range — pop the undo we just pushed
    undoStack.pop();
    return;
  }
  renderTranscript(words);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  refreshDetailIfActive();
}

/**
 * Restore previously removed words in the current selection.
 */
function restoreSelection() {
  if (!pieceTable || selectedIndices.length === 0) return;
  pushUndo();
  let changedAny = false;
  const ranges = getSelectedRanges(uniqueSortedIndices(selectedIndices));
  for (const r of ranges) {
    const changed = applyStatusToRange(pieceTable, r.start, r.end, "deleted", "active");
    if (changed) changedAny = true;
  }
  if (!changedAny) {
    undoStack.pop();
    return;
  }
  renderTranscript(words);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  refreshDetailIfActive();
}

btnRemove.addEventListener("click", () => removeSelection());
btnRestore.addEventListener("click", () => restoreSelection());

window.addEventListener("mouseup", () => {
  isMouseSelecting = false;
});

btnUndo.addEventListener("click", () => {
  if (performUndo()) {
    renderTranscript(words);
    void refreshMainWavePreviewFromEdits();
    updateEditButtonStates();
    refreshDetailIfActive();
  }
});

btnRedo.addEventListener("click", () => {
  if (performRedo()) {
    renderTranscript(words);
    void refreshMainWavePreviewFromEdits();
    updateEditButtonStates();
    refreshDetailIfActive();
  }
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  // Don't intercept when user is typing in an input/textarea
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const isMeta = e.metaKey || e.ctrlKey;

  if (isMeta && !e.shiftKey && e.key === "z") {
    e.preventDefault();
    if (performUndo()) {
      renderTranscript(words);
      updateEditButtonStates();
      refreshDetailIfActive();
    }
    return;
  }

  if (isMeta && e.shiftKey && e.key === "z") {
    e.preventDefault();
    if (performRedo()) {
      renderTranscript(words);
      updateEditButtonStates();
      refreshDetailIfActive();
    }
    return;
  }

  if (isMeta && e.key === "y") {
    e.preventDefault();
    if (performRedo()) {
      renderTranscript(words);
      updateEditButtonStates();
      refreshDetailIfActive();
    }
    return;
  }

  if (e.key === "Backspace") {
  e.preventDefault();

  const removedBreakline = removeOneBreakline();
  if (!removedBreakline) {
    removeSelection();
  }
  return;
}

if (e.key === "Delete") {
  e.preventDefault();
  removeSelection();
  return;
}

if (e.key === "r" || e.key === "R") {
  restoreSelection();
  return;
}

if (e.key === "Enter") {
  e.preventDefault();

  if (selectedIndices.length > 0) {
    const lastSelected = selectedIndices[selectedIndices.length - 1];
    pushUndo();
    words[lastSelected].breakAfter = (words[lastSelected].breakAfter ?? 0) + 1;
    renderTranscript(words);
    updateEditButtonStates();
  }
  return;
}
});

btnSaveEdl.addEventListener("click", async () => {
  if (!pieceTable) return;

  try {
    syncBreakAfterToPieceTable();
    const payload = { version: 2, pieceTable };
    const json = JSON.stringify(payload, null, 2);
    const savedPath = await otter.saveEdl(json);
    if (savedPath) {
      const fname = savedPath.split("/").pop() ?? savedPath;
      setStatus(`EDL saved: ${fname}`, "success");
      appendLog(`EDL saved to ${savedPath}\n`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Failed to save EDL.", "error");
    appendLog("\nERROR saving EDL:\n" + msg + "\n");
  }
});

btnLoadEdl.addEventListener("click", async () => {
  try {
    resetEditedPreviewState();
    const result = await otter.loadEdl();
    if (!result) return;

    const parsed = JSON.parse(result.content);

    if (isEdlV2(parsed)) {
      pieceTable = parsed.pieceTable;
    } else if (isEdlV1(parsed)) {
      pieceTable = convertV1ToV2(parsed);
    } else {
      setStatus("Invalid EDL file.", "error");
      appendLog("\nERROR: file is not a valid OTTER EDL.\n");
      return;
    }

    undoStack = [];
    redoStack = [];
    audioPath = pieceTable.sourceFile;

    const viewEntries = getViewEntries(pieceTable);
    words = viewEntries.map(ve => ({
      word: ve.entry.word,
      start: ve.entry.sourceStart,
      end: ve.entry.sourceEnd,
      breakAfter: ve.entry.breakAfter,
    }));

    // Load the source audio waveform
    const ab = await otter.readFileAsArrayBuffer(audioPath);
    const blob = new Blob([ab]);
    await ws.loadBlob(blob);

    // Update UI state
    const fname = audioPath.split("/").pop() ?? audioPath;
    fnameEl.textContent = shortenFilenameMiddle(fname);
    setStatus(`EDL loaded (${viewEntries.length} entries)`, "success");
    appendLog(`EDL loaded from ${result.path}\n`);

    btnPlay.disabled = false;
    btnTranscribe.disabled = false;
    updateEditButtonStates();
    renderTranscript(words);
    updateDeletedRegions();
    refreshDetailIfActive();
    await refreshMainWavePreviewFromEdits();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Failed to load EDL.", "error");
    appendLog("\nERROR loading EDL:\n" + msg + "\n");
  }
});

btnSaveEdits.addEventListener("click", async () => {
  if (!pieceTable) return;

  const activeEntries = getActiveEntries(pieceTable);
  if (activeEntries.length === 0) {
    setStatus("Nothing to export (all words removed).", "error");
    return;
  }

  try {
    setStatus("Exporting audio…", "working");

    const exportPayload = {
      version: 1,
      sourceFile: pieceTable.sourceFile,
      entries: activeEntries.map(ve => ({
        id: ve.entry.id,
        sourceStart: ve.entry.sourceStart,
        sourceEnd: ve.entry.sourceEnd,
        label: ve.entry.word,
        muted: false,
      })),
      createdAt: pieceTable.createdAt,
      modifiedAt: pieceTable.modifiedAt,
    };

    const json = JSON.stringify(exportPayload, null, 2);
    const outPath = await otter.exportEdlAudio(json);
    if (outPath) {
      const fname = outPath.split("/").pop() ?? outPath;
      setStatus(`Exported: ${fname}`, "success");
      appendLog(`Audio exported to ${outPath}\n`);
    } else {
      setStatus("Export canceled.", "info");
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Export failed.", "error");
    appendLog("\nERROR exporting audio:\n" + msg + "\n");
  }
});


export {};

//
// Initialization
//

//
// Set initial state
//

setDetailPlayIcon(false);
btnDetailPlay.disabled = true;
btnRegion.disabled = true;
updateEditButtonStates();
const WORD_REGION_COLOR = getCssVar(
  waveDetailPane,
  "--word-region-color",
  "rgba(255, 200, 0, 0.35)"
);

// Initialize drag selection global mouseup handler
initializeDragEnd();
