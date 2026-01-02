/**
 * renderer.js
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
 * surface*: clicking on text seeks the audio, and playback updates the active word.
 *
 * Architectural Notes
 * -------------------
 * • The renderer does NOT access the filesystem or spawn processes directly.
 *   All privileged operations (file selection, ffmpeg, transcription) are
 *   delegated to the main process via IPC exposed through preload.js.
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

//
// UI elements
//
const btnChoose = document.getElementById("btnChoose");
const btnTranscribe = document.getElementById("btnTranscribe");
const btnPlay = document.getElementById("btnPlay");
const transcriptEl = document.getElementById("transcript");
const statusEl = document.getElementById("status");
const progressEl = document.getElementById("transcribeProgress");
const timeEl = document.getElementById("time");
const logEl = document.getElementById("log");
const btnToggleLog = document.getElementById("btnToggleLog");
const logContainer = document.getElementById("logContainer");
const btnDetailPlay = document.getElementById("btnDetailPlay");
const waveDetailPane = document.getElementById("waveDetailPane");
const detailTimeEl = document.getElementById("detailTime");
const btnRegion = document.getElementById("btnRegion");
const WaveSurfer = window.WaveSurfer;

//
// Constants
//
const SEEK_EPS = 0.01;
const DETAIL_PAD_BEFORE = 0.25; // seconds
const DETAIL_PAD_AFTER  = 0.25; // seconds

//
// Global State
//
let detailRegion = null;
let audioPath = null;
let words = [];

//
// Utility Functions
//
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function getCssVar(el, name, fallback) {
  if (!el) return fallback;
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

function setStatus(text, cls = "info") {
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


//==============================================================================
//
// BEGIN: Primary rendering logic
//
//==============================================================================

/**
 * Update the visual "active" state of the transcript to reflect the
 * currently selected or playing word.
 *
 * This function removes the active highlight from any previously
 * highlighted word and applies it to the word at the specified index.
 * An index of -1 clears the highlight entirely.
 *
 * The transcript DOM uses a simple data-index attribute to associate
 * each rendered word span with its position in the transcript array.
 *
 * @param {number} idx - Index of the word to mark as active, or -1 to clear
 *                       the active selection.
 */
function setActiveIndex(idx) {
  const prev = transcriptEl.querySelector(".word.active");
  if (prev) prev.classList.remove("active");

  if (idx >= 0) {
    const el = transcriptEl.querySelector(`.word[data-index="${idx}"]`);
    if (el) el.classList.add("active");
  }
}


// Compute a small snippet window around a word boundary.
// This keeps the detail waveform focused on just the selected word plus context.
function computeDetailWindow(start, end) {
  const winStart = Math.max(0, start - DETAIL_PAD_BEFORE);
  const winEnd = Math.max(winStart + 0.05, end + DETAIL_PAD_AFTER); // enforce minimum duration
  return { winStart, winEnd, winDur: winEnd - winStart };
}

/**
 * Load/update the detail waveform for a selected word.
 *
 * Steps:
 *   1) Extract a short WAV snippet around the word using ffmpeg (via IPC).
 *   2) Load the snippet into the detail WaveSurfer instance.
 *   3) Create/update a region highlighting the word inside that snippet.
 *   4) Seek the detail playhead to the start of the word.
 *
 * The detail view exists to demonstrate that ASR word boundaries are approximate
 * and that precise editing may require user refinement.
 */
