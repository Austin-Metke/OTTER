/**
 * preload.js
 *
 * OTTER Read-Only Prototype – Preload Script
 *
 * This file runs in Electron’s preload context and defines the *secure bridge*
 * between the renderer process (UI code) and the main process (Node.js / OS
 * integration). It is the ONLY place where renderer code is allowed controlled
 * access to privileged functionality.
 *
 * Architectural Role
 * ------------------
 * • Exposes a minimal, explicit API to the renderer via `window.otter`
 * • Prevents direct access to Node.js APIs from renderer.js
 * • Enforces a clear separation between UI logic and system-level operations
 *
 * All filesystem access, process execution (ffmpeg, transcription), and
 * native dialogs are handled by the main process and invoked here via IPC.
 *
 * This pattern follows Electron security best practices and mirrors how a
 * production application would safely structure renderer ↔ system boundaries.
 */

const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs");

/**
 * Read a file from disk and return its contents as an ArrayBuffer.
 *
 * This utility exists to support client-side libraries (e.g. WaveSurfer)
 * that expect binary data in ArrayBuffer form rather than Node Buffers.
 *
 * NOTE:
 * Direct filesystem access from the renderer is intentionally avoided;
 * this helper is exposed in a controlled way via the preload bridge.
 *
 * @param {string} filePath - Absolute path to the file on disk
 * @returns {Promise<ArrayBuffer>} File contents as an ArrayBuffer
 */
function readFileAsArrayBuffer(filePath) {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, (err, buf) => {
      if (err) return reject(err);

      // Convert Node Buffer to a true ArrayBuffer slice
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
      );
      resolve(ab);
    });
  });
}

/**
 * Expose a constrained API to the renderer process under `window.otter`.
 *
 * The renderer may call these functions but cannot directly access
 * Node.js primitives, the filesystem, or child processes.
 *
 * Each function corresponds to a specific IPC request handled in main.js.
 */
contextBridge.exposeInMainWorld("otter", {
  /**
   * Open a native file chooser dialog and return the selected audio file path.
   */
  chooseAudioFile: () => ipcRenderer.invoke("choose-audio-file"),

  /**
   * Request transcription of an audio file using the selected pipeline spec.
   *
   * @param {string} audioPath - Absolute path to the audio file
   * @param {Object} [spec] - Optional pipeline spec selection:
   *   - { mode: "file", name: "default_spec.json" }
   *   - { mode: "json", jsonText: "{...}" }
   *
   * @returns {Promise<Object>} Transcript data including word-level timings
   */
  transcribeAudio: (audioPath, spec) =>
    ipcRenderer.invoke("transcribe-audio", audioPath, spec),

  /**
   * Register a callback to receive transcription log messages.
   *
   * Used to surface progress and diagnostic output from the transcription
   * process in the renderer UI.
   *
   * @param {function(string): void} cb - Log message callback
   */
  onTranscribeLog: (cb) =>
    ipcRenderer.on("transcribe-log", (_, msg) => cb(msg)),

  /**
   * Probe an audio file for metadata (format, duration, sample rate, etc).
   *
   * Typically implemented via ffprobe in the main process.
   *
   * @param {string} audioPath - Absolute path to the audio file
   * @returns {Promise<Object>} Audio metadata
   */
  probeAudio: (audioPath) =>
    ipcRenderer.invoke("probe-audio", audioPath),

  /**
   * Register a callback to receive transcription progress updates.
   *
   * Progress values are expected to be integers in the range [0, 100].
   *
   * @param {function(number): void} cb - Progress callback
   */
  onTranscribeProgress: (cb) =>
    ipcRenderer.on("transcribe-progress", (_, pct) => cb(pct)),

  /**
   * Request creation of a short WAV snippet from a source audio file.
   *
   * This is used to build the detail waveform view around a selected word.
   *
   * @param {string} audioPath - Absolute path to the source audio
   * @param {number} startSec - Start time in seconds
   * @param {number} durSec   - Duration in seconds
   * @returns {Promise<string>} Path to the generated snippet file
   */
  makeSnippet: (audioPath, startSec, durSec) =>
    ipcRenderer.invoke("make-snippet", audioPath, startSec, durSec),

  /**
   * Read a file from disk and return it as an ArrayBuffer.
   *
   * Exposed for use by browser-oriented libraries that expect
   * ArrayBuffer input rather than file paths.
   */
  readFileAsArrayBuffer,

  /**
   * List available pipeline spec files (all *.json under otter_py/sample_specs).
   *
   * @returns {Promise<string[]>} Array of spec file names (e.g. ["default_spec.json", ...])
   */
  listSpecFiles: () =>
    ipcRenderer.invoke("list-spec-files"),

  /**
   * Read a pipeline spec file from otter_py/sample_specs by name.
   *
   * @param {string} name - Spec filename (e.g. "default_spec.json")
   * @returns {Promise<string>} The raw JSON text of the spec file
   */
  readSpecFile: (name) =>
    ipcRenderer.invoke("read-spec-file", name),

  /**
   * Convenience: fetch the default pipeline spec text.
   *
   * @returns {Promise<string>}
   */
  readDefaultSpec: () =>
    ipcRenderer.invoke("read-spec-file", "default_spec.json"),

});