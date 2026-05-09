/**
 * api.ts
 *
 * Browser-based implementation of the OtterApi interface.
 *
 * Replaces the Electron IPC bridge (preload.ts) with REST API calls
 * and Server-Sent Events for transcription streaming.
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

type TranscribeCancelled = { cancelled: true };
type TranscribeAudioResult = TranscriptResult | TranscribeCancelled;

type TranscribeSpec =
  | { mode: "file"; name: string }
  | { mode: "json"; jsonText: string };

type OtterApi = {
  chooseAudioFile: () => Promise<string | null>;
  transcribeAudio: (audioPath: string, spec?: TranscribeSpec) => Promise<TranscribeAudioResult>;
  onTranscribeLog: (cb: (msg: string) => void) => void;
  probeAudio: (audioPath: string) => Promise<{ start_time: number; sample_rate: number | null }>;
  onTranscribeProgress: (cb: (pct: number) => void) => void;
  makeSnippet: (audioPath: string, startSec: number, durSec: number) => Promise<string>;
  readFileAsArrayBuffer: (filePath: string) => Promise<ArrayBuffer>;
  listSpecFiles: () => Promise<string[]>;
  readSpecFile: (name: string) => Promise<string>;
  readDefaultSpec: () => Promise<string>;
  saveEdl: (edlJson: string) => Promise<string | null>;
  loadEdl: () => Promise<{ path: string; content: string } | null>;
  exportEdlAudio: (edlJson: string) => Promise<string | null>;
  renderEditedPreview: (edlJson: string) => Promise<string>;
  pauseTranscription: () => Promise<boolean>;
  resumeTranscription: () => Promise<boolean>;
  cancelTranscription: () => Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _logCallback: ((msg: string) => void) | null = null;
let _progressCallback: ((pct: number) => void) | null = null;
let _activeSessionId: string | null = null;
let _activeEventSource: EventSource | null = null;
let _lastUploadedFilename: string | null = null;

/** Returns the filename of the last uploaded audio file (for display purposes). */
export function getLastUploadedFilename(): string | null {
  return _lastUploadedFilename;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Trigger a hidden file input and return the selected file. */
function _pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const file = input.files?.[0] ?? null;
      document.body.removeChild(input);
      resolve(file);
    });

    // Handle cancel (input loses focus without selection)
    input.addEventListener("cancel", () => {
      document.body.removeChild(input);
      resolve(null);
    });

    input.click();
  });
}

