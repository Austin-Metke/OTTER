/**
 * main.ts
 *
 * OTTER Read-Only Prototype – Main Process
 *
 * This file runs in Electron’s main process and owns all privileged / OS-level
 * operations for the prototype. The renderer (UI) never accesses Node.js APIs
 * directly; instead, it calls a small set of IPC endpoints exposed by preload.ts,
 * which are implemented here.
 *
 * Responsibilities
 * ---------------
 * • Create and manage the application window (BrowserWindow)
 * • Handle native OS UI such as “Choose File…” dialogs
 * • Run local command-line tools (ffprobe / ffmpeg) for media inspection & slicing
 * • Spawn the local transcription process (Python + Whisper) and stream logs/progress
 * • Return results to the renderer via IPC (promises + event messages)
 *
 * Security Model
 * --------------
 * The BrowserWindow is created with:
 *   • contextIsolation: true
 *   • nodeIntegration: false
 * so the renderer cannot directly import Node modules. Any access to the
 * filesystem or child processes is intentionally centralized in this file.
 *
 * Prototype Note (macOS behavior)
 * -------------------------------
 * For demo simplicity, we quit the app when the last window closes on macOS.
 * (macOS apps normally remain running with zero windows.)
 */

import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";

type TranscribeSpec =
  | { mode: "file"; name: string }
  | { mode: "json"; jsonText: string };

type EdlEntry = {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  label: string;
  muted: boolean;
};

type Edl = {
  version: 1;
  sourceFile: string;
  entries: EdlEntry[];
  createdAt: string;
  modifiedAt: string;
};

let win: BrowserWindow | null = null;
const repoRoot = path.join(__dirname, "..");

/**
 * Create the main application window and load the UI.
 *
 * The window is configured with a preload script that exposes a limited,
 * explicit API to the renderer via `window.otter`.
 */
function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(repoRoot, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  win.loadFile(path.join(repoRoot, "index.html"));
}

/**
 * App lifecycle:
 * Create the initial window when Electron is ready, set the dock icon on macOS,
 * and recreate a window when the user re-activates the app (macOS convention).
 */
