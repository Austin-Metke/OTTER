"""
session_manager.py

Manages transcription sessions for the REST API server.

Each transcription run gets a unique session_id. The session tracks:
  - A background thread running the pipeline
  - A ControlManager for pause/resume/cancel
  - A thread-safe event queue for SSE streaming
  - The final result (or error) once complete
"""

from __future__ import annotations

import json
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

from pydash import get as deep_get

from otter_py.exceptions import TranscriptionCancelled
from otter_py.util import eprint, run_with_stdout_redirect


@dataclass
class TranscriptionSession:
    session_id: str
    file_path: str
    spec: Dict[str, Any]
    state: str = "running"  # running | paused | cancelling | completed | error | cancelled
    events: queue.Queue = field(default_factory=queue.Queue)
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    thread: Optional[threading.Thread] = None

    # Cooperative control (mirrors ControlManager but without stdin dependency)
    _paused: threading.Event = field(default_factory=threading.Event)
    _cancelled: threading.Event = field(default_factory=threading.Event)

    def pause(self) -> bool:
        if self.state != "running":
            return False
        self._paused.set()
        self.state = "paused"
        self._push_event("state", {"state": "paused"})
        return True

    def resume(self) -> bool:
        if self.state != "paused":
            return False
        self._paused.clear()
        self.state = "running"
        self._push_event("state", {"state": "running"})
        return True

    def cancel(self) -> bool:
        if self.state in ("completed", "error", "cancelled"):
            return False
        self._cancelled.set()
        self._paused.clear()  # unblock if paused
        self.state = "cancelling"
        self._push_event("state", {"state": "cancelling"})
        return True

    # Cooperative control methods (called by pipeline threads)
    def wait_if_paused(self) -> None:
        while self._paused.is_set():
            if self._cancelled.is_set():
                raise TranscriptionCancelled("Transcription cancelled while paused")
            time.sleep(0.1)

    def throw_if_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise TranscriptionCancelled("Transcription cancelled")

    def checkpoint(self) -> None:
        self.throw_if_cancelled()
        self.wait_if_paused()
        self.throw_if_cancelled()

    def progress(self, pct: int) -> None:
        self._push_event("progress", {"pct": pct})

    def log(self, message: str) -> None:
        self._push_event("log", {"message": message})

    def _push_event(self, event_type: str, data: Any) -> None:
        self.events.put({"event": event_type, "data": data})


class SessionManager:
    def __init__(self) -> None:
        self._sessions: Dict[str, TranscriptionSession] = {}
        self._lock = threading.Lock()

    def create_session(self, file_path: str, spec: Dict[str, Any]) -> TranscriptionSession:
        session = TranscriptionSession(
            session_id=str(uuid.uuid4()),
            file_path=file_path,
            spec=spec,
        )
        with self._lock:
            self._sessions[session.session_id] = session
        return session

    def get_session(self, session_id: str) -> Optional[TranscriptionSession]:
        with self._lock:
            return self._sessions.get(session_id)

    def start_transcription(self, session: TranscriptionSession) -> None:
        """Run the transcription pipeline in a background thread."""
        thread = threading.Thread(
            target=self._run_pipeline,
            args=(session,),
            daemon=True,
        )
        session.thread = thread
        thread.start()

    def _run_pipeline(self, session: TranscriptionSession) -> None:
        from otter_py.pipeline_registry import load_components, run_pipeline
        from otter_py.cacheUtil import _cache_key, _load_cache, _save_cache

        try:
            load_components()
            session.progress(0)
            session.log("Initializing pipeline components...")

            spec = session.spec
            audio_path = session.file_path

            def progress_cb(pct: int) -> None:
                session.progress(pct)

            ctx: Dict[str, Any] = {
                "progress": progress_cb,
                "control": session,
                "checkpoint": session.checkpoint,
                "wait_if_paused": session.wait_if_paused,
                "throw_if_cancelled": session.throw_if_cancelled,
            }

            cache_key = _cache_key(audio_path, spec)
            cached = _load_cache(cache_key)

            if cached is not None:
                session.checkpoint()
                session.log("Cache hit, skipping pipeline execution")
                result = cached
            else:
                session.log("Cache miss, running pipeline")
                try:
                    import soundfile as sf
                    duration = sf.info(audio_path).duration
                    session.log(f"Audio duration is {duration:.2f} seconds")
                except Exception:
                    duration = 0

                PARALLEL_THRESHOLD = 20 * 60
                use_parallel = duration > PARALLEL_THRESHOLD
                t_id = (spec.get("transcriber") or {}).get("id")

                if use_parallel and t_id != "whisperx_vad":
                    session.log(
                        f"WARN: parallel transcription only for 'whisperx_vad'; got {t_id!r}. Using single-process."
                    )
                    use_parallel = False

                session.checkpoint()

                if use_parallel:
                    from otter_py.parallel_transcribe import transcribe_parallel
                    from otter_py.pipeline_registry import _POSTS

                    session.log(f"Audio exceeds {PARALLEL_THRESHOLD/60:.0f} min, enabling parallel execution")
                    t_opts = (spec.get("transcriber") or {}).get("opts") or {}

                    session.checkpoint()
                    words, t_meta = run_with_stdout_redirect(
                        lambda: transcribe_parallel(audio_path=audio_path, opts=t_opts, ctx=ctx)
                    )

                    post_meta = []
                    post_specs = spec.get("post")
                    if post_specs is None:
                        post_specs = spec.get("postprocessors") or []
                    for post_spec in post_specs:
                        p_id = post_spec.get("id")
                        p_opts = post_spec.get("opts") or {}
                        if p_id and p_id in _POSTS:
                            session.log(f"Running post-processor {p_id}")
                            p0 = time.time()
                            words, p_meta = run_with_stdout_redirect(
                                lambda w=words, pid=p_id, opts=p_opts: _POSTS[pid]["fn"](w, opts, ctx)
                            )
                            post_meta.append({
                                "id": p_id,
                                "opts": p_opts,
                                "runtime": round(time.time() - p0, 3),
                                "meta": p_meta or {},
                            })

                    result = {
                        "words": words,
                        "meta": {
                            "transcriber": {"id": "whisperx_parallel", "opts": t_opts, "meta": t_meta},
                            "post": post_meta,
                        },
                    }
                else:
                    session.checkpoint()
                    result = run_with_stdout_redirect(
                        lambda: run_pipeline(audio_path=audio_path, spec=spec, ctx=ctx)
                    )

                session.checkpoint()
                _save_cache(cache_key, result)

            # Extract language, match CLI output format
            language = deep_get(result, "meta.transcriber.meta.language", default=None)
            if language is None:
                language = "unknown"
            result.pop("meta", None)
            result["language"] = language

            session.result = result
            session.state = "completed"
            session._push_event("complete", result)

        except TranscriptionCancelled:
            session.state = "cancelled"
            session._push_event("cancelled", {"cancelled": True})

        except Exception as e:
            session.error = f"{type(e).__name__}: {e}"
            session.state = "error"
            session._push_event("error", {"error": type(e).__name__, "message": str(e)})