/** Trigger a browser download of a string as a file. */
function _downloadString(content: string, filename: string, mimeType = "application/json"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Trigger a browser download of a server file by file_id. */
function _downloadFileById(fileId: string, filename: string): void {
  const a = document.createElement("a");
  a.href = `/api/audio/files/${fileId}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/** Build the audio file URL from a file_id. */
export function audioUrl(fileId: string): string {
  return `/api/audio/files/${fileId}`;
}

// ---------------------------------------------------------------------------
// OtterApi implementation
// ---------------------------------------------------------------------------

export const otter: OtterApi = {
  async chooseAudioFile(): Promise<string | null> {
    const file = await _pickFile(".wav,audio/*");
    if (!file) return null;

    const formData = new FormData();
    formData.append("file", file);

    const resp = await fetch("/api/audio/upload", { method: "POST", body: formData });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.statusText}`);

    const data = await resp.json();
    _lastUploadedFilename = data.filename || file.name;
    return data.file_id;  // Returns file_id as the "path" — used in all subsequent calls
  },

  async transcribeAudio(fileId: string, spec?: TranscribeSpec): Promise<TranscribeAudioResult> {
    // Build request body
    const body: Record<string, unknown> = { file_id: fileId };

    if (spec?.mode === "file") {
      body.spec_name = spec.name;
    } else if (spec?.mode === "json") {
      body.spec = JSON.parse(spec.jsonText);
    }
    // else: server uses default spec

    const resp = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) throw new Error(`Transcription start failed: ${resp.statusText}`);

    const { session_id } = await resp.json();
    _activeSessionId = session_id;

    // Connect to SSE for progress/logs/result
    return new Promise<TranscribeAudioResult>((resolve, reject) => {
      const es = new EventSource(`/api/transcribe/${session_id}/events`);
      _activeEventSource = es;

      es.addEventListener("progress", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        _progressCallback?.(data.pct);
      });

      es.addEventListener("log", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        _logCallback?.(data.message + "\n");
      });

      es.addEventListener("state", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        _logCallback?.(`CONTROL:${data.state.toUpperCase()}\n`);
      });

      es.addEventListener("complete", (e: MessageEvent) => {
        const data = JSON.parse(e.data);
        es.close();
        _activeEventSource = null;
        _activeSessionId = null;
        resolve(data);
      });

      es.addEventListener("cancelled", () => {
        es.close();
        _activeEventSource = null;
        _activeSessionId = null;
        resolve({ cancelled: true });
      });

      es.addEventListener("error", (e: MessageEvent) => {
        // SSE spec: if e has data, it's our custom error event
        if (e.data) {
          const data = JSON.parse(e.data);
          es.close();
          _activeEventSource = null;
          _activeSessionId = null;
          reject(new Error(`${data.error}: ${data.message}`));
        }
        // Otherwise it's a connection error — EventSource auto-reconnects
      });

      es.onerror = () => {
        // Connection-level error. If stream was already closed (terminal state), ignore.
        if (_activeEventSource !== es) return;
      };
    });
  },

  onTranscribeLog(cb: (msg: string) => void): void {
    _logCallback = cb;
  },

  onTranscribeProgress(cb: (pct: number) => void): void {
    _progressCallback = cb;
  },

  async probeAudio(fileId: string): Promise<{ start_time: number; sample_rate: number | null }> {
    const resp = await fetch("/api/audio/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!resp.ok) throw new Error(`Probe failed: ${resp.statusText}`);
    return resp.json();
  },

  async makeSnippet(fileId: string, startSec: number, durSec: number): Promise<string> {
    const resp = await fetch("/api/audio/snippet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, start: startSec, duration: durSec }),
    });
    if (!resp.ok) throw new Error(`Snippet failed: ${resp.statusText}`);
    const data = await resp.json();
    // Return the URL to the snippet (not the file_id), since WaveSurfer loads from URL
    return `/api/audio/files/${data.file_id}`;
  },

  async readFileAsArrayBuffer(fileId: string): Promise<ArrayBuffer> {
    const resp = await fetch(`/api/audio/files/${fileId}`);
    if (!resp.ok) throw new Error(`File read failed: ${resp.statusText}`);
    return resp.arrayBuffer();
  },

  async listSpecFiles(): Promise<string[]> {
    const resp = await fetch("/api/specs");
    if (!resp.ok) throw new Error(`List specs failed: ${resp.statusText}`);
    const data = await resp.json();
    return data.specs;
  },

  async readSpecFile(name: string): Promise<string> {
    const resp = await fetch(`/api/specs/${encodeURIComponent(name)}`);
    if (!resp.ok) throw new Error(`Read spec failed: ${resp.statusText}`);
    const data = await resp.json();
    return data.content;
  },

  async readDefaultSpec(): Promise<string> {
    return otter.readSpecFile("default_spec.json");
  },

  async saveEdl(edlJson: string): Promise<string | null> {
    // Browser download — no server round-trip needed
    _downloadString(edlJson, "untitled.otter-edl.json");
    return "downloaded";
  },

  async loadEdl(): Promise<{ path: string; content: string } | null> {
    const file = await _pickFile(".json");
    if (!file) return null;

    const content = await file.text();
    return { path: file.name, content };
  },

  async exportEdlAudio(edlJson: string): Promise<string | null> {
    const resp = await fetch("/api/audio/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edl_json: edlJson }),
    });
    if (!resp.ok) throw new Error(`Export failed: ${resp.statusText}`);

    const data = await resp.json();
    _downloadFileById(data.file_id, "export.wav");
    return "downloaded";
  },

  async renderEditedPreview(edlJson: string): Promise<string> {
    const resp = await fetch("/api/audio/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edl_json: edlJson }),
    });
    if (!resp.ok) throw new Error(`Preview failed: ${resp.statusText}`);

    const data = await resp.json();
    // Return the URL — renderer will load this into WaveSurfer
    return `/api/audio/files/${data.file_id}`;
  },

  async pauseTranscription(): Promise<boolean> {
    if (!_activeSessionId) return false;
    const resp = await fetch(`/api/transcribe/${_activeSessionId}/pause`, { method: "POST" });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.ok;
  },

  async resumeTranscription(): Promise<boolean> {
    if (!_activeSessionId) return false;
    const resp = await fetch(`/api/transcribe/${_activeSessionId}/resume`, { method: "POST" });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.ok;
  },

  async cancelTranscription(): Promise<boolean> {
    if (!_activeSessionId) return false;
    const resp = await fetch(`/api/transcribe/${_activeSessionId}/cancel`, { method: "POST" });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data.ok;
  },
};

// Expose on window so renderer.ts can discover it in browser mode
(window as any).__otterApi = otter;
(window as any).__otterApiGetFilename = getLastUploadedFilename;
