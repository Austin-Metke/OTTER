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
import path, { resolve } from "path";
import fs from "fs";
import { spawn, spawnSync, ChildProcess} from "child_process";

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

/**
 * Control messages that (in the long-lived worker mode) can be sent to the Python
 * transcription process over stdin as line-delimited JSON.
 *
 */
type TranscriptionControlCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "ping" };

/**
 * Managed child process used for transcription.
 *
 * We attach small bits of UI-facing state to the Node ChildProcess object so we can:
 * - guard against overlapping transcriptions (`activeProcess`)
 * - interpret stderr control lines (paused/resumed/cancelling)
 * - short-circuit resolution as `{ cancelled: true }` on cancellation
 */
type ManagedTranscriptionProcess = ChildProcess & {
  otterState?: "running" | "paused" | "cancelling"| "pause-requested";
  otterCancelled?: boolean;
};

let win: BrowserWindow | null = null;
let activeProcess: ManagedTranscriptionProcess | null = null;
const repoRoot = path.join(__dirname, "..");
const AUDIO_EXTS = new Set([".wav", ".mp3", ".m4a", ".flac", ".ogg", ".webm"]);



function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

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

//==========================================================================

function assertSafeAudioPath(inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.includes("\0")) {
    throw new Error("Invalid audio path");
  }

  const resolved = path.resolve(inputPath);
  const ext = path.extname(resolved).toLowerCase();

  if (!AUDIO_EXTS.has(ext)) {
    throw new Error("Unsupported audio file type");
  }

  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) {
    throw new Error("Audio path is not a file");
  }

  return resolved;
}

function assertSafeSegment(start: unknown, end: unknown) {
  const s = Number(start);
  const e = Number(end);

  if (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s) {
    throw new Error("Invalid EDL segment");
  }

  if (e - s > 60 * 10) {
    throw new Error("Preview segement too long");
  }

  return { start: s, end: e };
}

//==========================================================================

