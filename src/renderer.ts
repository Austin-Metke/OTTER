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

/** Returned when the user stops transcription or the engine reports cancellation. */
type TranscribeCancelled = { cancelled: true };

type TranscribeAudioResult = TranscriptResult | TranscribeCancelled;

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
  sourceFile?: string;
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
  sourceFile?: string;
};

type OtterApi = {
  chooseAudioFile: () => Promise<string | null>;
  transcribeAudio: (audioPath: string, spec?: TranscribeSpec) => Promise<TranscribeAudioResult>;
  onTranscribeLog: (cb: (msg: string) => void) => void;
  probeAudio: (audioPath: string) => Promise<{ start_time: number; sample_rate: number | null }>;
  onTranscribeProgress: (cb: (pct: number) => void) => void;
  makeSnippet: (audioPath: string, startSec: number, durSec: number) => Promise<string>;
  audioSection:(audioPath: string,viewportStart: number, viewportEnd: number) => Promise<ArrayBuffer>;
  readFileAsArrayBuffer: (filePath: string) => Promise<ArrayBuffer>;
  listSpecFiles: () => Promise<string[]>;
  readSpecFile: (name: string) => Promise<string>;
  readDefaultSpec: () => Promise<string>;
  saveEdl: (edlJson: string) => Promise<string | null>;
  loadEdl: () => Promise<{ path: string; content: string } | null>;
  exportEdlAudio: (edlJson: string) => Promise<string | null>;
  renderEditedPreview: (edlJson: string) => Promise<string>;
  saveMicRecording: (data: ArrayBuffer, mimeType: string) => Promise<string>;
  saveMicRecordingAs: (data: ArrayBuffer, mimeType: string) => Promise<string | null>;
  pauseTranscription: () => Promise<{ok: boolean}>;
  resumeTranscription: () => Promise<{ok: boolean}>;
  cancelTranscription: () => Promise<{ok:boolean}>;
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

// Always-available diagnostics pane (so early crashes still show details).
function ensureDiagPane(): HTMLPreElement {
  let pre = document.getElementById("otterDiag") as HTMLPreElement | null;
  if (pre) return pre;
  pre = document.createElement("pre");
  pre.id = "otterDiag";
  pre.style.position = "fixed";
  pre.style.left = "10px";
  pre.style.right = "10px";
  pre.style.bottom = "10px";
  pre.style.maxHeight = "40vh";
  pre.style.overflow = "auto";
  pre.style.margin = "0";
  pre.style.padding = "10px";
  pre.style.border = "1px solid #ef4444";
  pre.style.borderRadius = "8px";
  pre.style.background = "#0b0b0b";
  pre.style.color = "#e8e8e8";
  pre.style.fontSize = "12px";
  pre.style.lineHeight = "1.35";
  pre.style.whiteSpace = "pre-wrap";
  pre.style.zIndex = "9999";
  pre.hidden = true;
  document.body.appendChild(pre);
  return pre;
}

function diag(msg: string) {
  const pre = ensureDiagPane();
  pre.hidden = false;
  pre.textContent += msg;
  pre.scrollTop = pre.scrollHeight;
}

if (!otter) {
  const s = document.getElementById("status");
  if (s) {
    s.textContent = "Bridge API (window.otter) is missing. UI cannot function.";
    s.className = "error";
    (s as HTMLElement).style.display = "inline-block";
  }
  diag("\nFATAL: window.otter is missing (preload bridge not available)\n");
  // Do not throw here; we want the diagnostics pane to remain visible.
}

// Surface runtime errors into the in-app log/status (Electron users may not have devtools open).
const earlyLogBuffer: string[] = [];

function bufferOrLog(msg: string) {
  const logger = (window as any).__otterAppendLog as ((m: string) => void) | undefined;
  if (logger) logger(msg);
  else earlyLogBuffer.push(msg);
  diag(msg);
}

function openDevPanelIfPresent() {
  const devPanel = document.getElementById("devPanel") as HTMLDetailsElement | null;
  if (devPanel) devPanel.open = true;
}

window.addEventListener("error", (ev) => {
  try {
    const msg = (ev as ErrorEvent).error instanceof Error
      ? (ev as ErrorEvent).error.stack || (ev as ErrorEvent).error.message
      : (ev as ErrorEvent).message || String(ev);
    const safe = msg || "Unknown error";
    bufferOrLog(`\nRUNTIME ERROR:\n${safe}\n`);
    openDevPanelIfPresent();
    const statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent = "UI error (see log).";
      statusEl.className = "error";
      (statusEl as HTMLElement).style.display = "inline-block";
    }
  } catch {
    // ignore
  }
});

window.addEventListener("unhandledrejection", (ev) => {
  try {
    const reason = (ev as PromiseRejectionEvent).reason;
    const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    bufferOrLog(`\nUNHANDLED REJECTION:\n${msg}\n`);
    openDevPanelIfPresent();
  } catch {
    // ignore
  }
});

type EditorKind = "imported" | "pending-import" | "recorded";
type InteractionMode = "select" | "move";

type EditorState = {
  kind: EditorKind;
  paneEl: HTMLDivElement;
  audioPath: string | null;
  words: TranscriptWord[];
  pieceTable: PieceTableData | null;
  undoStack: UndoSnapshot[];
  redoStack: UndoSnapshot[];
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionAnchor: number | null;
  selectedIndices: number[];
  interactionMode: InteractionMode;
};

let importedEditor: EditorState; //final/main transcript
let pendingImportEditor: EditorState;// imported staging
let recordedEditor: EditorState;// recorded staging
let activeEditor: EditorState;
let playheadIndex = -1;
let isDragging = false;

/**
 * Undo/redo snapshot for a single transcript editor pane.
 *
 * What we snapshot:
 * - **Transcript content state**: piece-table buffers + pieces (when present) and `editor.words`.
 * - **Audio association**: `audioPath` (used to rehydrate waveforms / source file mapping).
 * - **Optional side snapshots**: during "append to main", we also capture the source pane so
 *   a single undo step can restore the cleared pane (transcript + waveform).
 *
 * What we intentionally do NOT snapshot:
 * - WaveSurfer internal playback state (playhead time, zoom, etc.). Those are derived from
 *   `audioPath` + transcript and are reloaded by UI code after undo/redo.
 * - UI-only DOM state (highlight spans, drop indicators). Those are regenerated on render.
 */
type UndoSnapshot =
  | {
      kind: "empty";
      audioPath: string | null;
      words: TranscriptWord[];
      side?: Partial<Record<EditorKind, UndoSnapshot>>;
    }
  | {
      kind: "pt";
      audioPath: string | null;
      pieces: Piece[];
      originalBuffer: PieceEntry[];
      addBuffer: PieceEntry[];
      ptSourceFile: string;
      ptCreatedAt: string;
      ptModifiedAt: string;
      words: TranscriptWord[];
      side?: Partial<Record<EditorKind, UndoSnapshot>>;
    };

let detailSelStart: number | null = null;
let detailSelEnd: number | null = null;
let detailEditor: EditorState | null = null;
let isMouseSelecting = false;
let mouseSelectionMoved = false;
let dragMoveSourceIndices: number[] = [];
let dragMoveEditorKind: EditorKind | null = null;
let isEditedPreviewMode = false;
let previewWordTimes: Array<{ start: number; end: number }> = [];
let previewRefreshToken = 0;
// Used to gate UI behaviors / debugging; kept for future progress UI.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
let isRefreshingPreview = false;

function setActiveEditor(next: EditorState) {
  activeEditor = next;
  transcriptImportedEl.classList.toggle("isActive", activeEditor.kind === "imported");
  transcriptPendingImportedEl.classList.toggle("isActive", activeEditor.kind === "pending-import");
  transcriptRecordedEl.classList.toggle("isActive", activeEditor.kind === "recorded");
  updateEditButtonStates();
}

// The most recently chosen audio file to transcribe (import flow).
let pendingImportAudioPath: string | null = null;

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

function snapshotState(editor: EditorState): UndoSnapshot {
  if (!editor.pieceTable) {
    return {
      kind: "empty",
      audioPath: editor.audioPath,
      words: editor.words.map(w => ({ ...w })),
    };
  }
  const pt = editor.pieceTable;
  return {
    kind: "pt",
    audioPath: editor.audioPath,
    pieces: pt.pieces.map(p => ({ ...p })),
    originalBuffer: pt.originalBuffer.map(e => ({ ...e })),
    addBuffer: pt.addBuffer.map(e => ({ ...e })),
    ptSourceFile: pt.sourceFile,
    ptCreatedAt: pt.createdAt,
    ptModifiedAt: pt.modifiedAt,
    words: editor.words.map(w => ({ ...w })),
  };
}

function pushUndo(editor: EditorState): void {
  if (!editor.pieceTable) return;
  editor.undoStack.push(snapshotState(editor));
  editor.redoStack = [];
}

function restoreSnapshot(editor: EditorState, snap: UndoSnapshot): void {
  editor.audioPath = snap.audioPath ?? null;
  editor.words = snap.words.map(w => ({ ...w }));
  if (snap.kind === "empty") {
    editor.pieceTable = null;
    editor.selectedIndices = [];
    editor.selectionAnchor = null;
    editor.selectionStart = null;
    editor.selectionEnd = null;
    return;
  }

  editor.pieceTable = {
    pieces: snap.pieces.map(p => ({ ...p })),
    originalBuffer: snap.originalBuffer.map(e => ({ ...e })),
    addBuffer: snap.addBuffer.map(e => ({ ...e })),
    sourceFile: snap.ptSourceFile,
    createdAt: snap.ptCreatedAt,
    modifiedAt: new Date().toISOString(),
  };
}

function performUndo(editor: EditorState): boolean {
  if (editor.undoStack.length === 0) return false;
  const snap = editor.undoStack.pop()!;
  const redoSnap = snapshotState(editor);
  if (snap.side) {
    redoSnap.side = {};
    for (const k of Object.keys(snap.side) as EditorKind[]) {
      const kindSnap = snap.side[k];
      if (!kindSnap) continue;
      if (k === "pending-import") redoSnap.side[k] = snapshotState(pendingImportEditor);
      if (k === "recorded") redoSnap.side[k] = snapshotState(recordedEditor);
      if (k === "imported") redoSnap.side[k] = snapshotState(importedEditor);
    }
  }
  editor.redoStack.push(redoSnap);
  restoreSnapshot(editor, snap);
  if (snap.side?.["pending-import"]) restoreSnapshot(pendingImportEditor, snap.side["pending-import"]);
  if (snap.side?.recorded) restoreSnapshot(recordedEditor, snap.side.recorded);
  return true;
}

function performRedo(editor: EditorState): boolean {
  if (editor.redoStack.length === 0) return false;
  const snap = editor.redoStack.pop()!;
  const undoSnap = snapshotState(editor);
  if (snap.side) {
    undoSnap.side = {};
    for (const k of Object.keys(snap.side) as EditorKind[]) {
      const kindSnap = snap.side[k];
      if (!kindSnap) continue;
      if (k === "pending-import") undoSnap.side[k] = snapshotState(pendingImportEditor);
      if (k === "recorded") undoSnap.side[k] = snapshotState(recordedEditor);
      if (k === "imported") undoSnap.side[k] = snapshotState(importedEditor);
    }
  }
  editor.undoStack.push(undoSnap);
  restoreSnapshot(editor, snap);
  if (snap.side?.["pending-import"]) restoreSnapshot(pendingImportEditor, snap.side["pending-import"]);
  if (snap.side?.recorded) restoreSnapshot(recordedEditor, snap.side.recorded);
  return true;
}

function syncBreakAfterToPieceTable(editor: EditorState): void {
  if (!editor.pieceTable) return;
  const viewEntries = getViewEntries(editor.pieceTable);
  for (let i = 0; i < viewEntries.length && i < editor.words.length; i++) {
    viewEntries[i].entry.breakAfter = editor.words[i].breakAfter;
  }
}

function syncWordsFromPieceTable(editor: EditorState): void {
  if (!editor.pieceTable) return;

  const oldWords = editor.words;
  const viewEntries = getViewEntries(editor.pieceTable);

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

  editor.words = newWords;
}

