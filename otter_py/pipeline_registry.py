# py/pipeline_registry.py
"""
pipeline_registry.py

A small, self-describing registry for OTTER transcription experiments.

Concepts
- Transcriber: produces a canonical word list (absolute times in seconds) from an audio file.
- Post-processor: transforms a word list -> word list.

Goals (for the PoC and for students)
- Discoverability: enumerate available transcribers / processors and their options schemas.
- Composability: choose ONE transcriber + an ordered list of processors.
- Uniform contract: every stage uses the same canonical Word dict shape.

This module intentionally keeps schemas "JSON-schema-ish" (enough for a dev UI) rather than
trying to be fully standards-compliant.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple, TypedDict
import time


# -----------------------------------------------------------------------------
# Canonical word representation (dict-based for easy JSON I/O)
# -----------------------------------------------------------------------------

class Word(TypedDict, total=False):
    word: str
    start: float          # seconds, absolute to the original audio
    end: float            # seconds, absolute to the original audio
    # Possibel future fields:
    # conf: float           # optional confidence
    # speaker: str          # optional speaker label
    # segment_id, token_ids, etc.


# -----------------------------------------------------------------------------
# Registry entries
# -----------------------------------------------------------------------------

@dataclass(frozen=True)
class ComponentInfo:
    id: str
    label: str
    kind: str  # "transcriber" | "post"
    options_schema: Dict[str, Any]
    description: str = ""


# Callable signatures:
TranscriberFn = Callable[[str, Dict[str, Any], Dict[str, Any]], Tuple[List[Word], Dict[str, Any]]]
PostProcessorFn = Callable[[List[Word], Dict[str, Any], Dict[str, Any]], Tuple[List[Word], Dict[str, Any]]]


class _TranscriberEntry(TypedDict):
    info: ComponentInfo
    fn: TranscriberFn


class _PostEntry(TypedDict):
    info: ComponentInfo
    fn: PostProcessorFn


_TRANSCIBERS: Dict[str, _TranscriberEntry] = {}
_POSTS: Dict[str, _PostEntry] = {}


# -----------------------------------------------------------------------------
# Registration helpers (decorator style)
# -----------------------------------------------------------------------------

def register_transcriber(
    *,
    id: str,
    label: str,
    options_schema: Dict[str, Any],
    description: str = "",
) -> Callable[[TranscriberFn], TranscriberFn]:
    """Decorator to register a transcriber function."""
    def _decorator(fn: TranscriberFn) -> TranscriberFn:
        if id in _TRANSCIBERS:
            raise KeyError(f"Transcriber '{id}' already registered")
        info = ComponentInfo(id=id, label=label, kind="transcriber",
                             options_schema=options_schema, description=description)
        _TRANSCIBERS[id] = {"info": info, "fn": fn}
        return fn
    return _decorator


def register_postprocessor(
    *,
    id: str,
    label: str,
    options_schema: Dict[str, Any],
    description: str = "",
) -> Callable[[PostProcessorFn], PostProcessorFn]:
    """Decorator to register a post-processor function."""
    def _decorator(fn: PostProcessorFn) -> PostProcessorFn:
        if id in _POSTS:
            raise KeyError(f"Post-processor '{id}' already registered")
        info = ComponentInfo(id=id, label=label, kind="post",
                             options_schema=options_schema, description=description)
        _POSTS[id] = {"info": info, "fn": fn}
        return fn
    return _decorator


# -----------------------------------------------------------------------------
# Public API: discovery
# -----------------------------------------------------------------------------

def load_components() -> None:
    """
    Import the transcriber and post-processor packages so that their modules
    execute and register themselves via decorators.

    Registration happens at import time as a side effect of importing the
    component modules.
    """
    import otter_py.pipelines.transcribers  # noqa: F401
    import otter_py.pipelines.postprocessors  # noqa: F401

def list_components() -> Dict[str, Any]:
    """
    Return a self-describing snapshot of available components.

    Intended use:
      - Electron calls `python transcribe.py list` and builds a dev UI from this.
    """
    transcribers = [
        {
            "id": e["info"].id,
            "label": e["info"].label,
            "description": e["info"].description,
            "options_schema": e["info"].options_schema,
        }
        for e in _TRANSCIBERS.values()
    ]
    posts = [
        {
            "id": e["info"].id,
            "label": e["info"].label,
            "description": e["info"].description,
            "options_schema": e["info"].options_schema,
        }
        for e in _POSTS.values()
    ]
    transcribers.sort(key=lambda x: x["id"])
    posts.sort(key=lambda x: x["id"])
    return {
        "schema_version": 1,
        "transcribers": transcribers,
        "postprocessors": posts,
    }


# -----------------------------------------------------------------------------
# Public API: execution
# -----------------------------------------------------------------------------

class PipelineSpec(TypedDict, total=False):
    transcriber: Dict[str, Any]  # {"id": "...", "opts": {...}}
    post: List[Dict[str, Any]]   # [{"id": "...", "opts": {...}}, ...]


def run_pipeline(
    *,
    audio_path: str,
    spec: PipelineSpec,
    ctx: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Execute a pipeline: one transcriber + ordered list of post-processors.

    Returns a dict ready to be JSON-serialized:
      {
        "words": [...],
        "meta": {
          "transcriber": {...},
          "post": [{...}, ...]
        }
      }
    """
    if ctx is None:
        ctx = {}

    # --- pick transcriber
    t_spec = spec.get("transcriber") or {}
    t_id = t_spec.get("id")
    t_opts = t_spec.get("opts") or {}
    if not t_id:
        raise ValueError("Pipeline spec missing transcriber.id")
    if t_id not in _TRANSCIBERS:
        raise KeyError(f"Unknown transcriber '{t_id}'")

    # --- run transcriber
    t_entry = _TRANSCIBERS[t_id]
    t0 = time.time()
    words, t_meta = t_entry["fn"](audio_path, t_opts, ctx)
    t_runtime = time.time() - t0

    meta: Dict[str, Any] = {
        "transcriber": {
            "id": t_id,
            "opts": t_opts,
            "runtime_s": round(t_runtime, 3),
            "meta": t_meta or {},
        },
        "post": [],
    }

    # --- run post-processors in order
    for p_spec in spec.get("post") or []:
        p_id = p_spec.get("id")
        p_opts = p_spec.get("opts") or {}
        if not p_id:
            raise ValueError("Post entry missing id")
        if p_id not in _POSTS:
            raise KeyError(f"Unknown post-processor '{p_id}'")

        p_entry = _POSTS[p_id]
        p0 = time.time()
        words, p_meta = p_entry["fn"](words, p_opts, ctx)
        p_runtime = time.time() - p0

        meta["post"].append({
            "id": p_id,
            "opts": p_opts,
            "runtime_s": round(p_runtime, 3),
            "meta": p_meta or {},
        })

    return {"words": words, "meta": meta}