app.whenReady().then(() => {
  createWindow();
  app.dock?.setIcon(path.join(repoRoot, "assets", "icon.png"));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// For this prototype, we quit the app when the window closes.
// macOS normally keeps apps running without windows, but that
// behavior is intentionally disabled here for demo simplicity.
app.on("window-all-closed", () => {
  app.quit();
});

/**
 * IPC: Show a native file picker and return the selected audio file path.
 *
 * This prototype intentionally restricts selection to .wav to keep the demo
 * pipeline simple and avoid format compatibility issues in the waveform UI.
 *
 * @returns {Promise<string|null>} Absolute path to the chosen file, or null if canceled.
 */
ipcMain.handle("choose-audio-file", async () => {
  const options: OpenDialogOptions = {
    title: "Choose an audio file",
    properties: ["openFile"],
    filters: [
      { name: "Audio", extensions: ["wav"] },
      { name: "All Files", extensions: ["*"] }
    ]
  };

  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * IPC: Probe an audio file for metadata using ffprobe.
 *
 * Currently we extract:
 *   • stream start_time (some formats introduce a non-zero start offset)
 *   • sample_rate
 *
 * This can be used to diagnose seeking/timestamp alignment issues.
 *
 * @param {string} inputPath - Absolute path to the input audio file.
 * @returns {Promise<{start_time:number, sample_rate:(number|null)}>}
 */
ipcMain.handle("probe-audio", async (_event: IpcMainInvokeEvent, inputPath: string) => {
  const args = [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=start_time,sample_rate",
    "-of", "json",
    inputPath
  ];

  const child = spawn("ffprobe", args);
  let out = "", err = "";

  return await new Promise((resolve, reject) => {
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe failed (${code})\n${err}`));
      try {
        const json = JSON.parse(out);
        const s = json.streams?.[0] || {};
        resolve({
          start_time: s.start_time != null ? Number(s.start_time) : 0,
          sample_rate: s.sample_rate != null ? Number(s.sample_rate) : null
        });
      } catch (e) {
        reject(e);
      }
    });
  });
});

/**
 * IPC: Transcribe an audio file by spawning a local Python script (Whisper-based).
 *
 * The Python script writes the final transcript as JSON to stdout. We also stream
 * log output to the renderer so the UI can display progress and diagnostics.
 *
 * Progress convention:
 *   The script may emit lines like: "PROGRESS 37" to stderr, which we parse and
 *   forward to the renderer as a numeric percentage.
 *
 * Virtual environment support:
 *   If a local .venv exists, we prefer its python binary; otherwise we fall back
 *   to "python3" on PATH (developer environment).
 *
 * @param {string} audioPath - Absolute path to the audio file to transcribe.
 * @returns {Promise<Object>} Parsed transcript JSON emitted by the python script.
 */
ipcMain.handle(
  "transcribe-audio",
  async (
    event: IpcMainInvokeEvent,
    audioPath: string,
    spec?: TranscribeSpec
  ) => {
  function getPythonPath() {
    const venvPython = path.join(repoRoot, ".venv", "bin", "python3");
    if (fs.existsSync(venvPython)) return venvPython;
    return "python3";
  }

  // Run from the repo root so "python -m otter_py.transcribe" works.
  const cwd = repoRoot;

  // Build argv for: python -m otter_py.transcribe run --audio ... --spec-...
  const python = getPythonPath();
  const argv = ["-m", "otter_py.transcribe", "run", "--audio", audioPath];

  // Choose spec source
  if (spec?.mode === "file") {
    // All presets live here; only pass a filename from renderer for safety.
    const specPath = path.join(repoRoot, "otter_py", "sample_specs", spec.name);
    argv.push("--spec-file", specPath);
  } else if (spec?.mode === "json") {
    argv.push("--spec-json", spec.jsonText);
  } else {
    // Default: use default_spec.json
    const specPath = path.join(repoRoot, "otter_py", "sample_specs", "default_spec.json");
    argv.push("--spec-file", specPath);
  }

  // Optional: if you want meta sometimes
  // argv.push("--emit-meta");

  return await new Promise((resolve, reject) => {
    const child = spawn(python, argv, { cwd });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
    });

    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;

      // Parse progress lines of the form "PROGRESS:NN"
      // (Allow multiple lines in a single chunk.)
      for (const line of s.split(/\r?\n/)) {
        const m = line.match(/^PROGRESS:(\d{1,3})\s*$/);
        if (m) event.sender.send("transcribe-progress", Number(m[1]));
        else if (line.trim()) event.sender.send("transcribe-log", line + "\n");
      }
    });

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`transcribe exited with ${code}\n${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        reject(new Error(`Failed to parse JSON from transcribe:\n${stdout}\n\n${stderr}\n${msg}`));
      }
    });
  });
});


ipcMain.handle("list-spec-files", async () => {
  const dir = path.join(repoRoot, "otter_py", "sample_specs");
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".json"))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  return files;
});

ipcMain.handle("read-spec-file", async (_event: IpcMainInvokeEvent, name: string) => {
  const dir = path.join(repoRoot, "otter_py", "sample_specs");

  // Safety: prevent path traversal ("../../etc/passwd")
  const safeName = path.basename(name);
  if (safeName !== name) {
    throw new Error("Invalid spec file name");
  }

  const fullPath = path.join(dir, safeName);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Spec file not found: ${safeName}`);
  }

  return fs.readFileSync(fullPath, "utf-8");
});

/**
 * Shared helper: run an ffmpeg command and return a promise.
 *
 * Used by make-snippet and export-edl-audio to avoid duplicating the
 * spawn-and-wait pattern.
 */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err}`));
    });
  });
}

/**
 * IPC: Create a short WAV snippet from a source audio file using ffmpeg.
 *
 * This is used to build a “detail waveform” view around a selected word. The
 * snippet is written as PCM WAV to ensure predictable decoding and precise
 * seeking in the browser-based audio element that WaveSurfer uses.
 *
 * Snippets are stored under app.getPath("userData") so they work in both
 * development and packaged runs.
 *
 * @param {string} audioPath - Absolute path to the source audio
 * @param {number} startSec  - Snippet start time (seconds)
 * @param {number} durSec    - Snippet duration (seconds)
 * @returns {Promise<string>} Absolute path to the generated snippet WAV
 */