async function refreshDetailIfActive(): Promise<void> {
  if (!detailEditor) return;
  const currentDetailEditor = detailEditor;
  if (detailSelStart == null || detailSelEnd == null) return;
  if (detailSelStart >= currentDetailEditor.words.length) { detailSelStart = null; detailSelEnd = null; detailEditor = null; return; }
  const endIdx2 = Math.min(detailSelEnd, currentDetailEditor.words.length - 1);
  const viewEntries = currentDetailEditor.pieceTable ? getViewEntries(currentDetailEditor.pieceTable) : [];
  const rangeEntries = viewEntries.slice(detailSelStart, endIdx2 + 1);
  const rangeSourceFile = rangeEntries[0]?.entry.sourceFile || currentDetailEditor.audioPath;
  if (!rangeSourceFile) return;
  const mixedSources = rangeEntries.some((ve) => (ve.entry.sourceFile || currentDetailEditor.audioPath) !== rangeSourceFile);
  if (mixedSources) return;
  const rangeStart = Number(currentDetailEditor.words[detailSelStart].start);
  const rangeEnd = Number(currentDetailEditor.words[endIdx2].end);
  try {
    await loadDetailForRange(rangeSourceFile, rangeStart, rangeEnd);
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
  const hasSel = activeEditor.selectedIndices.length > 0;
  const hasAnyTranscript = importedEditor.pieceTable != null || pendingImportEditor.pieceTable != null || recordedEditor.pieceTable != null;
  const hasMainTranscript = importedEditor.pieceTable != null;
  const hasPt = activeEditor.pieceTable != null;

  btnRemove.disabled = !hasPt || !hasSel;
  btnRestore.disabled = !hasPt || !hasSel;
  btnUndo.disabled = activeEditor.undoStack.length === 0;
  btnRedo.disabled = activeEditor.redoStack.length === 0;
  btnSaveEdl.disabled = !hasAnyTranscript;
  btnSaveEdits.disabled = !hasMainTranscript;

  btnAddImportedToTranscript.disabled = pendingImportEditor.pieceTable == null || pendingImportEditor.words.length === 0;
  btnAddRecordedToTranscript.disabled = recordedEditor.pieceTable == null || recordedEditor.words.length === 0;
}

/**
 * Write the detail-region's current bounds back to the corresponding
 * piece table entry (and the parallel words[] array) so that boundary
 * adjustments are persisted.
 */
function writebackRegionBounds() {
  if (!detailEditor?.pieceTable || !detailRegion || !detailEditor.words || detailSelStart == null) return;

  const absStart = detailWinStartAbs + detailRegion.start;
  const absEnd = detailWinStartAbs + detailRegion.end;
  const viewEntries = getViewEntries(detailEditor.pieceTable);

  if (detailSelStart === detailSelEnd) {
    const ve = viewEntries[detailSelStart];
    if (ve) {
      ve.entry.sourceStart = absStart;
      ve.entry.sourceEnd = absEnd;
      detailEditor.words[detailSelStart].start = absStart;
      detailEditor.words[detailSelStart].end = absEnd;
    }
  } else if (detailSelEnd != null) {
    const veStart = viewEntries[detailSelStart];
    const veEnd = viewEntries[detailSelEnd];
    if (veStart) {
      veStart.entry.sourceStart = absStart;
      detailEditor.words[detailSelStart].start = absStart;
    }
    if (veEnd) {
      veEnd.entry.sourceEnd = absEnd;
      detailEditor.words[detailSelEnd].end = absEnd;
    }
  }

  detailEditor.pieceTable.modifiedAt = new Date().toISOString();
}


const DELETED_REGION_COLOR = "rgba(180, 180, 180, 0.45)";

/**
 * Sync gray overlay regions on the main waveform with the piece table's
 * deleted entries. Called after every edit so the waveform visually
 * reflects which segments have been removed.
 */
function updateDeletedRegions() {
  mainRegions.clearRegions();
  if (!importedEditor.pieceTable) return;

  const viewEntries = getViewEntries(importedEditor.pieceTable);
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

const transcriptImportedEl = mustGetEl<HTMLDivElement>("transcriptImported");
const transcriptPendingImportedEl = mustGetEl<HTMLDivElement>("transcriptPendingImported");
const transcriptRecordedEl = mustGetEl<HTMLDivElement>("transcriptRecorded");
// Back-compat for existing transcript logic; will be extended to support both panes.
const transcriptEl = transcriptImportedEl;
const btnChoose = mustGetEl<HTMLButtonElement>("btnChoose");
const btnTranscribe = mustGetEl<HTMLButtonElement>("btnTranscribe");
const btnPause = mustGetEl<HTMLButtonElement>("btnPause");
const btnStop = mustGetEl<HTMLButtonElement>("btnStop");
const micSelect = mustGetEl<HTMLSelectElement>("micSelect");
const btnRefreshMics = mustGetEl<HTMLButtonElement>("btnRefreshMics");
const btnRecord = mustGetEl<HTMLButtonElement>("btnRecord");
const btnRecordPause = mustGetEl<HTMLButtonElement>("btnRecordPause");
const btnRecordStop = mustGetEl<HTMLButtonElement>("btnRecordStop");
const btnAddImportedToTranscript = mustGetEl<HTMLButtonElement>("btnAddImportedToTranscript");
const btnAddRecordedToTranscript = mustGetEl<HTMLButtonElement>("btnAddRecordedToTranscript");
const btnImportedSelectMode = mustGetEl<HTMLButtonElement>("btnImportedSelectMode");
const btnImportedMoveMode = mustGetEl<HTMLButtonElement>("btnImportedMoveMode");
const btnPendingImportSelectMode = mustGetEl<HTMLButtonElement>("btnPendingImportSelectMode");
const btnPendingImportMoveMode = mustGetEl<HTMLButtonElement>("btnPendingImportMoveMode");
const btnRecordedSelectMode = mustGetEl<HTMLButtonElement>("btnRecordedSelectMode");
const btnRecordedMoveMode = mustGetEl<HTMLButtonElement>("btnRecordedMoveMode");
const statusEl = mustGetEl<HTMLDivElement>("status");

importedEditor = {
  kind: "imported",
  paneEl: transcriptImportedEl,
  audioPath: null,
  words: [],
  pieceTable: null,
  undoStack: [],
  redoStack: [],
  selectionStart: null,
  selectionEnd: null,
  selectionAnchor: null,
  selectedIndices: [],
  interactionMode: "select",
};

pendingImportEditor = {
  kind: "pending-import",
  paneEl: transcriptPendingImportedEl,
  audioPath: null,
  words: [],
  pieceTable: null,
  undoStack: [],
  redoStack: [],
  selectionStart: null,
  selectionEnd: null,
  selectionAnchor: null,
  selectedIndices: [],
  interactionMode: "select",
};

recordedEditor = {
  kind: "recorded",
  paneEl: transcriptRecordedEl,
  audioPath: null,
  words: [],
  pieceTable: null,
  undoStack: [],
  redoStack: [],
  selectionStart: null,
  selectionEnd: null,
  selectionAnchor: null,
  selectedIndices: [],
  interactionMode: "select",
};

activeEditor = importedEditor;
// NOTE: don't call setActiveEditor() yet; it touches edit buttons that are declared later.

function attachTranscriptPaneDnD(pane: HTMLDivElement, editor: EditorState) {
  /**
   * Attach pane-level behavior for a transcript editor.
   *
   * Responsibilities:
   * - **Focus/activation**: clicking in the pane (including empty space) sets the active editor.
   * - **Move-mode drop target**: when in Move Words mode, allow dropping a dragged selection
   *   into whitespace to append at end.
   *
   * Deliberate boundaries:
   * - Word-level interactions (select, drag-select, seek, etc.) are handled in `renderTranscript()`.
   * - We ignore clicks on nested interactive elements to avoid stealing focus from controls.
   */
  pane.addEventListener("mousedown", (event: MouseEvent) => {
    // Ignore clicks on interactive controls nested inside the pane (if any)
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest("button, a, input, textarea, select")) return;
    setActiveEditor(editor);
  });

  pane.addEventListener("dragover", (event: DragEvent) => {
    if (editor.interactionMode !== "move") return;
    if (dragMoveSourceIndices.length === 0) return;
    if (dragMoveEditorKind !== editor.kind) return;
    if ((event.target as HTMLElement).closest(".word")) return;
    event.preventDefault();
    setActiveEditor(editor);
    clearDropIndicators();
  });

  pane.addEventListener("drop", (event: DragEvent) => {
    if (editor.interactionMode !== "move") return;
    if (dragMoveSourceIndices.length === 0) return;
    if (dragMoveEditorKind !== editor.kind) return;
    if ((event.target as HTMLElement).closest(".word")) return;
    event.preventDefault();
    setActiveEditor(editor);
    clearDropIndicators();
    moveCurrentSelection(editor, editor.words.length);
    dragMoveSourceIndices = [];
    dragMoveEditorKind = null;
    pane.classList.remove("dragging-words");
  });
}

attachTranscriptPaneDnD(transcriptImportedEl, importedEditor);
attachTranscriptPaneDnD(transcriptPendingImportedEl, pendingImportEditor);
attachTranscriptPaneDnD(transcriptRecordedEl, recordedEditor);

function updateInteractionModeButtons() {
  const buttonPairs = [
    { editor: importedEditor, selectBtn: btnImportedSelectMode, moveBtn: btnImportedMoveMode },
    { editor: pendingImportEditor, selectBtn: btnPendingImportSelectMode, moveBtn: btnPendingImportMoveMode },
    { editor: recordedEditor, selectBtn: btnRecordedSelectMode, moveBtn: btnRecordedMoveMode },
  ];

  for (const { editor, selectBtn, moveBtn } of buttonPairs) {
    const selectActive = editor.interactionMode === "select";
    selectBtn.classList.toggle("isActive", selectActive);
    moveBtn.classList.toggle("isActive", !selectActive);
    selectBtn.setAttribute("aria-pressed", String(selectActive));
    moveBtn.setAttribute("aria-pressed", String(!selectActive));
    editor.paneEl.classList.toggle("moveMode", editor.interactionMode === "move");
  }
}

function setInteractionMode(editor: EditorState, nextMode: InteractionMode) {
  if (editor.interactionMode === nextMode) return;
  editor.interactionMode = nextMode;

  if (nextMode === "select") {
    isDragging = false;
    dragMoveSourceIndices = [];
    dragMoveEditorKind = null;
    clearDropIndicators();
    editor.paneEl.classList.remove("dragging-words");
  } else {
    isMouseSelecting = false;
    mouseSelectionMoved = false;
  }

  updateInteractionModeButtons();
  renderTranscript(editor);
}

btnImportedSelectMode.addEventListener("click", () => setInteractionMode(importedEditor, "select"));
btnImportedMoveMode.addEventListener("click", () => setInteractionMode(importedEditor, "move"));
btnPendingImportSelectMode.addEventListener("click", () => setInteractionMode(pendingImportEditor, "select"));
btnPendingImportMoveMode.addEventListener("click", () => setInteractionMode(pendingImportEditor, "move"));
btnRecordedSelectMode.addEventListener("click", () => setInteractionMode(recordedEditor, "select"));
btnRecordedMoveMode.addEventListener("click", () => setInteractionMode(recordedEditor, "move"));
updateInteractionModeButtons();

let isPaused = false;
let copiedSelectionEntries: PieceEntry[] = [];

function setTranscribingState(active: boolean) {
  btnTranscribe.hidden = active;
  btnPause.hidden = !active;
  btnStop.hidden = !active;
  if (!active) {
    isPaused = false;
    btnPause.textContent = "⏸ Pause";
  }
}

function setRecordedTranscribingState(active: boolean) {
  btnTranscribeRecorded.hidden = active;
  btnStopRecorded.hidden = !active;
}

function resetEditorState(editor: EditorState) {
  editor.audioPath = null;
  editor.words = [];
  editor.pieceTable = null;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.selectedIndices = [];
  editor.selectionAnchor = null;
  editor.selectionStart = null;
  editor.selectionEnd = null;
}

/**
 * Clear the "Imported Transcript" (pending-import) pane and its waveform.
 *
 * This is used when:
 * - The user chooses a new file (staging should reset), or
 * - The user appends the staged transcript into the main transcript.
 *
 * Invariants after this returns:
 * - `pendingImportEditor` has no audioPath, words, pieceTable, or undo history.
 * - Imported waveform pane is hidden and playback controls are disabled.
 */
function clearPendingImportedView() {
  resetEditorState(pendingImportEditor);
  transcriptPendingImportedEl.innerHTML = "";
  importedWavePane.hidden = true;
  importedWaveDivider.hidden = true;
  btnImportedPlay.disabled = true;
  importedLoadedFileEl.textContent = "No imported audio staged";
  importedTimeEl.textContent = "0.00";
  if (typeof wsImported.empty === "function") wsImported.empty();
  setImportedPlayIcon(false);
}

/**
 * Clear the "Recorded Transcript" pane and its waveform.
 *
 * This is used after successfully appending the recorded transcript into main,
 * or when resetting the recorded state due to workflow changes.
 *
 * Invariants after this returns:
 * - `recordedEditor` has no audioPath, words, pieceTable, or undo history.
 * - Recorded waveform pane is hidden and playback/transcribe controls are disabled.
 */
function clearRecordedView() {
  resetEditorState(recordedEditor);
  transcriptRecordedEl.innerHTML = "";
  recordedWavePane.hidden = true;
  recordedWaveDivider.hidden = true;
  btnRecordedPlay.disabled = true;
  btnTranscribeRecorded.disabled = true;
  btnStopRecorded.hidden = true;
  recordedTimeEl.textContent = "0.00";
  if (typeof wsRecorded.empty === "function") wsRecorded.empty();
  setRecordedPlayIcon(false);
}

// ---------------------------------------------------------------------------
// Mic recording (MediaRecorder) state
// ---------------------------------------------------------------------------

let micStream: MediaStream | null = null;
let micRecorder: MediaRecorder | null = null;
let micChunks: Blob[] = [];
let micRecordingStartedAt = 0;

function setRecordingState(active: boolean) {
  btnRecord.hidden = active;
  btnRecordPause.hidden = !active;
  btnRecordStop.hidden = !active;
  micSelect.disabled = active;
  btnRefreshMics.disabled = active;
}

/**
 * List audio input devices. Labels are empty until the user has granted microphone
 * permission at least once in this session; use ensureMicPermissionForLabels() first.
 */
async function refreshMicDeviceList(): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const previous = micSelect.value;

  micSelect.innerHTML = "";
  const defaultOpt = document.createElement("option");
  defaultOpt.value = "";
  defaultOpt.textContent = "Default (system)";
  micSelect.appendChild(defaultOpt);

  inputs.forEach((d, i) => {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label?.trim() || `Microphone ${i + 1}`;
    micSelect.appendChild(opt);
  });

  const stillValid =
    previous === "" || Array.from(micSelect.options).some((o) => o.value === previous);
  micSelect.value = stillValid ? previous : "";
}

