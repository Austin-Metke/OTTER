/**
 * renderer.ts
 *
 * OTTER Read-Only Prototype – Renderer Process
 *
 * This file implements the user interface logic for the OTTER demonstration app.
 * It runs in Electron’s renderer process and is responsible for:
 *
 *   • Displaying the main audio waveform
 *   • Displaying a transcript with word-level timing
 *   • Synchronizing transcript selection with audio playback
 *   • Rendering a secondary “detail” waveform for a selected word
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
 *   boundary adjustment (“nudging”) may be required for precise editing.
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
let playheadIndex = -1;

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


//==============================================================================
//
// BEGIN: Primary rendering logic
//
//==============================================================================

const transcriptEl = mustGetEl<HTMLDivElement>("transcript");
const btnChoose = mustGetEl<HTMLButtonElement>("btnChoose");
const btnTranscribe = mustGetEl<HTMLButtonElement>("btnTranscribe");
const statusEl = mustGetEl<HTMLDivElement>("status");

function normalizeRange(a: number, b: number) {
  return a <= b ? { start: a, end: b } : { start: b, end: a };
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
    selectionStart = null;
    selectionEnd = null;
    selectionAnchor = null;
  } else {
    const range = normalizeRange(start, end);
    selectionStart = range.start;
    selectionEnd = range.end;
  }

  const nodes = transcriptEl.querySelectorAll<HTMLElement>(".word");
  nodes.forEach((el) => {
    const idx = Number(el.dataset.index);
    const inRange =
      selectionStart != null &&
      selectionEnd != null &&
      idx >= selectionStart &&
      idx <= selectionEnd;
    el.classList.toggle("selected", inRange);
  });
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
 * This function is intentionally simple and imperative for clarity in
 * this proof-of-concept; more advanced implementations might virtualize
 * the transcript or decouple rendering from interaction logic.
 *
 * @param {Array<Object>} words - Transcript words with timing metadata
 *                                (each entry includes at least { word, start, end })
 */
function renderTranscript(words: TranscriptWord[]) {
  transcriptEl.innerHTML = "";

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w.word + " ";
    span.dataset.index = String(i);

    span.addEventListener("click", async (event: MouseEvent) => {
      // Transcript click = select word + seek main audio
      if (event.shiftKey && selectionAnchor != null) {
        setSelectionRange(selectionAnchor, i);
      } else {
        selectionAnchor = i;
        setSelectionRange(i, i);
      }
      ws.setTime(Number(w.start) + SEEK_EPS);
      setPlayheadIndex(i);

      // Load the detail waveform snippet centered on the selected range
      const rangeStartIdx = selectionStart != null ? selectionStart : i;
      const rangeEndIdx = selectionEnd != null ? selectionEnd : i;
      const rangeStart = Number(words[rangeStartIdx].start);
      const rangeEnd = Number(words[rangeEndIdx].end);

      try {
        await loadDetailForRange(rangeStart, rangeEnd);
      } catch (err: unknown) {
        console.error("Failed to load detail snippet:", err);
      }
    });

    transcriptEl.appendChild(span);
  }

  // Re-apply selection and playhead after re-render (e.g., new transcript)
  if (selectionStart != null && selectionEnd != null) {
    const maxIdx = words.length - 1;
    if (selectionStart > maxIdx || selectionEnd > maxIdx) {
      setSelectionRange(null, null);
    } else {
      setSelectionRange(selectionStart, selectionEnd);
    }
  }
  if (playheadIndex >= 0 && playheadIndex < words.length) {
    setPlayheadIndex(playheadIndex);
  } else {
    setPlayheadIndex(-1);
  }
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

// Create the waveform visualization object
const ws = WaveSurfer.create({
  container: "#waveform",
  height: 80,
  normalize: true
});

// Keep the play/pause button icon in sync with the current status of playback
ws.on("play", () => setPlayIcon(true));
ws.on("pause", () => setPlayIcon(false));
ws.on("finish", () => setPlayIcon(false));

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
    if (te >= words[i].start && te < words[i].end) { idx = i; break; }
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
  detailRegion.on("update", () => { updateDetailBounds(); });
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
  btnTranscribe.disabled = true;
  setStatus("Preparing to transcribe...", "info");
  appendLog("\n=== Transcription started ===\n");

  try {
    btnChoose.disabled = true;
    btnTranscribe.disabled = true;
    progressEl.value = 0;
    progressEl.hidden = false;

    const result = await otter.transcribeAudio(audioPath, getActiveSpecArg());
    words = Array.isArray(result) ? result : (result.words || []);
    const lang = Array.isArray(result) ? undefined : result.language;
    const langSuffix = lang ? `, lang=${lang}` : "";
    setStatus(`Transcript ready (${words.length} words${langSuffix})`, "success");
    renderTranscript(words);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("Transcription failed (see logs).", "error");
    appendLog("\nERROR:\n" + msg + "\n");
  } finally {
    btnChoose.disabled = false;
    btnTranscribe.disabled = false;
    progressEl.hidden = true;
  }
});

// Handle the "Choose File" button
btnChoose.addEventListener("click", async () => {
  transcriptEl.innerHTML = "";
  logEl.textContent = "";
  setStatus("Choosing file…", "info");

  audioPath = await otter.chooseAudioFile();
  if (!audioPath) {
    setStatus("No file selected.", "error");
    btnTranscribe.disabled = true;
    btnPlay.disabled = true;
    return;
  }

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

const specSelect = mustGetEl<HTMLSelectElement>("specSelect");
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
    opt.textContent = f;
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
const WORD_REGION_COLOR = getCssVar(
  waveDetailPane,
  "--word-region-color",
  "rgba(255, 200, 0, 0.35)"
);