ipcMain.handle(
  "make-snippet",
  async (
    _event: IpcMainInvokeEvent,
    audioPath: string,
    startSec: number,
    durSec: number
  ) => {
  // Store snippets in a temp-ish folder that exists for packaged/dev
  const outDir = path.join(app.getPath("userData"), "snippets");
  fs.mkdirSync(outDir, { recursive: true });

  // Clamp inputs to reasonable values to avoid invalid ffmpeg args
  const safeStart = Math.max(0, Number(startSec) || 0);
  const safeDur = Math.max(0.05, Number(durSec) || 0.05);

  // unique-ish filename
  const outPath = path.join(
    outDir,
    `snippet_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wav`
  );

  // ffmpeg: extract small WAV segment (PCM)
  const args = [
    "-hide_banner",
    "-y",
    "-ss", String(safeStart),
    "-t", String(safeDur),
    "-i", audioPath,
    "-c:a", "pcm_s16le",
    outPath
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);

    let err = "";
    child.stderr.on("data", (d: Buffer) => err += d.toString());
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed (${code}): ${err}`));
    });
  });

  return outPath;
});

// =============================================================================
// EDL: Save / Load / Export
// =============================================================================

/**
 * IPC: Save an EDL to disk.
 *
 * Opens a native save dialog and writes the EDL JSON to the chosen path.
 *
 * @param {string} edlJson - Serialized EDL JSON string
 * @returns {Promise<string|null>} Absolute path to saved file, or null if canceled
 */
ipcMain.handle("save-edl", async (_event: IpcMainInvokeEvent, edlJson: string) => {
  const options = {
    title: "Save EDL",
    defaultPath: "untitled.otter-edl.json",
    filters: [
      { name: "OTTER EDL", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };

  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) return null;

  fs.writeFileSync(result.filePath, edlJson, "utf-8");
  return result.filePath;
});

/**
 * IPC: Load an EDL from disk.
 *
 * Opens a native file picker, reads the chosen JSON file, and returns its
 * path and raw content so the renderer can restore editing state.
 *
 * @returns {Promise<{path: string, content: string}|null>}
 */
ipcMain.handle("load-edl", async () => {
  const options: OpenDialogOptions = {
    title: "Load EDL",
    properties: ["openFile"],
    filters: [
      { name: "OTTER EDL", extensions: ["json"] },
      { name: "All Files", extensions: ["*"] },
    ],
  };

  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const content = fs.readFileSync(filePath, "utf-8");
  return { path: filePath, content };
});

/**
 * IPC: Export audio from an EDL by concatenating non-muted segments.
 *
 * Builds an ffmpeg filter_complex that trims each non-muted segment from the
 * source audio and concatenates them into a single output file. The original
 * audio is only read, never modified.
 *
 * @param {string} edlJson - Serialized EDL JSON string
 * @returns {Promise<string|null>} Absolute path to exported file, or null if canceled
 */
ipcMain.handle("export-edl-audio", async (_event: IpcMainInvokeEvent, edlJson: string) => {
  const edl: Edl = JSON.parse(edlJson);
  const entries = (edl.entries || []).filter((e) => !e.muted);

  if (entries.length === 0) {
    throw new Error("No non-muted segments to export.");
  }

  const options = {
    title: "Export Audio",
    defaultPath: "export.wav",
    filters: [
      { name: "WAV Audio", extensions: ["wav"] },
    ],
  };

  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) return null;

  // Build ffmpeg filter_complex:
  //   [0]atrim=start=S0:end=E0,asetpts=PTS-STARTPTS[a0];
  //   [0]atrim=start=S1:end=E1,asetpts=PTS-STARTPTS[a1];
  //   [a0][a1]concat=n=2:v=0:a=1[out]
  const sourceFile = edl.sourceFile;
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    filterParts.push(
      `[0]atrim=start=${e.sourceStart}:end=${e.sourceEnd},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[a${i}]`);
  }

  const filterComplex =
    filterParts.join("; ") +
    "; " +
    concatInputs.join("") +
    `concat=n=${entries.length}:v=0:a=1[out]`;

  const args = [
    "-hide_banner",
    "-y",
    "-i", sourceFile,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "pcm_s16le",
    result.filePath,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args);
    let err = "";
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg export failed (${code}): ${err}`));
    });
  });

  return result.filePath;
});