function extractAudioSection( audioPath: string, start:number, end: number){
  //assert the segment is safe to use prior to resolving
    const seg = assertSafeSegment(start,end);
    const duration = seg.end - seg.start;

    return new Promise<Buffer>((resolve,reject)=> {

      const args = [
        "-hide_banner",
        "-loglevel", "error",
        "-ss", String(seg.start),
        "-i",audioPath,
        "-t", String(duration),
        "-f" , "wav",
        "pipe:1",
      ];

    const ff = spawn("ffmpeg", args);

    if(!ff.stdout || !ff.stderr){
      reject(new Error("ffmpeg did not expose stdout/stderr"));
      return;
    }

    const chunks: Buffer[]= [];
    let stderr = "";

    ff.stdout.on("data",chunk => chunks.push(chunk));
    ff.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    ff.on("error", reject);

    ff.on("close", code =>{
      if( code === 0 )resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited with ${code}: ${stderr}`));
    }
    );
  });
}

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
      { name: "Audio", extensions: ["wav","mp3","m4a"] }
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
  const audioPath = assertSafeAudioPath(inputPath);

  const args = [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=start_time,sample_rate",
    "-of", "json",
    audioPath
  ];

  const child = spawn("ffprobe", args);
  let out = "", err = "";

  return await new Promise((resolve, reject) => {
    child.stdout.on("data", d => out += d.toString());
    child.stderr.on("data", d => err += d.toString());
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
         reject(new Error(`ffprobe failed (${code})\n${err}`));
        return;
      }
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
 * Resolve the Python interpreter used for transcription.
 *
 * Order of preference:
 * - Explicit environment override (OTTER_PYTHON / OTTER_PYTHON_PATH / PYTHON_EXECUTABLE)
 * - The currently activated venv (VIRTUAL_ENV)
 * - Repo-local `.venv`
 * - PATH fallback (python3/python)
 *
 * We also validate candidates by attempting to import `otter_py.transcribe`.
 */
function getPythonPath() {
  // Allow explicit override (recommended) so Electron uses the same interpreter
  // as your working CLI setup.
  const override =
    process.env.OTTER_PYTHON ??
    process.env.OTTER_PYTHON_PATH ??
    process.env.PYTHON_EXECUTABLE;
  if (override) return override;

  const candidates: string[] = [];

  // If Electron was launched from an activated venv, use it.
  const activeVenv = process.env.VIRTUAL_ENV;
  if (activeVenv) {
    const venvPython = process.platform === "win32"
      ? path.join(activeVenv, "Scripts", "python.exe")
      : path.join(activeVenv, "bin", "python3");
    if (fs.existsSync(venvPython)) candidates.push(venvPython);
  }

  // Prefer repo-local venv if present.
  const repoVenvPython =
    process.platform === "win32"
      ? path.join(repoRoot, ".venv", "Scripts", "python.exe")
      : path.join(repoRoot, ".venv", "bin", "python3");
  if (fs.existsSync(repoVenvPython)) candidates.push(repoVenvPython);

  // Fallback: try common commands on PATH.
  if (process.platform === "win32") {
    candidates.push("python3", "python");
  } else {
    candidates.push("python3", "python");
  }

  // Pick the first interpreter that can import our module.
  for (const candidate of candidates) {
    try {
      // Skip invalid absolute paths early.
      if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;

      const res = spawnSync(
        candidate,
        [
          "-c",
          'import importlib; importlib.import_module("otter_py.transcribe")',
        ],
        { cwd: repoRoot, stdio: "ignore", timeout: 3000 }
      );

      if (res.status === 0) return candidate;
    } catch {
      // ignore and try next candidate
    }
  }

  // Final fallback (will likely fail with a clear error in transcribe-audio).
  return candidates[candidates.length - 1] ?? "python3";
}

/**
 * 
 */
function sendControlCommand(
  proc: ManagedTranscriptionProcess,
  cmd: TranscriptionControlCommand
): boolean {
  if (!proc.stdin || proc.stdin.destroyed || !proc.pid) return false;

  try {
    const payload = JSON.stringify(cmd) + "\n";
    proc.stdin.write(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * 
 */
function terminateProcess(proc: ManagedTranscriptionProcess): boolean {
  try {
    const ok = proc.kill();
    return ok;
  } catch {
    return false;
  }
}

function directoryHasFiles(dir: string): boolean {
  try {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Default faster-whisper / WhisperX weight directory when the user did not set
 * OTTER_WHISPERX_DOWNLOAD_ROOT. Prefer an existing non-empty cache (AppData from
 * older OTTER builds, or .cache/huggingface/whisperx) so we do not point at an
 * empty folder and force a multi‑GB re-download.
 */
function defaultWhisperxDownloadRoot(userHf: string, hasUserHf: boolean, userDataWx: string): string {
  if (!hasUserHf) return userDataWx;
  const underHf = path.join(userHf, "whisperx");
  if (directoryHasFiles(underHf)) return underHf;
  if (directoryHasFiles(userDataWx)) return userDataWx;
  return underHf;
}

/**
 * Env passed to the persistent Python worker so Hugging Face / WhisperX on-disk
 * caches match a typical CLI install: prefer %USER%\.cache\huggingface when it
 * exists, otherwise use AppData. Explicit OTTER_* / HF_* env always wins.
 */
function buildPythonWorkerEnv(): { env: typeof process.env; logLine: string } {
  const home = app.getPath("home");
  const userData = app.getPath("userData");
  const userHf = path.join(home, ".cache", "huggingface");
  const hasUserHf = fs.existsSync(userHf);
  const userDataHf = path.join(userData, "hf_home");
  const userDataWx = path.join(userData, "whisperx_download");

  const hfHomeExplicit = Boolean(process.env.OTTER_HF_HOME || process.env.HF_HOME);

  const hfHome =
    process.env.OTTER_HF_HOME ||
    process.env.HF_HOME ||
    (hasUserHf ? userHf : userDataHf);

  const huggingfaceHubCache =
    process.env.HUGGINGFACE_HUB_CACHE ||
    (!hfHomeExplicit && hasUserHf ? path.join(userHf, "hub") : undefined);

  const transformersCache =
    process.env.TRANSFORMERS_CACHE ||
    (!hfHomeExplicit && hasUserHf ? path.join(userHf, "transformers") : undefined);

  const wxRoot =
    process.env.OTTER_WHISPERX_DOWNLOAD_ROOT ||
    process.env.WHISPERX_DOWNLOAD_ROOT ||
    defaultWhisperxDownloadRoot(userHf, hasUserHf, userDataWx);

  for (const p of [hfHome, huggingfaceHubCache, transformersCache, wxRoot]) {
    if (p) {
      try {
        if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      } catch {
        // best-effort; Python may still fail with a clear error
      }
    }
  }

  const env: typeof process.env = {
    ...process.env,
    PYTHONUNBUFFERED: "1",
    HF_HOME: hfHome,
    OTTER_WHISPERX_DOWNLOAD_ROOT: wxRoot,
    HF_HUB_DISABLE_TELEMETRY: process.env.HF_HUB_DISABLE_TELEMETRY ?? "1",
  };
  if (huggingfaceHubCache) env.HUGGINGFACE_HUB_CACHE = huggingfaceHubCache;
  if (transformersCache) env.TRANSFORMERS_CACHE = transformersCache;

  const logLine =
    `INFO:HF_HOME=${hfHome} | HUGGINGFACE_HUB_CACHE=${huggingfaceHubCache ?? "(unset)"} | ` +
    `TRANSFORMERS_CACHE=${transformersCache ?? "(unset)"} | OTTER_WHISPERX_DOWNLOAD_ROOT=${wxRoot}\n`;
  return { env, logLine };
}

/**
 * IPC: Transcribe an audio file by spawning a local Python script (Whisper-based).
 *
 * Contract with Python (`otter_py.transcribe run`):
 * - **STDOUT**: one terminal JSON object (either words[] or {words, language/meta} depending on flags).
 * - **STDERR**: human-readable logs + structured progress lines: `PROGRESS:<0-100>`.
 * - **Cancellation**: if the process is terminated, we resolve `{ cancelled: true }` as long
 *   as we can detect cancellation state (either by explicit marker or by our own cancel flag).
 *
 * Why this separation matters:
 * - The renderer expects STDOUT to be parseable JSON with no extra chatter.
 * - Any library output that might be noisy should go to STDERR on the Python side.
 *
 * Progress convention:
 *   The script emits lines like: `PROGRESS:37` to stderr, which we parse and forward to the renderer.
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
    if (activeProcess) {
      throw new Error("A transcription is already running.");
    }
    event.sender.send("transcribe-progress", 0);

    // Resolve spec for worker message
    let specFile: string | undefined;
    let specJson: string | undefined;
    if (spec?.mode === "file") {
      const safeName = path.basename(spec.name);
      if (safeName !== spec.name) {
        throw new Error("Invalid spec file name");
      }
      specFile = path.join(repoRoot, "otter_py", "sample_specs", safeName);
    } else if (spec?.mode === "json") {
      specJson = spec.jsonText;
    } else {
      specFile = path.join(repoRoot, "otter_py", "sample_specs", "default_spec.json");
    }
    const safeAudioPath =  assertSafeAudioPath(audioPath);

    const { env, logLine: workerCacheLog } = buildPythonWorkerEnv();
    event.sender.send(
      "transcribe-log",
      `INFO:PythonWorker=enabled | Audio=${safeAudioPath}\n` + workerCacheLog
    );

    const python = getPythonPath();
    const argv = ["-m", "otter_py.transcribe", "run", "--audio", safeAudioPath];
    if (specFile) argv.push("--spec-file", specFile);
    if (specJson) argv.push("--spec-json", specJson);

    const child = spawn(python, argv, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    }) as ManagedTranscriptionProcess;

    activeProcess = child;
    child.otterState = "running";
    child.otterCancelled = false;
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (!childStdout || !childStderr) {
      activeProcess = null;
      throw new Error("Transcription process did not expose stdout/stderr pipes.");
    }

    return await new Promise((resolve, reject) => {
      let stdoutBuf = "";
      let stderrLineBuf = "";
      let settled = false;
      let gotTerminalJson = false;
      let lastStderrLine = "";

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (activeProcess === child) activeProcess = null;
        fn();
      };

      const handleStderrLine = (rawLine: string) => {
        const line = rawLine.replace(/\r$/, "").trim();
        if (!line) return;
        lastStderrLine = line;

        const progressMatch = line.match(/^PROGRESS:(\d{1,3})\s*$/);
        if (progressMatch) {
          event.sender.send("transcribe-progress", Number(progressMatch[1]));
          return;
        }
        if (line === "CONTROL:PAUSED") {
          child.otterState = "paused";
          event.sender.send("transcribe-state", { state: "paused" });
          return;
        }
        if (line === "CONTROL:RESUMED") {
          child.otterState = "running";
          event.sender.send("transcribe-state", { state: "running" });
          return;
        }
        if (line === "CONTROL:CANCELLING") {
          child.otterState = "cancelling";
          event.sender.send("transcribe-state", { state: "cancelling" });
          return;
        }
        event.sender.send("transcribe-log", line + "\n");
      };

      childStderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderrLineBuf += chunk;
        let nl: number;
        while ((nl = stderrLineBuf.indexOf("\n")) >= 0) {
          const line = stderrLineBuf.slice(0, nl);
          stderrLineBuf = stderrLineBuf.slice(nl + 1);
          handleStderrLine(line);
        }
        if (stderrLineBuf.length > 256 * 1024) {
          stderrLineBuf = stderrLineBuf.slice(-64 * 1024);
        }
      });

      childStdout.on("data", (d: Buffer) => {
        stdoutBuf += d.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;

          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            gotTerminalJson = true;

            if (parsed.error === "Cancelled") {
              finish(() => resolve({ cancelled: true }));
              return;
            }
            if (typeof parsed.error === "string") {
              const message =
                typeof parsed.message === "string" && parsed.message.trim()
                  ? parsed.message
                  : parsed.error;
              finish(() => reject(new Error(message)));
              return;
            }

            finish(() => resolve(parsed));
            return;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            finish(() => reject(new Error(`Failed to parse transcription JSON: ${msg}\n${line}`)));
            return;
          }
        }
      });

      child.on("error", (err) => {
        finish(() => reject(err));
      });

      child.on("close", (code, signal) => {
        if (stderrLineBuf.trim()) handleStderrLine(stderrLineBuf);
        if (gotTerminalJson) return;
        if (child.otterCancelled || lastStderrLine === "CONTROL:CANCELLING") {
          finish(() => resolve({ cancelled: true }));
          return;
        }

        const detail = lastStderrLine ? `\nLast log: ${lastStderrLine}` : "";
        finish(() =>
          reject(
            new Error(
              `Worker process exited (code=${code ?? "null"}, signal=${signal ?? "none"})${detail}`
            )
          )
        );
      });
    });
  });

ipcMain.handle("pause-transcription", async () => {
  if(!activeProcess) return {ok: false};

  activeProcess.otterState = "pause-requested";
  sendControlCommand(activeProcess,{type:"pause"});

  return {ok : true}
});

ipcMain.handle("resume-transcription", async () => {
  if(!activeProcess) return {ok: false};

  activeProcess.otterState = "running";
  sendControlCommand(activeProcess,{type: "resume"});

  return{ok: true};
});

/**
 * 
 */
ipcMain.handle("cancel-transcription", async () => {
  if (!activeProcess) return {ok: false};

  activeProcess.otterCancelled = true;
  activeProcess.otterState = "cancelling";
  sendControlCommand(activeProcess, {type: "cancel"});

  setTimeout(()=> {
    if(activeProcess && !activeProcess.killed){
      terminateProcess(activeProcess);
    }

  }, 3000);
  return {ok: true};
});

ipcMain.handle("get-transcription-state", async () => {
  if (!activeProcess) return { active: false, state: "idle" };
  return {
    active: true,
    state: activeProcess.otterState ?? "running"
  };
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
 *
 * Failure mode:
 * - Rejects with stderr output included; callers should surface this to the renderer log/status.
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

// =============================================================================
// Mic recording: save + convert to WAV
// =============================================================================

ipcMain.handle(
  "save-mic-recording",
  async (_event: IpcMainInvokeEvent, data: Buffer, mimeType: string) => {
    const recDir = path.join(app.getPath("userData"), "recordings");
    ensureDir(recDir);

    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const mt = (mimeType || "").toLowerCase();
    const ext =
      mt.includes("ogg") ? "ogg" :
      mt.includes("webm") ? "webm" :
      mt.includes("wav") ? "wav" :
      "webm";

    const rawPath = path.join(recDir, `mic_${stamp}.${ext}`);
    fs.writeFileSync(rawPath, data);

    const wavPath = path.join(recDir, `mic_${stamp}.wav`);
    const args = [
      "-hide_banner",
      "-y",
      "-i", rawPath,
      "-c:a", "pcm_s16le",
      wavPath,
    ];
    await runFfmpeg(args);
    return assertSafeAudioPath(wavPath);
  }
);

ipcMain.handle(
  "save-mic-recording-as",
  async (_event: IpcMainInvokeEvent, data: Buffer, mimeType: string) => {
    const options = {
      title: "Save Recording",
      defaultPath: `recording_${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      filters: [{ name: "WAV Audio", extensions: ["wav"] }],
    };

    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) return null;

    const recDir = path.join(app.getPath("userData"), "recordings");
    ensureDir(recDir);

    const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const mt = (mimeType || "").toLowerCase();
    const ext =
      mt.includes("ogg") ? "ogg" :
      mt.includes("webm") ? "webm" :
      mt.includes("wav") ? "wav" :
      "webm";

    const rawPath = path.join(recDir, `mic_${stamp}.${ext}`);
    fs.writeFileSync(rawPath, data);

    const args = [
      "-hide_banner",
      "-y",
      "-i", rawPath,
      "-c:a", "pcm_s16le",
      result.filePath,
    ];
    await runFfmpeg(args);
    return assertSafeAudioPath(result.filePath);
  }
);

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
    //make the path for audiofile safe
    const safeAudioPath = assertSafeAudioPath(audioPath);
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
      "-i", safeAudioPath,
      "-c:a", "pcm_s16le",
      outPath
    ];

    await runFfmpeg(args);
    return outPath;
  }
);