async function loadDetailForWord(start, end) {
  const { winStart, winDur } = computeDetailWindow(start, end);

  // Create a short WAV snippet around the selected word (main process uses ffmpeg)
  const snippetPath = await window.otter.makeSnippet(audioPath, winStart, winDur);

  // If the detail waveform is currently playing, stop it before swapping media
  if (wsDetail.isPlaying()) wsDetail.pause();

  // Enable/show detail UI now that detail audio exists
  waveDetailPane.hidden = false;
  btnDetailPlay.disabled = false;
  btnRegion.disabled = false;
  setDetailPlayIcon(false);

  // Map the word's absolute times into snippet-local times
  const localWordStart = start - winStart;
  const localWordEnd = end - winStart;

  // Attach the handler BEFORE calling load() to avoid missing "ready" in fast loads
  wsDetail.once("ready", () => {
    setDetailWordRegion(localWordStart, localWordEnd);
    wsDetail.setTime(localWordStart);
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
 *   • Marks the word as active in the transcript UI
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
function renderTranscript(words) {
  transcriptEl.innerHTML = "";

  for (let i = 0; i < words.length; i++) {
    const w = words[i];

    const span = document.createElement("span");
    span.className = "word";
    span.textContent = w.word + " ";
    span.dataset.index = String(i);

    span.addEventListener("click", async () => {
      // Transcript click = select word + seek main audio
      setActiveIndex(i);
      ws.setTime(Number(w.start) + SEEK_EPS);

      // Load the detail waveform snippet centered on this word
      const start = Number(w.start);
      const end = Number(w.end);

      try {
        await loadDetailForWord(start, end);
      } catch (err) {
        console.error("Failed to load detail snippet:", err);
      }
    });

    transcriptEl.appendChild(span);
  }
}

//==============================================================================
//
// BEGIN: Objects and code related to the Wave Pane
//
//==============================================================================

// Switch between play and pause icons
function setPlayIcon(isPlaying) {
  btnPlay.textContent = isPlaying ? "⏸︎" : "▶︎";
  btnPlay.title = isPlaying ? "Pause" : "Play";
  btnPlay.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
}

// Create the waveform visualization object
const ws = WaveSurfer.create({
  container: "#waveform",
  height: 220,
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
ws.on("timeupdate", (t) => {
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
  setActiveIndex(idx);
});


//==============================================================================
//
// BEGIN: Objects and code related to the Wave Detail Pane
//
//==============================================================================

// Create a Regions plugin instance to manage editable time ranges
const detailRegions = WaveSurfer.Regions.create();

// Create the detail region visualization object
const wsDetail = WaveSurfer.create({
  container: "#waveDetail",
  height: 80,
  plugins: [detailRegions]
});

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
function setDetailWordRegion(localStart, localEnd) {
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
}

// Handle the "Play Region" button being pressed
btnRegion.addEventListener("click", () => {
  if (detailRegion) {
    wsDetail.play(detailRegion.start, detailRegion.end);
  }
});


// Update the time readout for the detail waveform during playback.
// This reflects the current playhead position within the snippet,
// not the absolute time in the source audio.
wsDetail.on("timeupdate", (t) => {
  if (detailTimeEl) detailTimeEl.textContent = `${t.toFixed(2)}s`;
});

// Keep the Play Region button in sync with the status of region playback
wsDetail.on("play", () => setDetailPlayIcon(true));
wsDetail.on("pause", () => setDetailPlayIcon(false));
wsDetail.on("finish", () => setDetailPlayIcon(false));

// handle the "Play Region" button
btnDetailPlay.addEventListener("click", () => wsDetail.playPause());

// Adjust the icon in the "Play Detail" button
function setDetailPlayIcon(isPlaying) {
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
    const result = await window.otter.transcribeAudio(audioPath);
    words = result.words || [];
    setStatus(`Transcript ready (${words.length} words, lang=${result.language})`, "success");
    renderTranscript(words);
  } catch (e) {
    setStatus("Transcription failed (see logs).", "error");
    appendLog("\nERROR:\n" + (e?.message || String(e)) + "\n");
  } finally {
    btnTranscribe.disabled = false;
    progressEl.hidden = true;
    btnChoose.disabled = false;
    btnTranscribe.disabled = false;
  }
});

// Handle the "Choose File" button
btnChoose.addEventListener("click", async () => {
  transcriptEl.innerHTML = "";
  logEl.textContent = "";
  setStatus("Choosing file…", "info");

  audioPath = await window.otter.chooseAudioFile();
  if (!audioPath) {
    setStatus("No file selected.", "error");
    btnTranscribe.disabled = true;
    btnPlay.disabled = true;
    return;
  }

  setStatus(`Loaded: ${audioPath.split("/").pop()}`, "success");
  setPlayIcon(false);
  btnTranscribe.disabled = false;

  // Load waveform from local file bytes via preload bridge
  const ab = await window.otter.readFileAsArrayBuffer(audioPath);
  const blob = new Blob([ab]);
  await ws.loadBlob(blob);

  btnPlay.disabled = false;
});


//==============================================================================
//
// BEGIN: Objects and code related to Logging
//
//==============================================================================

// Add the message to the log area
function appendLog(msg) {
  logEl.textContent += msg;
  logEl.scrollTop = logEl.scrollHeight;
}

// We've received a normal log message
window.otter.onTranscribeLog((msg) => appendLog(msg));

// We've received a progress report from the transcirption engine
window.otter.onTranscribeProgress((pct) => {
  progressEl.value = pct;
  progressEl.hidden = false;
  statusEl.textContent = "Transcribing…";
});

// Show/hide the log area based on a button press
btnToggleLog.addEventListener("click", () => {
  const showing = !logContainer.hasAttribute("hidden");
  logContainer.toggleAttribute("hidden");
  btnToggleLog.textContent = showing ? "Show Log" : "Hide Log";
});