/**
 * Request transient mic access so enumerateDevices() can return real device labels.
 */
async function ensureMicPermissionForLabels(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    // User denied or no device — list may still work with generic names
  }
}

async function initMicDeviceList(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((d) => d.kind === "audioinput");
    const needLabels = inputs.length > 0 && inputs.every((d) => !d.label);
    if (needLabels) {
      await ensureMicPermissionForLabels();
    }
    await refreshMicDeviceList();
  } catch (e) {
    console.warn("Mic device list failed:", e);
  }
}

btnRefreshMics.addEventListener("click", async () => {
  await ensureMicPermissionForLabels();
  await refreshMicDeviceList();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshMicDeviceList();
  });
}

void initMicDeviceList();

async function stopMicIfActive() {
  try {
    micRecorder?.stop();
  } catch {
    // ignore
  }
  micRecorder = null;

  try {
    micStream?.getTracks().forEach((t) => t.stop());
  } catch {
    // ignore
  }
  micStream = null;
}

function normalizeRange(a: number, b: number) {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

const findBar = document.getElementById("searchBar")!;
const findInput = document.getElementById("searchInput") as HTMLInputElement;
const findClose = document.getElementById("findClose")!;
findBar.hidden = true;

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

    if (searchQuery !== lastSearchQuery) {
        lastFoundIndex = -1;
        lastSearchQuery = searchQuery;
      }
    let found = false;
    for(let i = lastFoundIndex + 1; i < activeEditor.words.length; i++)
    {
      if(activeEditor.words[i].word.toLowerCase().includes(searchQuery))
      {
        lastFoundIndex=  i;
        found = true;
        lastSearchQuery = searchQuery;
      const wordFound = activeEditor.words[i];
      setSelectionRange(activeEditor, i, i);
      if (activeEditor.kind === "imported") ws.setTime(Number(wordFound.start) + SEEK_EPS);

      const wordElement = activeEditor.paneEl.querySelector(
      `.word[data-index="${i}"]`
      ) as HTMLElement | null;

      wordElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      break;
    }

    }

   if(!found)
    {
      for(let i = 0; i < lastFoundIndex; i++)
      {
        if(activeEditor.words[i].word.toLowerCase().includes(searchQuery))
        {
          lastFoundIndex = i;
            lastSearchQuery = searchQuery;
      const wordFound = activeEditor.words[i];
      setSelectionRange(activeEditor, i, i);
      if (activeEditor.kind === "imported") ws.setTime(Number(wordFound.start) + SEEK_EPS);

      const wordElement = activeEditor.paneEl.querySelector(
      `.word[data-index="${i}"]`
      ) as HTMLElement | null;

      wordElement?.scrollIntoView({ block: "center", behavior: "smooth" });
      break;
        }
      }
    }

  });

function clearSearchHighlights() {
  const transcriptWords = activeEditor.paneEl.querySelectorAll(".word");

  transcriptWords.forEach((node)=> {
    const wordElement = node as HTMLElement;
    const index = Number(wordElement.dataset.index);
    const wordText = activeEditor.words[index]?.word ?? "";
    renderHighlightedWord(wordElement, wordText, "");
  });
}

findInput.addEventListener("input", () => {
  const searchQuery = findInput.value.trim().toLowerCase();
  const transcriptWords = activeEditor.paneEl.querySelectorAll(".word");

  transcriptWords.forEach((node)=> {
    const wordElement = node as HTMLElement;
    const index = Number(wordElement.dataset.index);
    const wordText = activeEditor.words[index]?.word ?? "";

    renderHighlightedWord(wordElement, wordText, searchQuery);
  });
});
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

function setSelectedIndices(editor: EditorState, indices: number[], anchor: number | null = editor.selectionAnchor) {
  const next = uniqueSortedIndices(indices).filter((idx) => idx >= 0 && idx < editor.words.length);
  editor.selectedIndices = next;
  editor.selectionAnchor = anchor;

  if (next.length > 0 && isContiguousSelection(next)) {
    editor.selectionStart = next[0];
    editor.selectionEnd = next[next.length - 1];
  } else {
    editor.selectionStart = null;
    editor.selectionEnd = null;
  }

  const selectedSet = new Set(next);
  const nodes = editor.paneEl.querySelectorAll<HTMLElement>(".word");
  nodes.forEach((el) => {
    const idx = Number(el.dataset.index);
    el.classList.toggle("selected", selectedSet.has(idx));
  });

  updateEditButtonStates();
}

function clearDropIndicators() {
  const nodes = document.querySelectorAll<HTMLElement>(".word.drop-before, .word.drop-after");
  nodes.forEach((n) => {
    n.classList.remove("drop-before");
    n.classList.remove("drop-after");
  });
}

function moveCurrentSelection(editor: EditorState, toIndex: number) {
  if (!editor.pieceTable || editor.selectedIndices.length === 0) return;

  const sorted = uniqueSortedIndices(editor.selectedIndices);
  const selectedCount = sorted.length;
  const selectedBefore = sorted.filter((idx) => idx < toIndex).length;
  const insertAt = toIndex - selectedBefore;

  pushUndo(editor);

  let changed = false;
  if (sorted.length === 1 && toIndex < editor.words.length) {
    changed = moveWord(editor.pieceTable, sorted[0], toIndex);
  } else if (isContiguousSelection(sorted)) {
    changed = moveRange(editor.pieceTable, sorted[0], sorted[sorted.length - 1], toIndex);
  } else {
    changed = moveSelectedIndices(editor.pieceTable, sorted, toIndex);
  }

  if (!changed) {
    editor.undoStack.pop();
    return;
  }

  syncWordsFromPieceTable(editor);

  const movedSelection: number[] = [];
  for (let i = 0; i < selectedCount; i++) {
    movedSelection.push(insertAt + i);
  }

  setSelectedIndices(editor, movedSelection, movedSelection.length > 0 ? movedSelection[0] : null);

  if (editor.kind === "imported" && movedSelection.length === 1) {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[0];
    detailEditor = editor;
  } else if (editor.kind === "imported" && isContiguousSelection(movedSelection)) {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[movedSelection.length - 1];
    detailEditor = editor;
  } else if (editor.kind === "imported") {
    detailSelStart = movedSelection[0];
    detailSelEnd = movedSelection[0];
    detailEditor = editor;
  }

  renderTranscript(editor);
  void refreshMainWavePreviewFromEdits();
  if (editor.kind === "imported") refreshDetailIfActive();
}

function resetEditedPreviewState() {
  isEditedPreviewMode = false;
  previewWordTimes = [];
}

