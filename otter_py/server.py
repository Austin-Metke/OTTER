"""
server.py

FastAPI REST API server for OTTER.

Replaces Electron's main process — provides HTTP endpoints for:
  - Audio file upload, serving, probing, snippet creation
  - Transcription with SSE-based progress streaming
  - Transcription control (pause/resume/cancel)
  - Pipeline spec listing
  - EDL audio export and preview rendering
  - Static file serving for the frontend

Run with:
    uvicorn otter_py.server:app --reload --port 8000
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from starlette.staticfiles import StaticFiles

from otter_py.session_manager import SessionManager

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI(title="OTTER API", version="0.1.0")
session_manager = SessionManager()

# File registry: maps file_id -> absolute filesystem path
_file_registry: Dict[str, str] = {}
_file_registry_lock = asyncio.Lock()

# Repo root (one level up from otter_py/)
REPO_ROOT = Path(__file__).resolve().parent.parent

# Upload directory
UPLOAD_DIR = Path(os.environ.get("OTTER_UPLOAD_DIR", Path.home() / ".otter" / "uploads"))
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Generated files directory (snippets, previews, exports)
GENERATED_DIR = Path(os.environ.get("OTTER_GENERATED_DIR", Path.home() / ".otter" / "generated"))
GENERATED_DIR.mkdir(parents=True, exist_ok=True)

SAMPLE_SPECS_DIR = REPO_ROOT / "otter_py" / "sample_specs"


def _register_file(file_path: str) -> str:
    """Register a file path and return its file_id."""
    file_id = str(uuid.uuid4())
    _file_registry[file_id] = file_path
    return file_id


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------

class ProbeRequest(BaseModel):
    file_id: str

class SnippetRequest(BaseModel):
    file_id: str
    start: float
    duration: float

class TranscribeRequest(BaseModel):
    file_id: str
    spec: Optional[Dict[str, Any]] = None
    spec_name: Optional[str] = None

class EdlRequest(BaseModel):
    edl_json: str


# ---------------------------------------------------------------------------
# Audio endpoints
# ---------------------------------------------------------------------------

@app.post("/api/audio/upload")
async def upload_audio(file: UploadFile = File(...)):
    """Upload an audio file. Returns a file_id for subsequent operations."""
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    # Save uploaded file
    ext = Path(file.filename).suffix or ".wav"
    dest_name = f"{uuid.uuid4()}{ext}"
    dest_path = UPLOAD_DIR / dest_name

    with open(dest_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    file_id = _register_file(str(dest_path))
    return {"file_id": file_id, "filename": file.filename}


@app.get("/api/audio/files/{file_id}")
async def serve_audio(file_id: str):
    """Serve an audio file by file_id. Supports range requests for WaveSurfer."""
    path = _file_registry.get(file_id)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "File not found")

    return FileResponse(
        path,
        media_type="audio/wav",
        filename=os.path.basename(path),
    )


@app.post("/api/audio/probe")
async def probe_audio(req: ProbeRequest):
    """Probe audio metadata using ffprobe."""
    path = _file_registry.get(req.file_id)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "File not found")

    args = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=start_time,sample_rate",
        "-of", "json",
        path,
    ]

    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        raise HTTPException(500, "ffprobe not found on PATH")
    except subprocess.TimeoutExpired:
        raise HTTPException(500, "ffprobe timed out")

    if result.returncode != 0:
        raise HTTPException(500, f"ffprobe failed: {result.stderr}")

    data = json.loads(result.stdout)
    stream = (data.get("streams") or [{}])[0]
    return {
        "start_time": float(stream.get("start_time", 0)),
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else None,
    }


@app.post("/api/audio/snippet")
async def make_snippet(req: SnippetRequest):
    """Create a short WAV snippet from a source audio file using ffmpeg."""
    path = _file_registry.get(req.file_id)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "File not found")

    safe_start = max(0.0, req.start)
    safe_dur = max(0.05, req.duration)

    out_name = f"snippet_{uuid.uuid4()}.wav"
    out_path = GENERATED_DIR / out_name

    args = [
        "ffmpeg",
        "-hide_banner", "-y",
        "-ss", str(safe_start),
        "-t", str(safe_dur),
        "-i", path,
        "-c:a", "pcm_s16le",
        str(out_path),
    ]

    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        raise HTTPException(500, "ffmpeg not found on PATH")

    if result.returncode != 0:
        raise HTTPException(500, f"ffmpeg failed: {result.stderr}")

    file_id = _register_file(str(out_path))
    return {"file_id": file_id}


# ---------------------------------------------------------------------------
# Transcription endpoints
# ---------------------------------------------------------------------------

@app.post("/api/transcribe")
async def start_transcription(req: TranscribeRequest):
    """Start a transcription. Returns a session_id for tracking progress via SSE."""
    path = _file_registry.get(req.file_id)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "Audio file not found")

    # Resolve spec
    if req.spec:
        spec = req.spec
    elif req.spec_name:
        safe_name = os.path.basename(req.spec_name)
        if safe_name != req.spec_name:
            raise HTTPException(400, "Invalid spec file name")
        spec_path = SAMPLE_SPECS_DIR / safe_name
        if not spec_path.is_file():
            raise HTTPException(404, f"Spec file not found: {safe_name}")
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    else:
        # Default spec
        spec_path = SAMPLE_SPECS_DIR / "default_spec.json"
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)

    session = session_manager.create_session(path, spec)
    session_manager.start_transcription(session)

    return {"session_id": session.session_id}


@app.get("/api/transcribe/{session_id}/events")
async def transcribe_events(session_id: str):
    """SSE endpoint streaming transcription progress, logs, and results."""
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    async def event_stream():
        while True:
            try:
                event = session.events.get(timeout=0.5)
                event_type = event["event"]
                data = json.dumps(event["data"])
                yield f"event: {event_type}\ndata: {data}\n\n"

                # Terminal events — close the stream
                if event_type in ("complete", "error", "cancelled"):
                    return
            except queue.Empty:
                # Send keepalive comment to prevent connection timeout
                yield ": keepalive\n\n"

                # If session is in a terminal state and queue is empty, close
                if session.state in ("completed", "error", "cancelled"):
                    return

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/transcribe/{session_id}/pause")
async def pause_transcription(session_id: str):
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {"ok": session.pause()}


@app.post("/api/transcribe/{session_id}/resume")
async def resume_transcription(session_id: str):
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {"ok": session.resume()}


@app.post("/api/transcribe/{session_id}/cancel")
async def cancel_transcription(session_id: str):
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {"ok": session.cancel()}


@app.get("/api/transcribe/{session_id}/state")
async def get_transcription_state(session_id: str):
    session = session_manager.get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {"active": session.state in ("running", "paused", "cancelling"), "state": session.state}


# ---------------------------------------------------------------------------
# Spec endpoints
# ---------------------------------------------------------------------------

@app.get("/api/specs")
async def list_specs():
    """List available pipeline spec files."""
    if not SAMPLE_SPECS_DIR.is_dir():
        return {"specs": []}

    specs = sorted(
        f.name
        for f in SAMPLE_SPECS_DIR.iterdir()
        if f.is_file() and f.suffix == ".json"
    )
    return {"specs": specs}


@app.get("/api/specs/{name}")
async def read_spec(name: str):
    """Read a pipeline spec file by name."""
    safe_name = os.path.basename(name)
    if safe_name != name:
        raise HTTPException(400, "Invalid spec file name")

    spec_path = SAMPLE_SPECS_DIR / safe_name
    if not spec_path.is_file():
        raise HTTPException(404, f"Spec file not found: {safe_name}")

    with open(spec_path, "r", encoding="utf-8") as f:
        content = f.read()
    return {"name": safe_name, "content": content}


# ---------------------------------------------------------------------------
# EDL audio export / preview
# ---------------------------------------------------------------------------

def _run_ffmpeg_filter(source_file: str, entries: list, output_path: str) -> None:
    """Build and run an ffmpeg filter_complex to concatenate non-muted EDL segments."""
    if not entries:
        raise ValueError("No segments to process")

    filter_parts = []
    concat_inputs = []
    for i, e in enumerate(entries):
        filter_parts.append(
            f"[0]atrim=start={e['sourceStart']}:end={e['sourceEnd']},asetpts=PTS-STARTPTS[a{i}]"
        )
        concat_inputs.append(f"[a{i}]")

    filter_complex = (
        "; ".join(filter_parts)
        + "; "
        + "".join(concat_inputs)
        + f"concat=n={len(entries)}:v=0:a=1[out]"
    )

    args = [
        "ffmpeg",
        "-hide_banner", "-y",
        "-i", source_file,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-c:a", "pcm_s16le",
        output_path,
    ]

    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr}")


@app.post("/api/audio/export")
async def export_edl_audio(req: EdlRequest):
    """Export concatenated audio from non-muted EDL segments. Returns file_id for download."""
    edl = json.loads(req.edl_json)
    entries = [e for e in (edl.get("entries") or []) if not e.get("muted")]
    if not entries:
        raise HTTPException(400, "No non-muted segments to export")

    source_file = edl.get("sourceFile", "")

    # Resolve source file: could be a file_id or an absolute path
    if source_file in _file_registry:
        source_file = _file_registry[source_file]
    if not os.path.isfile(source_file):
        raise HTTPException(404, f"Source audio file not found: {source_file}")

    out_name = f"export_{uuid.uuid4()}.wav"
    out_path = str(GENERATED_DIR / out_name)

    try:
        _run_ffmpeg_filter(source_file, entries, out_path)
    except Exception as e:
        raise HTTPException(500, str(e))

    file_id = _register_file(out_path)
    return {"file_id": file_id}


@app.post("/api/audio/preview")
async def render_edited_preview(req: EdlRequest):
    """Render a preview of edited audio from EDL. Returns file_id."""
    edl = json.loads(req.edl_json)
    entries = [e for e in (edl.get("entries") or []) if not e.get("muted")]
    if not entries:
        raise HTTPException(400, "No non-muted segments to preview")

    source_file = edl.get("sourceFile", "")
    if source_file in _file_registry:
        source_file = _file_registry[source_file]
    if not os.path.isfile(source_file):
        raise HTTPException(404, f"Source audio file not found: {source_file}")

    out_name = f"preview_{uuid.uuid4()}.wav"
    out_path = str(GENERATED_DIR / out_name)

    try:
        _run_ffmpeg_filter(source_file, entries, out_path)
    except Exception as e:
        raise HTTPException(500, str(e))

    file_id = _register_file(out_path)
    return {"file_id": file_id}


# ---------------------------------------------------------------------------
# Static file serving (must be last — catches all unmatched routes)
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(REPO_ROOT), html=True), name="static")