/**
 * 
 */
ipcMain.handle("audio-section", 
  async(_event,audioPath: string, start: number,end)=> {
  const safePath = assertSafeAudioPath(audioPath);
  const seg = assertSafeSegment(start, end);
  return await extractAudioSection(safePath,seg.start,seg.end);
})

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

ipcMain.handle("render-edited-preview", async (_event: IpcMainInvokeEvent, edlJson: string) => {
  const edl: Edl = JSON.parse(edlJson);
  const entries = (edl.entries || []).filter((e) => !e.muted);

  if (entries.length === 0) {
    throw new Error("No non-muted segments to preview.");
  }

  const getSource = (e: any) => (typeof e.sourceFile === "string" ? e.sourceFile : edl.sourceFile);
  //santize the inputs
  const safeEntries = entries.map((e:any) => ({
    sourceFile: assertSafeAudioPath(getSource(e)),
    segment: assertSafeSegment(e.sourceStart, e.sourceEnd),
  }));
  const sources = Array.from(new Set(safeEntries.map(e => e.sourceFile)));

  const inputArgs: string[] = [];
  for (const src of sources) {
    inputArgs.push("-i", src);
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e: any = safeEntries[i];
    const inputIndex = sources.indexOf(e.sourceFile);
    const {start, end} = e.segment;
    filterParts.push(
      `[${inputIndex}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`
    );
    concatInputs.push(`[a${i}]`);
  }

  const filterComplex =
    filterParts.join("; ") +
    "; " +
    concatInputs.join("") +
    `concat=n=${safeEntries.length}:v=0:a=1[out]`;

  const outDir = path.join(app.getPath("userData"), "preview_audio");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(
    outDir,
    `preview_${Date.now()}_${Math.floor(Math.random() * 1e6)}.wav`
  );

  const args = [
    "-hide_banner",
    "-y",
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "pcm_s16le",
    outPath,
  ];

  await runFfmpeg(args);
  return outPath;
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
  const getSource = (e: any) => (typeof e.sourceFile === "string" ? e.sourceFile : edl.sourceFile);
  const safeEntries = entries.map((e: any) => ({
    sourceFile: assertSafeAudioPath(getSource(e)),
    segment: assertSafeSegment(e.sourceStart, e.sourceEnd),
  }));

  const sources = Array.from(new Set(safeEntries.map(e => e.sourceFile)));

  const inputArgs: string[] = [];
  for (const src of sources) {
    inputArgs.push("-i", src);
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < safeEntries.length; i++) {
  const e = safeEntries[i];
  const inputIndex = sources.indexOf(e.sourceFile);
  const { start, end } = e.segment;

  filterParts.push(
    `[${inputIndex}:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${i}]`
  );

  concatInputs.push(`[a${i}]`);
}

  const filterComplex =
    filterParts.join("; ") +
    "; " +
    concatInputs.join("") +
    `concat=n=${safeEntries.length}:v=0:a=1[out]`;

  const args = [
    "-hide_banner",
    "-y",
    ...inputArgs,
    "-filter_complex", filterComplex,
    "-map", "[out]",
    "-c:a", "pcm_s16le",
    result.filePath,
  ];

  await runFfmpeg(args);
  return result.filePath;
});