function clearMainWave() {
  if (ws.isPlaying()) ws.pause();
  if (typeof ws.empty === "function") ws.empty();
  btnPlay.disabled = true;
  fnameEl.textContent = "No file loaded";
  setPlayIcon(false);
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

/**
 * Load the main WaveSurfer instance from a file path.
 *
 * This is used for:
 * - Loading the original source audio (when a project/main transcript is present)
 * - Loading a rendered "edited preview" WAV produced from the current main transcript edits
 *
 * Side effects:
 * - Pauses any current playback before loading.
 * - Enables/disables the main play control based on load completion.
 */
async function loadMainWaveFromPath(filePath: string) {
  btnPlay.disabled = true;
  if (ws.isPlaying()) ws.pause();
  const ab = await otter.readFileAsArrayBuffer(filePath);
  const blob = new Blob([ab]);
  await ws.loadBlob(blob);
  btnPlay.disabled = false;
  setPlayIcon(false);
}

/**
 * Refresh the main waveform to reflect the edited transcript (main/imported editor).
 *
 * The main transcript (`importedEditor`) is the source of truth for "what plays" in the
 * primary waveform. We derive a lightweight EDL-like payload from the piece table's
 * **active** entries, ask the backend to render a temporary WAV preview, then load it
 * into WaveSurfer.
 *
 * Concurrency:
 * - Uses `previewRefreshToken` to make refreshes "last-write-wins" so rapid edits don't
 *   flicker or race.
 *
 * Derived state:
 * - Updates `previewWordTimes` so transcript highlighting can map playback time back to
 *   word indices while in edited preview mode.
 */
async function refreshMainWavePreviewFromEdits() {
  const baseAudio = importedEditor.audioPath;
  if (!baseAudio || !importedEditor.pieceTable) {
    resetEditedPreviewState();
    clearMainWave();
    return;
  }

  const token = ++previewRefreshToken;
  isRefreshingPreview = true;

  try {
    const activeImported = importedEditor.pieceTable ? getActiveEntries(importedEditor.pieceTable) : [];

    if (activeImported.length === 0) {
      resetEditedPreviewState();
      clearMainWave();
      return;
    }

    const payload = {
      version: 1,
      sourceFile: baseAudio,
      entries: activeImported.map((ve) => ({
        id: ve.entry.id,
        sourceFile: ve.entry.sourceFile || baseAudio,
        sourceStart: ve.entry.sourceStart,
        sourceEnd: ve.entry.sourceEnd,
        label: ve.entry.word,
        muted: false,
      })),
      createdAt: importedEditor.pieceTable?.createdAt || new Date().toISOString(),
      modifiedAt: importedEditor.pieceTable?.modifiedAt || new Date().toISOString(),
    };

    const json = JSON.stringify(payload);
    const previewPath = await otter.renderEditedPreview(json);
    if (token !== previewRefreshToken) return;

    await loadMainWaveFromPath(previewPath);
    if (token !== previewRefreshToken) return;

    previewWordTimes = buildPreviewWordTimesFromActiveEntries(activeImported);
    isEditedPreviewMode = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(`\nWARN: Failed to refresh edited preview: ${msg}\n`);
    if (token === previewRefreshToken) {
      resetEditedPreviewState();
      clearMainWave();
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

async function loadWaveformWindow(
  wsInstance: any,
  audioPath: string,
  start: number,
  end: number
) {
  const wav = await otter.audioSection(audioPath, start, end);

  await wsInstance.loadBlob(
    new Blob([wav], { type: "audio/wav" })
  );
}

/**
 * Update the visual selection state for a range of words.
 *
 * @param {number|null} start - Start index, or null to clear selection.
 * @param {number|null} end   - End index, or null to clear selection.
 */
function setSelectionRange(editor: EditorState, start: number | null, end: number | null) {
  if (start == null || end == null) {
    setSelectedIndices(editor, [], null);
  } else {
    const range = normalizeRange(start, end);
    const indices: number[] = [];
    for (let i = range.start; i <= range.end; i++) indices.push(i);
    setSelectedIndices(editor, indices, editor.selectionAnchor);
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
async function loadDetailForRange(sourceFile: string, start: number, end: number) {
  if (!sourceFile) throw new Error("No audio loaded");
  const { winStart, winEnd } = computeDetailWindow(start, end);

  // Map the range's absolute times into snippet-local times
  const localRangeStart = start - winStart;
  const localRangeEnd = end - winStart;

  // Create a short WAV snippet around the selected word (main process uses ffmpeg)
  const wav = await otter.audioSection(
    sourceFile,
    winStart,
    winEnd
  );

  // Enable/show detail UI now that detail audio exists
  waveDetailPane.hidden = false;
  detailDivider.hidden = false;
  btnDetailPlay.disabled = false;
  btnRegion.disabled = false;
  setDetailPlayIcon(false);


  // Attach ready handler BEFORE loading
  wsDetail.once("ready", () => {
    setDetailWordRegion(localRangeStart, localRangeEnd);
    wsDetail.setTime(localRangeStart);
  });
  
  await wsDetail.loadBlob(
    new Blob([wav], { type: "audio/wav" })
  );

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
function renderTranscript(editor: EditorState) {
  const pane = editor.paneEl;
  pane.innerHTML = "";
  pane.classList.toggle("moveMode", editor.interactionMode === "move");
  const viewEntries = editor.pieceTable ? getViewEntries(editor.pieceTable) : [];

  for (let i = 0; i < editor.words.length; i++) {
    const w = editor.words[i];

    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w.word + " ";
    span.dataset.index = String(i);
    span.draggable = editor.interactionMode === "move";

    const ve = viewEntries[i];
    if (ve) {
      if (ve.status === "deleted") span.classList.add("deleted");
      else if (ve.status === "added") span.classList.add("added");
      else if (ve.status === "moved") span.classList.add("moved");
    }

    span.addEventListener("mousedown", (event: MouseEvent) => {
      if (editor.interactionMode !== "select") return;
      if (event.button !== 0) return;
      if (event.ctrlKey || event.metaKey) return;

      setActiveEditor(editor);
      const alreadySelected = editor.selectedIndices.includes(i);
      if (alreadySelected && editor.selectedIndices.length > 0) {
        mouseSelectionMoved = false;
        return;
      }

      editor.selectionAnchor = i;
      setSelectionRange(editor, i, i);
      isMouseSelecting = true;
      mouseSelectionMoved = false;
      event.preventDefault();
    });

    span.addEventListener("mouseenter", () => {
      if (editor.interactionMode !== "select") return;
      if (!isMouseSelecting || editor.selectionAnchor == null) return;
      if (editor.selectionEnd !== i || editor.selectionStart !== editor.selectionAnchor) {
        mouseSelectionMoved = true;
      }
      setSelectionRange(editor, editor.selectionAnchor, i);
    });

    span.addEventListener("dragstart", (event: DragEvent) => {
      if (editor.interactionMode !== "move") {
        event.preventDefault();
        return;
      }
      setActiveEditor(editor);
      if (editor.selectedIndices.includes(i) && editor.selectedIndices.length > 0) {
        dragMoveSourceIndices = editor.selectedIndices.slice();
      } else {
        setSelectedIndices(editor, [i], i);
        dragMoveSourceIndices = [i];
      }
      dragMoveEditorKind = editor.kind;

      pane.classList.add("dragging-words");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", "move");
      }
    });

    span.addEventListener("dragover", (event: DragEvent) => {
      if (editor.interactionMode !== "move") return;
      if (dragMoveSourceIndices.length === 0) return;
      if (dragMoveEditorKind !== editor.kind) return;
      event.preventDefault();

      const rect = span.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;

      clearDropIndicators();
      span.classList.add(before ? "drop-before" : "drop-after");
    });

    span.addEventListener("drop", (event: DragEvent) => {
      if (editor.interactionMode !== "move") return;
      if (dragMoveSourceIndices.length === 0) return;
      if (dragMoveEditorKind !== editor.kind) return;
      event.preventDefault();
      event.stopPropagation();

      const rect = span.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      const targetIndex = before ? i : i + 1;

      clearDropIndicators();
      moveCurrentSelection(editor, targetIndex);
      dragMoveSourceIndices = [];
      dragMoveEditorKind = null;
      pane.classList.remove("dragging-words");
    });

    span.addEventListener("dragend", () => {
      clearDropIndicators();
      dragMoveSourceIndices = [];
      dragMoveEditorKind = null;
      pane.classList.remove("dragging-words");
    });

    span.addEventListener("click", async (event: MouseEvent) => {
      if (mouseSelectionMoved) {
        mouseSelectionMoved = false;
        return;
      }
      setActiveEditor(editor);

      // Transcript click = select word + seek main audio
      if (editor.interactionMode === "select" && (event.ctrlKey || event.metaKey)) {
        if (editor.selectedIndices.includes(i)) {
          setSelectedIndices(editor, editor.selectedIndices.filter((idx) => idx !== i), editor.selectionAnchor);
        } else {
          setSelectedIndices(editor, editor.selectedIndices.concat(i), i);
        }
      } else if (editor.interactionMode === "select" && event.shiftKey && editor.selectionAnchor != null) {
        setSelectionRange(editor, editor.selectionAnchor, i);
      } else {
        editor.selectionAnchor = i;
        setSelectionRange(editor, i, i);
      }

      if (!editor.selectedIndices.includes(i)) return;

      const selectedViewEntries = editor.pieceTable ? getViewEntries(editor.pieceTable) : [];
      const clickedEntry = selectedViewEntries[i]?.entry;
      const clickedSourceFile = clickedEntry?.sourceFile || editor.audioPath;
      if (!clickedSourceFile) return;

      if (editor.kind === "imported") {
        const seekTime = isEditedPreviewMode && previewWordTimes[i]
          ? previewWordTimes[i].start
          : Number(w.start);
        ws.setTime(seekTime + SEEK_EPS);
        setPlayheadIndex(i);
      } else if (editor.kind === "pending-import") {
        wsImported.setTime(Number(w.start) + SEEK_EPS);
      } else {
        wsRecorded.setTime(Number(w.start) + SEEK_EPS);
      }

      // Load the detail waveform snippet centered on the selected range
      let rangeStartIdx = i;
      let rangeEndIdx = i;
      if (editor.selectedIndices.length > 1 && isContiguousSelection(editor.selectedIndices)) {
        rangeStartIdx = editor.selectedIndices[0];
        rangeEndIdx = editor.selectedIndices[editor.selectedIndices.length - 1];
      }
      const rangeEntries = selectedViewEntries.slice(rangeStartIdx, rangeEndIdx + 1);
      const rangeSourceFile = rangeEntries[0]?.entry.sourceFile || clickedSourceFile;
      const mixedSources = rangeEntries.some((ve) => (ve.entry.sourceFile || editor.audioPath) !== rangeSourceFile);
      if (mixedSources) {
        appendLog("INFO:Detail playback is only available for selections from a single source audio.\n");
        return;
      }
      const rangeStart = Number(editor.words[rangeStartIdx].start);
      const rangeEnd = Number(editor.words[rangeEndIdx].end);

      detailEditor = editor;
      detailSelStart = rangeStartIdx;
      detailSelEnd = rangeEndIdx;

      try {
        await loadDetailForRange(rangeSourceFile, rangeStart, rangeEnd);
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
      if (editor.interactionMode !== "select") return;
      event.preventDefault();
      setActiveEditor(editor);
      isDragging = true;
      editor.selectionAnchor = i;
      setSelectionRange(editor, i, i);
    });

    // Drag Selection: mouseover while dragging
    // As the user moves the cursor across words:
    //   • Check if drag is active (isDragging === true)
    //   • Get the hovered word's index from the DOM
    //   • Call setSelectionRange(anchor, hovered) to expand/contract selection
    //   • Both forward and backward drag work because setSelectionRange()
    //     normalizes the range order internally
    span.addEventListener("mouseover", (event: MouseEvent) => {
      if (editor.interactionMode !== "select") return;
      if (!isDragging) return;
      const hoveredIndex = Number((event.target as HTMLElement).dataset.index);
      if (editor.selectionAnchor != null && !isNaN(hoveredIndex)) {
        setSelectionRange(editor, editor.selectionAnchor, hoveredIndex);
      }
    });

    pane.appendChild(span);

    const breakCount = editor.words[i].breakAfter ?? 0;
    for (let j = 0; j < breakCount; j++) 
    {
      pane.appendChild(document.createElement("br"));
    }

    
  }

  // Re-apply selection and playhead after re-render (e.g., new transcript)
  const keptSelection = editor.selectedIndices.filter((idx) => idx >= 0 && idx < editor.words.length);
  setSelectedIndices(editor, keptSelection, editor.selectionAnchor);

  if (editor.kind === "imported" && playheadIndex >= 0 && playheadIndex < editor.words.length) {
    setPlayheadIndex(playheadIndex);
  } else if (editor.kind === "imported") {
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
  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      // Selection remains as-is; do not modify it further
    }
  });
}

function renderHighlightedWord(
  wordElement: HTMLElement,
  wordText: string,
  searchQuery: string
) {
  wordElement.replaceChildren();

  if (!searchQuery) {
    wordElement.textContent = wordText + " ";
    return;
  }

  const lowerWord = wordText.toLowerCase();
  const lowerQuery = searchQuery;
  const matchPosition = lowerWord.indexOf(lowerQuery);

  if (matchPosition === -1) {
    wordElement.textContent = wordText + " ";
    return;
  }

  const before = wordText.slice(0, matchPosition);
  const match = wordText.slice(matchPosition, matchPosition + searchQuery.length);
  const after = wordText.slice(matchPosition + searchQuery.length);

  wordElement.appendChild(document.createTextNode(before));

  const mark = document.createElement("span");
  mark.className = "highlight";
  mark.textContent = match;
  wordElement.appendChild(mark);

  wordElement.appendChild(document.createTextNode(after + " "));
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

// Pending imported waveform UI
const importedWavePane = mustGetEl<HTMLDivElement>("importedWavePane");
const importedWaveDivider = mustGetEl<HTMLHRElement>("importedWaveDivider");
const btnImportedPlay = mustGetEl<HTMLButtonElement>("btnImportedPlay");
const importedTimeEl = mustGetEl<HTMLSpanElement>("importedTime");
const importedLoadedFileEl = mustGetEl<HTMLSpanElement>("importedLoadedFile");

// Recorded waveform UI
const recordedWavePane = mustGetEl<HTMLDivElement>("recordedWavePane");
const recordedWaveDivider = mustGetEl<HTMLHRElement>("recordedWaveDivider");
const btnRecordedPlay = mustGetEl<HTMLButtonElement>("btnRecordedPlay");
const recordedTimeEl = mustGetEl<HTMLSpanElement>("recordedTime");
const btnTranscribeRecorded = mustGetEl<HTMLButtonElement>("btnTranscribeRecorded");
const btnStopRecorded = mustGetEl<HTMLButtonElement>("btnStopRecorded");

// Switch between play and pause icons
function setPlayIcon(isPlaying: boolean) {
  btnPlay.textContent = isPlaying ? "⏸︎" : "▶︎";
  btnPlay.title = isPlaying ? "Pause" : "Play";
  btnPlay.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

// Create a Regions plugin instance for the main waveform (deleted-region overlays)
const mainRegions = WaveSurfer.Regions.create();

/**
 * WaveSurfer instances in this UI:
 * - `ws`: primary waveform for the **main transcript** (importedEditor). This is the waveform
 *   users primarily scrub/play against, and it is also where the edited-preview waveform loads.
 * - `wsImported`: waveform for the **staged imported audio** (pendingImportEditor). This is a
 *   "preview/staging" lane until its transcript is appended into main.
 * - `wsRecorded`: waveform for the **recorded audio clip** (recordedEditor). Users can playback
 *   the recording and optionally transcribe it into a transcript pane.
 * - `wsDetail`: short waveform snippet used for **fine-grained selection/boundary adjustment**
 *   around the current selection (detailEditor + detailSelStart/detailSelEnd).
 */
const ws = WaveSurfer.create({
  container: "#waveform",
  height: 80,
  normalize: true,
  plugins: [mainRegions]
});

const wsImported = WaveSurfer.create({
  container: "#waveformImported",
  height: 80,
  normalize: true,
});

// Recorded waveform (separate from project waveform)
const wsRecorded = WaveSurfer.create({
  container: "#waveformRecorded",
  height: 80,
  normalize: true,
});

function setImportedPlayIcon(isPlaying: boolean) {
  btnImportedPlay.textContent = "Play";
  btnImportedPlay.title = isPlaying ? "Pause Imported Audio" : "Play Imported Audio";
  btnImportedPlay.setAttribute("aria-label", isPlaying ? "Pause Imported Audio" : "Play Imported Audio");
}

wsImported.on("play", () => setImportedPlayIcon(true));
wsImported.on("pause", () => setImportedPlayIcon(false));
wsImported.on("finish", () => setImportedPlayIcon(false));
wsImported.on("timeupdate", (t: number) => {
  importedTimeEl.textContent = `${t.toFixed(2)}s`;
});

btnImportedPlay.addEventListener("click", () => {
  wsImported.playPause();
});

function setRecordedPlayIcon(isPlaying: boolean) {
  btnRecordedPlay.textContent = isPlaying ? "⏸︎" : "▶︎";
  btnRecordedPlay.title = isPlaying ? "Pause Recording" : "Play Recording";
  btnRecordedPlay.setAttribute("aria-label", isPlaying ? "Pause Recording" : "Play Recording");
}

wsRecorded.on("play", () => setRecordedPlayIcon(true));
wsRecorded.on("pause", () => setRecordedPlayIcon(false));
wsRecorded.on("finish", () => setRecordedPlayIcon(false));

wsRecorded.on("timeupdate", (t: number) => {
  recordedTimeEl.textContent = `${t.toFixed(2)}s`;
});

btnRecordedPlay.addEventListener("click", () => {
  wsRecorded.playPause();
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
  for (let i = 0; i < importedEditor.words.length; i++) {
    const start = isEditedPreviewMode && previewWordTimes[i]
      ? previewWordTimes[i].start
      : importedEditor.words[i].start;
    const end = isEditedPreviewMode && previewWordTimes[i]
      ? previewWordTimes[i].end
      : importedEditor.words[i].end;
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
      pushUndo(importedEditor);
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

// Initial record UI state
setRecordingState(false);
importedWavePane.hidden = true;
importedWaveDivider.hidden = true;
btnImportedPlay.disabled = true;
setImportedPlayIcon(false);
recordedWavePane.hidden = true;
recordedWaveDivider.hidden = true;
btnRecordedPlay.disabled = true;
btnTranscribeRecorded.disabled = true;
btnStopRecorded.hidden = true;


//==============================================================================
//
// BEGIN: Objects and code related to Loading and Transcription
//
//==============================================================================

type TranscriptionJobKind = "pending-import" | "recorded";
type TranscriptionJob = {
  id: string;
  kind: TranscriptionJobKind;
  audioPath: string;
  specArg: TranscribeSpec;
  enqueuedAt: number;
};

let transcriptionQueue: TranscriptionJob[] = [];
let isTranscriptionRunning = false;

/**
 * Human-friendly description for logs/status.
 * Intentionally avoids dumping full paths into the UI.
 */
function describeJob(job: TranscriptionJob): string {
  const label = job.kind === "pending-import" ? "Imported audio" : "Recorded audio";
  const fname = job.audioPath.split("/").pop() ?? job.audioPath;
  return `${label} (${fname})`;
}

/**
 * Drain the transcription queue sequentially (FIFO).
 *
 * Guarantees:
 * - Only one transcription runs at a time (`isTranscriptionRunning` guard).
 * - Jobs run in the exact order they were enqueued (button press order).
 * - If a job is cancelled, we simply return from that job and continue to the next.
 *
 * Note:
 * - Each queued job carries its own `specArg` snapshot so model/pipeline choice is
 *   deterministic even if the user changes the UI spec before the job starts.
 */
async function runTranscriptionQueue(): Promise<void> {
  if (isTranscriptionRunning) return;
  isTranscriptionRunning = true;
  try {
    while (transcriptionQueue.length > 0) {
      const job = transcriptionQueue.shift()!;
      const remaining = transcriptionQueue.length;
      setStatus(
        remaining > 0
          ? `Starting transcription: ${describeJob(job)} (${remaining} queued after this)…`
          : `Starting transcription: ${describeJob(job)}…`,
        "working"
      );
      appendLog(`\n=== Transcription job started: ${describeJob(job)} ===\n`);

      if (job.kind === "pending-import") {
        await transcribePendingImportAudio(job.audioPath, job.specArg);
      } else {
        await transcribeRecordedAudio(job.audioPath, job.specArg);
      }
    }
  } finally {
    isTranscriptionRunning = false;
  }
}

/**
 * Enqueue a transcription request and kick the runner.
 *
 * UX behavior:
 * - If another job is running (or already queued), we immediately notify the user
 *   that this job is waiting.
 */
function enqueueTranscription(kind: TranscriptionJobKind, audioPath: string, specArg: TranscribeSpec): void {
  const job: TranscriptionJob = {
    id: crypto.randomUUID(),
    kind,
    audioPath,
    specArg,
    enqueuedAt: Date.now(),
  };

  const wasRunning = isTranscriptionRunning || transcriptionQueue.length > 0;
  transcriptionQueue.push(job);

  if (wasRunning) {
    const pos = transcriptionQueue.length;
    setStatus(`Transcription queued (#${pos}). Waiting for current transcription to finish…`, "info");
    appendLog(`INFO: queued transcription job #${pos}: ${describeJob(job)}\n`);
  }

  void runTranscriptionQueue();
}

/**
 * Transcribe an imported (staged) audio file into the pending-import editor pane.
 *
 * Responsibilities:
 * - Drive UI state for the imported transcription flow (progress, buttons).
 * - Commit results atomically into `pendingImportEditor` (words + piece table).
 *
 * Input:
 * - `specArg` is a snapshot taken at the time the user clicked Transcribe.
 */
async function transcribePendingImportAudio(toTranscribe: string, specArg: TranscribeSpec): Promise<void> {
  resetEditedPreviewState();
  btnTranscribe.disabled = true;
  setStatus("Starting transcription...", "working");
  appendLog("\n=== Transcription started ===\n");

  try {
    btnChoose.disabled = true;
    progressEl.value = 0;
    progressEl.hidden = false;
    setTranscribingState(true);

    const result = await otter.transcribeAudio(toTranscribe, specArg);
    if (result && typeof result === "object" && "cancelled" in result && result.cancelled) {
      setStatus("Transcription cancelled.", "info");
      return;
    }
    const transcript: TranscriptResult = result as TranscriptResult;
    const newWords = Array.isArray(transcript) ? transcript : (transcript.words || []);
    const lang = Array.isArray(transcript) ? undefined : transcript.language;
    const langSuffix = lang ? `, lang=${lang}` : "";
    setStatus(`Transcript ready (${newWords.length} words${langSuffix})`, "success");

    pendingImportEditor.audioPath = toTranscribe;
    pendingImportEditor.words = newWords;
    pendingImportEditor.pieceTable = buildPieceTableFromTranscript(newWords, toTranscribe);
    pendingImportEditor.undoStack = [];
    pendingImportEditor.redoStack = [];
    pendingImportEditor.selectedIndices = [];
    pendingImportEditor.selectionAnchor = null;
    pendingImportEditor.selectionStart = null;
    pendingImportEditor.selectionEnd = null;
    updateEditButtonStates();

    renderTranscript(pendingImportEditor);
    setActiveEditor(pendingImportEditor);
    pendingImportAudioPath = null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes("cancelled")) {
      setStatus("Transcription cancelled.", "info");
    } else {
      setStatus("Transcription failed (see logs).", "error");
      appendLog("\nERROR:\n" + msg + "\n");
    }
  } finally {
    btnChoose.disabled = false;
    btnTranscribe.disabled = pendingImportAudioPath == null;
    setTranscribingState(false);
    progressEl.hidden = true;
  }
}

/**
 * Transcribe a recorded WAV into the recorded editor pane.
 *
 * Guardrails:
 * - If the user records a new clip while a prior recorded job is queued, we do not
 *   overwrite the UI with a transcript for an older audio path. (We still allow the
 *   job to complete for stability, but we skip applying results.)
 *
 * Input:
 * - `specArg` is a snapshot taken at the time the user clicked Transcribe Rec.
 */
async function transcribeRecordedAudio(audioPath: string, specArg: TranscribeSpec): Promise<void> {
  btnTranscribeRecorded.disabled = true;
  setRecordedTranscribingState(true);
  setStatus("Transcribing recording…", "working");
  progressEl.value = 0;
  progressEl.hidden = false;

  try {
    const result = await otter.transcribeAudio(audioPath, specArg);
    if (result && typeof result === "object" && "cancelled" in result && (result as any).cancelled) {
      setStatus("Recording transcription cancelled.", "info");
      return;
    }
    const transcript: TranscriptResult = result as TranscriptResult;
    const newWords = Array.isArray(transcript) ? transcript : (transcript.words || []);
    if (newWords.length === 0) {
      setStatus("No words transcribed from recording.", "info");
      return;
    }

    // Only apply if this recording is still the current one in the UI.
    // (User may have recorded a new clip while this job was queued.)
    if (recordedEditor.audioPath !== audioPath) {
      appendLog(`INFO: recorded transcription finished for a stale audioPath; ignoring UI apply.\n`);
      return;
    }

    recordedEditor.words = newWords;
    recordedEditor.pieceTable = buildPieceTableFromTranscript(newWords, audioPath);
    recordedEditor.undoStack = [];
    recordedEditor.redoStack = [];
    recordedEditor.selectedIndices = [];
    recordedEditor.selectionAnchor = null;
    recordedEditor.selectionStart = null;
    recordedEditor.selectionEnd = null;

    renderTranscript(recordedEditor);
    setActiveEditor(recordedEditor);
    updateEditButtonStates();
    setStatus(`Recording transcript ready (${newWords.length} words).`, "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Recording transcription failed (see logs).", "error");
    appendLog("\nERROR recording transcription:\n" + msg + "\n");
  } finally {
    btnTranscribeRecorded.disabled = false;
    setRecordedTranscribingState(false);
    progressEl.hidden = true;
  }
}

// Handle the "Transcribe" button
btnTranscribe.addEventListener("click", async () => {
  const toTranscribe = pendingImportAudioPath;
  if (!toTranscribe) return;
  enqueueTranscription("pending-import", toTranscribe, getActiveSpecArg());
});

// Handle the "Pause / Resume" button
btnPause.addEventListener("click", async () => {
  if (!isPaused) {
    const result = await otter.pauseTranscription();
    if (!result.ok) {
      setStatus("Unable to pause transcription.", "error");
      return;
    }
    isPaused = true;
    btnPause.textContent = "▶ Resume";
    setStatus("Transcription paused.", "info");
  } else {
    const result = await otter.resumeTranscription();
    if (!result.ok) {
      setStatus("Unable to resume transcription.", "error");
      return;
    }
    isPaused = false;
    btnPause.textContent = "⏸ Pause";
    setStatus("Transcribing…", "working");
  }
});

// Handle the "Stop" button
btnStop.addEventListener("click", async () => {
  await otter.cancelTranscription();
});

// Handle the "Record" button
btnRecord.addEventListener("click", async () => {
  try {
    micChunks = [];
    micRecordingStartedAt = Date.now();
    setStatus("Requesting microphone…", "working");

    const deviceId = micSelect.value.trim();
    const audioConstraints = deviceId ? { deviceId: { exact: deviceId } } : true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    const mimeType = mimeCandidates.find((t) => (window as any).MediaRecorder?.isTypeSupported?.(t)) || "";

    micRecorder = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
    micRecorder.addEventListener("dataavailable", (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) micChunks.push(ev.data);
    });

    micRecorder.addEventListener("start", () => {
      setRecordingState(true);
      setStatus("Recording…", "working");
    });

    micRecorder.addEventListener("stop", async () => {
      setRecordingState(false);
      btnRecordPause.textContent = "⏸ Pause Rec";

      const durMs = Date.now() - micRecordingStartedAt;
      if (durMs < 250) {
        setStatus("Recording too short.", "error");
        await stopMicIfActive();
        return;
      }

      try {
        setStatus("Saving recording…", "working");
        const blob = new Blob(micChunks, { type: micRecorder?.mimeType || mimeType || "audio/webm" });
        const ab = await blob.arrayBuffer();
        const wavPath = await otter.saveMicRecordingAs(ab, blob.type || mimeType || "");
        if (!wavPath) {
          setStatus("Recording save canceled.", "info");
          return;
        }

        // Show the recorded waveform + a separate transcribe button.
        recordedEditor.audioPath = wavPath;
        recordedEditor.words = [];
        recordedEditor.pieceTable = null;
        recordedEditor.undoStack = [];
        recordedEditor.redoStack = [];
        recordedEditor.selectedIndices = [];
        recordedEditor.selectionAnchor = null;
        recordedEditor.selectionStart = null;
        recordedEditor.selectionEnd = null;

        transcriptRecordedEl.innerHTML = "";
        recordedWavePane.hidden = false;
        recordedWaveDivider.hidden = false;
        btnRecordedPlay.disabled = true;
        btnTranscribeRecorded.disabled = false;
        btnStopRecorded.hidden = true;

        const recAb = await otter.readFileAsArrayBuffer(wavPath);
        await wsRecorded.loadBlob(new Blob([recAb]));
        btnRecordedPlay.disabled = false;
        setRecordedPlayIcon(false);

        updateEditButtonStates();
        setStatus("Recording saved. Ready to transcribe.", "success");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus("Recording failed (see logs).", "error");
        appendLog("\nERROR recording:\n" + msg + "\n");
      } finally {
        await stopMicIfActive();
        micChunks = [];
      }
    });

    micRecorder.start();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setRecordingState(false);
    setStatus("Microphone permission or recording failed.", "error");
    appendLog("\nERROR mic:\n" + msg + "\n");
    await stopMicIfActive();
  }
});

btnRecordPause.addEventListener("click", () => {
  if (!micRecorder) return;
  if (micRecorder.state === "recording") {
    try { micRecorder.pause(); } catch { /* ignore */ }
    btnRecordPause.textContent = "▶ Resume Rec";
    setStatus("Recording paused.", "info");
  } else if (micRecorder.state === "paused") {
    try { micRecorder.resume(); } catch { /* ignore */ }
    btnRecordPause.textContent = "⏸ Pause Rec";
    setStatus("Recording…", "working");
  }
});

btnTranscribeRecorded.addEventListener("click", async () => {
  if (!recordedEditor.audioPath) return;
  enqueueTranscription("recorded", recordedEditor.audioPath, getActiveSpecArg());
});

btnStopRecorded.addEventListener("click", async () => {
  appendLog("INFO:Cancel requested for recording transcription.\n");
  await otter.cancelTranscription();
});

btnRecordStop.addEventListener("click", async () => {
  try {
    micRecorder?.stop();
  } catch {
    // ignore
  }
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

  clearPendingImportedView();
  pendingImportAudioPath = selectedPath;

  const fname = pendingImportAudioPath.split("/").pop() ?? pendingImportAudioPath;
  setStatus(`Selected imported audio: ${fname}`, "success");

  btnTranscribe.disabled = false;

  importedWavePane.hidden = false;
  importedWaveDivider.hidden = false;
  importedLoadedFileEl.textContent = shortenFilenameMiddle(fname);
  btnImportedPlay.disabled = true;
  importedTimeEl.textContent = "0.00";
  const ab = await otter.readFileAsArrayBuffer(pendingImportAudioPath);
  const blob = new Blob([ab]);
  await wsImported.loadBlob(blob);
  btnImportedPlay.disabled = false;
  setImportedPlayIcon(false);
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

// allow early error hooks to log once appendLog exists
(window as any).__otterAppendLog = appendLog;

// Flush any errors that happened before the log was initialized.
if (earlyLogBuffer.length) {
  for (const m of earlyLogBuffer) appendLog(m);
  earlyLogBuffer.length = 0;
  openDevPanelIfPresent();
}

// We've received a normal log message
otter.onTranscribeLog((msg: string) => appendLog(msg));

// We've received a progress report from the transcirption engine
otter.onTranscribeProgress((pct: number) => {
  progressEl.value = pct;
  progressEl.hidden = false;
  // Don't override more specific statuses (e.g. "Transcribing recording…")
  if (!statusEl.textContent || statusEl.textContent === "Transcribing…") {
    statusEl.textContent = "Transcribing…";
  }
});


//==============================================================================
//
// BEGIN: Objects and code related to developer options
//
//==============================================================================

// Friendly display names for known spec files; unknown files fall back to their filename.
const SPEC_FRIENDLY_LABELS: Record<string, string> = {
  "fast_spec.json":   "Fastest (tiny model)",
  "fw.json":          "Fast (no cleanup)",
  "fw_cwt.json":      "Balanced",
  "fw_asw_cwt.json":  "Refined",
  "default_spec.json":"Recommended",
  "wx_asw_cwt.json":  "WhisperX (slowest)",
};

const SPEC_ORDER: string[] = [
  "fast_spec.json",
  "fw.json",
  "fw_cwt.json",
  "fw_asw_cwt.json",
  "default_spec.json",
  "wx_asw_cwt.json",
];

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
/**
 * Build the transcription pipeline argument from the current UI state.
 *
 * Semantics:
 * - If "Customize JSON" is enabled, we send the textarea contents verbatim (`mode: "json"`).
 * - Otherwise we send the selected preset filename (`mode: "file"`).
 *
 * Queueing note:
 * - Callers that enqueue background work should snapshot this return value at click time,
 *   rather than reading it later, so the chosen model/pipeline is stable per job.
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
  const sorted = [...files].sort((a, b) => {
    const ai = SPEC_ORDER.indexOf(a);
    const bi = SPEC_ORDER.indexOf(b);
    return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
  });
  for (const f of sorted) {
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
  try {
    await populateSpecSelect();
    // Start state: default selected, Customize unchecked, textarea hidden
    chkCustomSpec.checked = false;
    showCustomArea(false);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    appendLog(`\nERROR: Failed to initialize model dropdown: ${msg}\n`);
    setStatus("Model dropdown failed (see logs).", "error");
  }
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

// Now that edit controls exist, it's safe to apply active editor UI state.
setActiveEditor(activeEditor);

//helper function for removing one breakline
function removeOneBreakline(): boolean {
  if (activeEditor.selectedIndices.length === 0) return false;

  const lastSelected = activeEditor.selectedIndices[activeEditor.selectedIndices.length - 1];
  const currentBreaks = activeEditor.words[lastSelected]?.breakAfter ?? 0;

  if (currentBreaks <= 0) return false;

  pushUndo(activeEditor);
  activeEditor.words[lastSelected].breakAfter = currentBreaks - 1;
  renderTranscript(activeEditor);
  updateEditButtonStates();
  return true;
}

async function copySelection(): Promise<boolean> {
  if (!activeEditor.pieceTable || activeEditor.selectedIndices.length === 0) return false;
  const selected = new Set(uniqueSortedIndices(activeEditor.selectedIndices));
  const view = getViewEntries(activeEditor.pieceTable);
  copiedSelectionEntries = view
    .filter((ve, idx) => selected.has(idx))
    .map((ve) => ({ ...ve.entry }));
  if (copiedSelectionEntries.length === 0) return false;

  const clipboardText = copiedSelectionEntries.map((e) => e.word).join(" ").trim();
  if (clipboardText) {
    try {
      await navigator.clipboard.writeText(clipboardText);
    } catch {
      // Clipboard access can be denied; keep in-app copy buffer regardless.
    }
  }
  return true;
}

function pasteSelection(): boolean {
  if (!activeEditor.pieceTable || copiedSelectionEntries.length === 0) return false;
  const pt = activeEditor.pieceTable;
  const currentEntries = getViewEntries(pt);
  const selected = uniqueSortedIndices(activeEditor.selectedIndices);
  const insertAt = selected.length ? selected[selected.length - 1] + 1 : currentEntries.length;

  const stamp = Date.now();
  const clones: PieceEntry[] = copiedSelectionEntries.map((entry, idx) => ({
    ...entry,
    id: `${entry.id}_copy_${stamp}_${idx}_${Math.floor(Math.random() * 1e6)}`,
  }));

  pt.addBuffer.push(...clones);
  const addedView: ViewEntry[] = clones.map((entry) => ({
    entry,
    status: "added" as WordStatus,
    visualIndex: 0,
  }));
  const reordered = currentEntries.slice(0, insertAt).concat(addedView, currentEntries.slice(insertAt));

  const newPieces: Piece[] = [];
  for (const ve of reordered) {
    const inOriginal = pt.originalBuffer.indexOf(ve.entry) !== -1;
    const source = inOriginal ? ("original" as const) : ("add" as const);
    const buffer = source === "original" ? pt.originalBuffer : pt.addBuffer;
    const offset = buffer.indexOf(ve.entry);
    if (offset < 0) continue;
    newPieces.push({
      source,
      offset,
      length: 1,
      status: ve.status,
    });
  }

  pt.pieces = mergePieces(newPieces);
  pt.modifiedAt = new Date().toISOString();
  setSelectionRange(activeEditor, insertAt, insertAt + clones.length - 1);
  return true;
}


/**
 * Remove (soft-delete) the currently selected words.
 *
 * Marks the selected range as "deleted" in the piece table. The words
 * remain visible with strikethrough styling so the user can restore them.
 */
function removeSelection() {
  if (!activeEditor.pieceTable || activeEditor.selectedIndices.length === 0) return;
  pushUndo(activeEditor);
  let changedAny = false;
  const ranges = getSelectedRanges(uniqueSortedIndices(activeEditor.selectedIndices));
  for (const r of ranges) {
    const changedActive = applyStatusToRange(activeEditor.pieceTable, r.start, r.end, "active", "deleted");
    const changedAdded = applyStatusToRange(activeEditor.pieceTable, r.start, r.end, "added", "deleted");
    if (changedActive || changedAdded) changedAny = true;
  }
  if (!changedAny) {
    // Nothing was active in that range — pop the undo we just pushed
    activeEditor.undoStack.pop();
    return;
  }
  renderTranscript(activeEditor);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  if (activeEditor.kind === "imported") refreshDetailIfActive();
}

/**
 * Restore previously removed words in the current selection.
 */
function restoreSelection() {
  if (!activeEditor.pieceTable || activeEditor.selectedIndices.length === 0) return;
  pushUndo(activeEditor);
  let changedAny = false;
  const ranges = getSelectedRanges(uniqueSortedIndices(activeEditor.selectedIndices));
  for (const r of ranges) {
    const changed = applyStatusToRange(activeEditor.pieceTable, r.start, r.end, "deleted", "active");
    if (changed) changedAny = true;
  }
  if (!changedAny) {
    activeEditor.undoStack.pop();
    return;
  }
  renderTranscript(activeEditor);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  if (activeEditor.kind === "imported") refreshDetailIfActive();
}

btnRemove.addEventListener("click", () => removeSelection());
btnRestore.addEventListener("click", () => restoreSelection());

window.addEventListener("mouseup", () => {
  isMouseSelecting = false;
});

btnUndo.addEventListener("click", () => {
  if (performUndo(activeEditor)) {
    // Re-render panes (undo may restore/clear other editors too)
    transcriptImportedEl.innerHTML = "";
    transcriptPendingImportedEl.innerHTML = "";
    transcriptRecordedEl.innerHTML = "";
    if (importedEditor.pieceTable) renderTranscript(importedEditor);
    if (pendingImportEditor.pieceTable) renderTranscript(pendingImportEditor);
    if (recordedEditor.pieceTable) renderTranscript(recordedEditor);

    // Restore staged/recorded waveforms from current editor state
    void (async () => {
      if (pendingImportEditor.audioPath) {
        importedWavePane.hidden = false;
        importedWaveDivider.hidden = false;
        importedLoadedFileEl.textContent = shortenFilenameMiddle((pendingImportEditor.audioPath.split("/").pop() ?? pendingImportEditor.audioPath));
        btnImportedPlay.disabled = true;
        try {
          const importAb = await otter.readFileAsArrayBuffer(pendingImportEditor.audioPath);
          await wsImported.loadBlob(new Blob([importAb]));
          btnImportedPlay.disabled = false;
          setImportedPlayIcon(false);
        } catch {
          importedWavePane.hidden = true;
          importedWaveDivider.hidden = true;
          btnImportedPlay.disabled = true;
        }
      } else {
        importedWavePane.hidden = true;
        importedWaveDivider.hidden = true;
        btnImportedPlay.disabled = true;
        importedLoadedFileEl.textContent = "No imported audio staged";
      }

      if (recordedEditor.audioPath) {
        recordedWavePane.hidden = false;
        recordedWaveDivider.hidden = false;
        btnRecordedPlay.disabled = true;
        btnTranscribeRecorded.disabled = false;
        btnStopRecorded.hidden = true;
        try {
          const recAb = await otter.readFileAsArrayBuffer(recordedEditor.audioPath);
          await wsRecorded.loadBlob(new Blob([recAb]));
          btnRecordedPlay.disabled = false;
          setRecordedPlayIcon(false);
        } catch {
          recordedWavePane.hidden = true;
          recordedWaveDivider.hidden = true;
          btnRecordedPlay.disabled = true;
        }
      } else {
        recordedWavePane.hidden = true;
        recordedWaveDivider.hidden = true;
        btnRecordedPlay.disabled = true;
        btnTranscribeRecorded.disabled = true;
        btnStopRecorded.hidden = true;
      }
    })();

    if (importedEditor.audioPath && importedEditor.pieceTable) {
      void refreshMainWavePreviewFromEdits();
    } else {
      clearMainWave();
    }
    updateEditButtonStates();
    if (activeEditor.kind === "imported") refreshDetailIfActive();
  }
});

btnRedo.addEventListener("click", () => {
  if (performRedo(activeEditor)) {
    // Re-render panes (redo may restore/clear other editors too)
    transcriptImportedEl.innerHTML = "";
    transcriptPendingImportedEl.innerHTML = "";
    transcriptRecordedEl.innerHTML = "";
    if (importedEditor.pieceTable) renderTranscript(importedEditor);
    if (pendingImportEditor.pieceTable) renderTranscript(pendingImportEditor);
    if (recordedEditor.pieceTable) renderTranscript(recordedEditor);

    // Restore staged/recorded waveforms from current editor state
    void (async () => {
      if (pendingImportEditor.audioPath) {
        importedWavePane.hidden = false;
        importedWaveDivider.hidden = false;
        importedLoadedFileEl.textContent = shortenFilenameMiddle((pendingImportEditor.audioPath.split("/").pop() ?? pendingImportEditor.audioPath));
        btnImportedPlay.disabled = true;
        try {
          const importAb = await otter.readFileAsArrayBuffer(pendingImportEditor.audioPath);
          await wsImported.loadBlob(new Blob([importAb]));
          btnImportedPlay.disabled = false;
          setImportedPlayIcon(false);
        } catch {
          importedWavePane.hidden = true;
          importedWaveDivider.hidden = true;
          btnImportedPlay.disabled = true;
        }
      } else {
        importedWavePane.hidden = true;
        importedWaveDivider.hidden = true;
        btnImportedPlay.disabled = true;
        importedLoadedFileEl.textContent = "No imported audio staged";
      }

      if (recordedEditor.audioPath) {
        recordedWavePane.hidden = false;
        recordedWaveDivider.hidden = false;
        btnRecordedPlay.disabled = true;
        btnTranscribeRecorded.disabled = false;
        btnStopRecorded.hidden = true;
        try {
          const recAb = await otter.readFileAsArrayBuffer(recordedEditor.audioPath);
          await wsRecorded.loadBlob(new Blob([recAb]));
          btnRecordedPlay.disabled = false;
          setRecordedPlayIcon(false);
        } catch {
          recordedWavePane.hidden = true;
          recordedWaveDivider.hidden = true;
          btnRecordedPlay.disabled = true;
        }
      } else {
        recordedWavePane.hidden = true;
        recordedWaveDivider.hidden = true;
        btnRecordedPlay.disabled = true;
        btnTranscribeRecorded.disabled = true;
        btnStopRecorded.hidden = true;
      }
    })();

    if (importedEditor.audioPath && importedEditor.pieceTable) {
      void refreshMainWavePreviewFromEdits();
    } else {
      clearMainWave();
    }
    updateEditButtonStates();
    if (activeEditor.kind === "imported") refreshDetailIfActive();
  }
});

/**
 * Append the active (non-deleted) words from a source editor into the main transcript.
 *
 * Source editors:
 * - `pendingImportEditor` (Imported Transcript)
 * - `recordedEditor` (Recorded Transcript)
 *
 * Behavior:
 * - If the main transcript is empty, we "promote" the source transcript into main.
 * - Otherwise we append the source's active view entries as newly-added words in main.
 *
 * Undo/redo:
 * - This function ensures the append is undoable and that undo restores the source pane
 *   state (transcript + waveform) that the UI will clear immediately after the append.
 */
function appendEditorToMain(sourceEditor: EditorState, sourcePrefix: string, successMessage: string) {
  if (!sourceEditor.pieceTable || sourceEditor.words.length === 0) return;

  if (!importedEditor.pieceTable) {
    // Make this undoable (restore empty main + restore the source pane we’re about to clear).
    const emptyMain: UndoSnapshot = {
      kind: "empty",
      audioPath: null,
      words: [],
      side: {
        [sourceEditor.kind]: snapshotState(sourceEditor),
      },
    };
    importedEditor.undoStack.push(emptyMain);
    importedEditor.redoStack = [];

    importedEditor.audioPath = sourceEditor.audioPath;
    importedEditor.words = sourceEditor.words.map(w => ({ ...w }));
    // Clone to avoid sharing state between panes (undo can restore source).
    const srcSnap = snapshotState(sourceEditor);
    if (srcSnap.kind === "pt") {
      importedEditor.pieceTable = {
        pieces: srcSnap.pieces.map(p => ({ ...p })),
        originalBuffer: srcSnap.originalBuffer.map(e => ({ ...e })),
        addBuffer: srcSnap.addBuffer.map(e => ({ ...e })),
        sourceFile: srcSnap.ptSourceFile,
        createdAt: srcSnap.ptCreatedAt,
        modifiedAt: new Date().toISOString(),
      };
    } else {
      importedEditor.pieceTable = null;
    }
    importedEditor.selectedIndices = [];
    importedEditor.selectionAnchor = null;
    importedEditor.selectionStart = null;
    importedEditor.selectionEnd = null;
  } else {
    const mainPt = importedEditor.pieceTable;
    const sourceView = getViewEntries(sourceEditor.pieceTable);
    const sourceActive = sourceView.filter(v => v.status !== "deleted");

    // Capture the source pane too so undo can restore it + its waveform.
    const mainUndo = snapshotState(importedEditor);
    mainUndo.side = { [sourceEditor.kind]: snapshotState(sourceEditor) };
    importedEditor.undoStack.push(mainUndo);
    importedEditor.redoStack = [];

    const addEntries: PieceEntry[] = sourceActive.map((ve) => ({
      id: `${sourcePrefix}${crypto.randomUUID().slice(0, 8)}`,
      word: ve.entry.word,
      sourceStart: ve.entry.sourceStart,
      sourceEnd: ve.entry.sourceEnd,
      breakAfter: ve.entry.breakAfter,
      sourceFile: sourceEditor.audioPath || ve.entry.sourceFile,
    }));

    const insertOffset = mainPt.addBuffer.length;
    mainPt.addBuffer.push(...addEntries);
    mainPt.pieces.push({
      source: "add",
      offset: insertOffset,
      length: addEntries.length,
      status: "added",
    });
    mainPt.pieces = mergePieces(mainPt.pieces);
    syncWordsFromPieceTable(importedEditor);
  }

  renderTranscript(importedEditor);
  setActiveEditor(importedEditor);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  setStatus(successMessage, "success");
}

btnAddImportedToTranscript.addEventListener("click", () => {
  if (!pendingImportEditor.pieceTable || pendingImportEditor.words.length === 0) return;
  appendEditorToMain(pendingImportEditor, "i", "Imported transcript added to main transcript.");
  clearPendingImportedView();
  updateEditButtonStates();
});

btnAddRecordedToTranscript.addEventListener("click", () => {
  if (!recordedEditor.pieceTable || recordedEditor.words.length === 0) return;
  appendEditorToMain(recordedEditor, "r", "Recorded transcript added to main transcript.");
  clearRecordedView();
  updateEditButtonStates();
  return;

  /* eslint-disable no-unreachable */
  // If there is no imported transcript yet, promote recorded → imported.
  if (!importedEditor.pieceTable) {
    importedEditor.audioPath = importedEditor.audioPath || recordedEditor.audioPath;
    importedEditor.words = recordedEditor.words.map(w => ({ ...w }));
    importedEditor.pieceTable = recordedEditor.pieceTable;
    importedEditor.undoStack = recordedEditor.undoStack.slice();
    importedEditor.redoStack = recordedEditor.redoStack.slice();
    importedEditor.selectedIndices = [];
    importedEditor.selectionAnchor = null;
    importedEditor.selectionStart = null;
    importedEditor.selectionEnd = null;

    recordedEditor.audioPath = null;
    recordedEditor.words = [];
    recordedEditor.pieceTable = null;
    recordedEditor.undoStack = [];
    recordedEditor.redoStack = [];
    recordedEditor.selectedIndices = [];
    recordedEditor.selectionAnchor = null;
    recordedEditor.selectionStart = null;
    recordedEditor.selectionEnd = null;

    renderTranscript(importedEditor);
    transcriptRecordedEl.innerHTML = "";
    recordedWavePane.hidden = true;
    recordedWaveDivider.hidden = true;
    btnRecordedPlay.disabled = true;
    btnTranscribeRecorded.disabled = true;
    btnStopRecorded.hidden = true;
    setActiveEditor(importedEditor);
    void refreshMainWavePreviewFromEdits();
    updateEditButtonStates();
    setStatus("Recorded transcript added to main transcript.", "success");
    return;
  }

  // Merge: append recorded transcript entries as "added" words at the end of imported.
  const mainPt = importedEditor.pieceTable!;
  const recPt = recordedEditor.pieceTable!;

  pushUndo(importedEditor);

  const recView = getViewEntries(recPt);
  const recActive = recView.filter(v => v.status !== "deleted");
  const addEntries: PieceEntry[] = recActive.map((ve) => ({
    id: `r${crypto.randomUUID().slice(0, 8)}`,
    word: ve.entry.word,
    sourceStart: ve.entry.sourceStart,
    sourceEnd: ve.entry.sourceEnd,
    breakAfter: ve.entry.breakAfter,
    sourceFile: recordedEditor.audioPath || ve.entry.sourceFile,
  }));

  const insertOffset = mainPt.addBuffer.length;
  mainPt.addBuffer.push(...addEntries);
  mainPt.pieces.push({
    source: "add",
    offset: insertOffset,
    length: addEntries.length,
    status: "added",
  });
  mainPt.pieces = mergePieces(mainPt.pieces);

  syncWordsFromPieceTable(importedEditor);
  renderTranscript(importedEditor);

  // Clear recorded editor after merge
  recordedEditor.audioPath = null;
  recordedEditor.words = [];
  recordedEditor.pieceTable = null;
  recordedEditor.undoStack = [];
  recordedEditor.redoStack = [];
  recordedEditor.selectedIndices = [];
  recordedEditor.selectionAnchor = null;
  recordedEditor.selectionStart = null;
  recordedEditor.selectionEnd = null;
  transcriptRecordedEl.innerHTML = "";
  recordedWavePane.hidden = true;
  recordedWaveDivider.hidden = true;
  btnRecordedPlay.disabled = true;
  btnTranscribeRecorded.disabled = true;
  btnStopRecorded.hidden = true;

  setActiveEditor(importedEditor);
  void refreshMainWavePreviewFromEdits();
  updateEditButtonStates();
  setStatus("Recorded transcript appended to main transcript.", "success");
  /* eslint-enable no-unreachable */
});

document.addEventListener("keydown", (e: KeyboardEvent) => {
  // Don't intercept when user is typing in an input/textarea
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  const isMeta = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();

  if (isMeta && !e.shiftKey && key === "z") {
    e.preventDefault();
    if (performUndo(activeEditor)) {
      renderTranscript(activeEditor);
      updateEditButtonStates();
      if (activeEditor.kind === "imported") refreshDetailIfActive();
    }
    return;
  }

  if (isMeta && e.shiftKey && key === "z") {
    e.preventDefault();
    if (performRedo(activeEditor)) {
      renderTranscript(activeEditor);
      updateEditButtonStates();
      if (activeEditor.kind === "imported") refreshDetailIfActive();
    }
    return;
  }

  if (isMeta && key === "y") {
    e.preventDefault();
    if (performRedo(activeEditor)) {
      renderTranscript(activeEditor);
      updateEditButtonStates();
      if (activeEditor.kind === "imported") refreshDetailIfActive();
    }
    return;
  }

  if (isMeta && !e.shiftKey && key === "c") {
    e.preventDefault();
    void copySelection();
    return;
  }

  if (isMeta && !e.shiftKey && key === "v") {
    e.preventDefault();
    if (!activeEditor.pieceTable) return;
    pushUndo(activeEditor);
    if (!pasteSelection()) {
      activeEditor.undoStack.pop();
      return;
    }
    syncWordsFromPieceTable(activeEditor);
    renderTranscript(activeEditor);
    void refreshMainWavePreviewFromEdits();
    updateEditButtonStates();
    if (activeEditor.kind === "imported") refreshDetailIfActive();
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

  if (activeEditor.selectedIndices.length > 0) {
    const lastSelected = activeEditor.selectedIndices[activeEditor.selectedIndices.length - 1];
    pushUndo(activeEditor);
    activeEditor.words[lastSelected].breakAfter = (activeEditor.words[lastSelected].breakAfter ?? 0) + 1;
    renderTranscript(activeEditor);
    updateEditButtonStates();
  }
  return;
}
});

btnSaveEdl.addEventListener("click", async () => {
  if (!importedEditor.pieceTable && !pendingImportEditor.pieceTable && !recordedEditor.pieceTable) return;

  try {
    if (importedEditor.pieceTable) syncBreakAfterToPieceTable(importedEditor);
    if (pendingImportEditor.pieceTable) syncBreakAfterToPieceTable(pendingImportEditor);
    if (recordedEditor.pieceTable) syncBreakAfterToPieceTable(recordedEditor);

    const payload = {
      version: 4,
      imported: importedEditor.pieceTable,
      pendingImported: pendingImportEditor.pieceTable,
      recorded: recordedEditor.pieceTable,
      importedAudioPath: importedEditor.audioPath,
      pendingImportedAudioPath: pendingImportEditor.audioPath,
      recordedAudioPath: recordedEditor.audioPath,
    };
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

    if (parsed && typeof parsed === "object" && parsed.version === 4) {
      const p = parsed as any;
      importedEditor.pieceTable = p.imported ?? null;
      pendingImportEditor.pieceTable = p.pendingImported ?? null;
      recordedEditor.pieceTable = p.recorded ?? null;
      importedEditor.audioPath = typeof p.importedAudioPath === "string" ? p.importedAudioPath : (importedEditor.pieceTable?.sourceFile ?? null);
      pendingImportEditor.audioPath = typeof p.pendingImportedAudioPath === "string" ? p.pendingImportedAudioPath : (pendingImportEditor.pieceTable?.sourceFile ?? null);
      recordedEditor.audioPath = typeof p.recordedAudioPath === "string" ? p.recordedAudioPath : (recordedEditor.pieceTable?.sourceFile ?? null);
    } else if (parsed && typeof parsed === "object" && parsed.version === 3) {
      const p = parsed as any;
      importedEditor.pieceTable = p.imported ?? null;
      pendingImportEditor.pieceTable = null;
      recordedEditor.pieceTable = p.recorded ?? null;
      importedEditor.audioPath = typeof p.importedAudioPath === "string" ? p.importedAudioPath : (importedEditor.pieceTable?.sourceFile ?? null);
      pendingImportEditor.audioPath = null;
      recordedEditor.audioPath = typeof p.recordedAudioPath === "string" ? p.recordedAudioPath : (recordedEditor.pieceTable?.sourceFile ?? null);
    } else
    if (isEdlV2(parsed)) {
      importedEditor.pieceTable = parsed.pieceTable;
      pendingImportEditor.pieceTable = null;
      recordedEditor.pieceTable = null;
      pendingImportEditor.audioPath = null;
      recordedEditor.audioPath = null;
    } else if (isEdlV1(parsed)) {
      importedEditor.pieceTable = convertV1ToV2(parsed);
      pendingImportEditor.pieceTable = null;
      recordedEditor.pieceTable = null;
      pendingImportEditor.audioPath = null;
      recordedEditor.audioPath = null;
    } else {
      setStatus("Invalid EDL file.", "error");
      appendLog("\nERROR: file is not a valid OTTER EDL.\n");
      return;
    }

    importedEditor.undoStack = [];
    importedEditor.redoStack = [];
    importedEditor.selectedIndices = [];
    importedEditor.selectionAnchor = null;
    importedEditor.selectionStart = null;
    importedEditor.selectionEnd = null;

    pendingImportEditor.undoStack = [];
    pendingImportEditor.redoStack = [];
    pendingImportEditor.selectedIndices = [];
    pendingImportEditor.selectionAnchor = null;
    pendingImportEditor.selectionStart = null;
    pendingImportEditor.selectionEnd = null;

    recordedEditor.undoStack = [];
    recordedEditor.redoStack = [];
    recordedEditor.selectedIndices = [];
    recordedEditor.selectionAnchor = null;
    recordedEditor.selectionStart = null;
    recordedEditor.selectionEnd = null;

    if (importedEditor.pieceTable) {
      importedEditor.audioPath = importedEditor.audioPath || importedEditor.pieceTable.sourceFile;
      const viewEntries = getViewEntries(importedEditor.pieceTable);
      importedEditor.words = viewEntries.map(ve => ({
        word: ve.entry.word,
        start: ve.entry.sourceStart,
        end: ve.entry.sourceEnd,
        breakAfter: ve.entry.breakAfter,
      }));
    } else {
      importedEditor.words = [];
    }

    if (pendingImportEditor.pieceTable) {
      pendingImportEditor.audioPath = pendingImportEditor.audioPath || pendingImportEditor.pieceTable.sourceFile;
      const viewEntries = getViewEntries(pendingImportEditor.pieceTable);
      pendingImportEditor.words = viewEntries.map(ve => ({
        word: ve.entry.word,
        start: ve.entry.sourceStart,
        end: ve.entry.sourceEnd,
        breakAfter: ve.entry.breakAfter,
      }));
    } else {
      pendingImportEditor.words = [];
    }

    if (recordedEditor.pieceTable) {
      recordedEditor.audioPath = recordedEditor.audioPath || recordedEditor.pieceTable.sourceFile;
      const viewEntries = getViewEntries(recordedEditor.pieceTable);
      recordedEditor.words = viewEntries.map(ve => ({
        word: ve.entry.word,
        start: ve.entry.sourceStart,
        end: ve.entry.sourceEnd,
        breakAfter: ve.entry.breakAfter,
      }));
    } else {
      recordedEditor.words = [];
    }

    transcriptImportedEl.innerHTML = "";
    transcriptPendingImportedEl.innerHTML = "";
    transcriptRecordedEl.innerHTML = "";
    if (importedEditor.pieceTable) renderTranscript(importedEditor);
    if (pendingImportEditor.pieceTable) renderTranscript(pendingImportEditor);
    if (recordedEditor.pieceTable) renderTranscript(recordedEditor);

    if (pendingImportEditor.audioPath) {
      importedWavePane.hidden = false;
      importedWaveDivider.hidden = false;
      importedLoadedFileEl.textContent = shortenFilenameMiddle((pendingImportEditor.audioPath.split("/").pop() ?? pendingImportEditor.audioPath));
      btnImportedPlay.disabled = true;
      try {
        const importAb = await otter.readFileAsArrayBuffer(pendingImportEditor.audioPath);
        await wsImported.loadBlob(new Blob([importAb]));
        btnImportedPlay.disabled = false;
        setImportedPlayIcon(false);
      } catch (err: unknown) {
        importedWavePane.hidden = true;
        importedWaveDivider.hidden = true;
        btnImportedPlay.disabled = true;
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`ERROR: failed to load imported waveform from EDL audio path: ${msg}\n`);
      }
    } else {
      importedWavePane.hidden = true;
      importedWaveDivider.hidden = true;
      btnImportedPlay.disabled = true;
      importedLoadedFileEl.textContent = "No imported audio staged";
    }

    if (recordedEditor.audioPath) {
      recordedWavePane.hidden = false;
      recordedWaveDivider.hidden = false;
      btnRecordedPlay.disabled = true;
      btnTranscribeRecorded.disabled = false;
      btnStopRecorded.hidden = true;
      try {
        const recAb = await otter.readFileAsArrayBuffer(recordedEditor.audioPath);
        await wsRecorded.loadBlob(new Blob([recAb]));
        btnRecordedPlay.disabled = false;
        setRecordedPlayIcon(false);
      } catch (err: unknown) {
        recordedWavePane.hidden = true;
        recordedWaveDivider.hidden = true;
        btnRecordedPlay.disabled = true;
        const msg = err instanceof Error ? err.message : String(err);
        appendLog(`ERROR: failed to load recorded waveform from EDL audio path: ${msg}\n`);
      }
    } else {
      recordedWavePane.hidden = true;
      recordedWaveDivider.hidden = true;
      btnRecordedPlay.disabled = true;
      btnTranscribeRecorded.disabled = true;
      btnStopRecorded.hidden = true;
    }

    if (importedEditor.audioPath && importedEditor.pieceTable) {
      await refreshMainWavePreviewFromEdits();
    } else {
      clearMainWave();
    }

    // Update UI state
    const fname = (importedEditor.audioPath || "").split("/").pop() ?? "";
    fnameEl.textContent = fname ? shortenFilenameMiddle(fname) : "No file loaded";
    setStatus(`EDL loaded`, "success");
    appendLog(`EDL loaded from ${result.path}\n`);

    btnPlay.disabled = importedEditor.pieceTable == null;
    btnTranscribe.disabled = pendingImportAudioPath == null;
    setActiveEditor(importedEditor.pieceTable ? importedEditor : (pendingImportEditor.pieceTable ? pendingImportEditor : recordedEditor));
    updateEditButtonStates();
    updateDeletedRegions();
    refreshDetailIfActive();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Failed to load EDL.", "error");
    appendLog("\nERROR loading EDL:\n" + msg + "\n");
  }
});

btnSaveEdits.addEventListener("click", async () => {
  if (!importedEditor.pieceTable) return;

  const activeEntries = getActiveEntries(importedEditor.pieceTable);
  if (activeEntries.length === 0) {
    setStatus("Nothing to export (all words removed).", "error");
    return;
  }

  try {
    setStatus("Exporting audio…", "working");

    const exportPayload = {
      version: 1,
      sourceFile: importedEditor.audioPath || "",
      entries: activeEntries.map(ve => ({
        id: ve.entry.id,
        sourceFile: ve.entry.sourceFile || importedEditor.audioPath || "",
        sourceStart: ve.entry.sourceStart,
        sourceEnd: ve.entry.sourceEnd,
        label: ve.entry.word,
        muted: false,
      })),
      createdAt: importedEditor.pieceTable?.createdAt || new Date().toISOString(),
      modifiedAt: importedEditor.pieceTable?.modifiedAt || new Date().toISOString(),
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
