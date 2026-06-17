#!/usr/bin/env python3
"""
transcribe.py

CLI wrapper for the OTTER PoC pipeline system.

This script is meant to be called from Electron (main process).

## Electron ↔ Python contract (important)

- **STDOUT**: machine-readable JSON only (no logs). Electron treats this as the return value.
- **STDERR**: logs + progress markers. Electron listens for:
  - `PROGRESS:<N>` lines where \(0 \le N \le 100\) and forwards them to the UI progress bar.
  - optional `CONTROL:*` lines emitted by `ControlManager` (pause/resume/cancel acknowledgements).

To keep this reliable, we redirect any third-party stdout chatter to stderr
(see `run_with_stdout_redirect`) so it cannot corrupt the JSON channel.

Supported commands:
  - list: print available transcribers and post-processors (with option schemas)
  - run:  execute a pipeline spec on an audio file and print resulting word array

Examples:
  python3 -m otter_py.transcribe list
  python3 -m otter_py.transcribe run --audio /path/to.wav --spec-file spec.json
  python3 -m otter_py.transcribe run --audio /path/to.wav --spec-json '{"transcriber": {...}, "post": [...]}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from typing import Any, Dict, Optional

from pydash import get as deep_get
from otter_py.exceptions import TranscriptionCancelled
from otter_py.util import _start_elapsed_timer, eprint, run_with_stdout_redirect
from otter_py.cacheUtil import _cache_key, _cache_dir, _load_cache, _save_cache


class ControlManager:
    """
    Reads JSON control messages from stdin.

    Supported commands:
      {"type":"pause"}
      {"type":"resume"}
      {"type":"cancel"}

    Exposes cooperative control methods:
      - wait_if_paused()
      - throw_if_cancelled()
      - checkpoint()
    """

    def __init__(self) -> None:
        self._cancelled = threading.Event()

        self._resume_event = threading.Event()
        self._resume_event.set()

        self._thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._thread.start()

    def _reader_loop(self) -> None:
        try:
            for raw in sys.stdin:
                line = raw.strip()
                if not line:
                    continue

                try:
                    msg = json.loads(line)
                except Exception:
                    eprint(f"WARN:invalid control message: {line}")
                    continue

                kind = msg.get("type")

                if kind == "pause":
                    self._resume_event.clear()
                    eprint("CONTROL:PAUSED")
                elif kind == "resume":
                    self._resume_event.set()
                    eprint("CONTROL:RESUMED")
                elif kind == "cancel":
                    self._cancelled.set()
                    self._resume_event.set()
                    eprint("CONTROL:CANCELLING")
                    return
                elif kind == "ping":
                    eprint("CONTROL:PONG")
                else:
                    eprint(f"WARN:unknown control type: {kind}")
        except Exception as ex:
            eprint(f"WARN:control loop ended unexpectedly: {type(ex).__name__}:{ex}")


    def throw_if_cancelled(self) -> None:
        if self._cancelled.is_set():
            raise TranscriptionCancelled("Transcription cancelled")
        
    def wait_if_paused(self):
        self._resume_event.wait()
        self.throw_if_cancelled()

    def checkpoint(self) -> None:
        self.throw_if_cancelled()
        self.wait_if_paused()

    def progress_wrapper(self, fn):
        """Emit progress without checkpointing — avoids TranscriptionCancelled in bridge threads."""

        def wrapped(pct: int) -> None:
            fn(pct)

        return wrapped

def read_spec(spec_json: Optional[str], spec_file: Optional[str]) -> Dict[str, Any]:
    """
    Load the pipeline spec from a JSON string or file.

    Accepted shapes (high level):
    - {"transcriber": {"id": "...", "opts": {...}}, "post": [...]}  (canonical)
    - {"transcriber": {...}, "postprocessors": [...]}              (legacy alias)

    Each post entry is:
      {"id": "<postprocessor_id>", "opts": {...}}
    """
    if spec_json and spec_file:
        raise ValueError("Provide only one of --spec-json or --spec-file")

    if spec_file:
        with open(spec_file, "r", encoding="utf-8") as f:
            return json.load(f)

    if spec_json:
        return json.loads(spec_json)

    raise ValueError("Missing pipeline spec. Provide --spec-json or --spec-file")

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="OTTER PoC transcription pipeline runner")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="List available transcribers and post-processors")

    p_run = sub.add_parser("run", help="Run a pipeline spec on an audio file")
    p_run.add_argument("--audio", required=True, help="Path to input audio file")
    p_run.add_argument("--spec-json", help="Pipeline spec as JSON string")
    p_run.add_argument("--spec-file", help="Path to pipeline spec JSON file")
    p_run.add_argument("--no-cache", action="store_true", help="Skip cache and overwrite cached result")
    p_run.add_argument("--emit-meta", action="store_true", help="Emit {words, meta} instead of just words[]")

    sub.add_parser("clear-cache", help="Delete all cached results (for testing/debugging)")


    args = parser.parse_args(argv)

    # Ensure repo root is on sys.path when invoked as a script (not as -m).
    # This makes 'import py....' work more reliably.
    here = os.path.abspath(os.path.dirname(__file__))
    repo_root = os.path.dirname(here)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    if args.cmd == "list":
        from otter_py.pipeline_registry import load_components, list_components
        load_components()  # ensure components are loaded before listing
        data = list_components()
        json.dump(data, sys.stdout, indent=2)
        sys.stdout.write("\n")
        return 0

    if args.cmd == "run":
        eprint(f"PROGRESS:0")
        eprint("INFO:Initializing pipeline components...")
        from otter_py.pipeline_registry import load_components, run_pipeline
        load_components()  # ensure components are loaded before running
        try:
            spec = read_spec(args.spec_json, args.spec_file)
        except (ValueError, json.JSONDecodeError) as e:
            eprint(f"ERROR:SpecError:{e}")
            return 1

        audio_path = args.audio
        if not os.path.exists(audio_path):
            eprint(f"ERROR:FileNotFoundError:Audio file not found: {audio_path}")
            return 1
        controller = ControlManager()

        # Progress callback for Electron:
        # - emit "PROGRESS:NN" lines to stderr (easy to parse, keeps stdout clean)
        # - may be invoked from worker threads inside transcribers; must stay fast.
        # - repeating the same NN does not update HTML <progress> in Chromium; bridges
        #   in whisperx_vad oscillate slightly when saturated so the bar still repaints.
        def progress(pct: int) -> None:
            eprint(f"PROGRESS:{pct}")

        ctx: Dict[str, Any] = {
            "progress": controller.progress_wrapper(progress),
            "control": controller,
            "checkpoint": controller.checkpoint,
            "wait_if_paused": controller.wait_if_paused,
            "throw_if_cancelled": controller.throw_if_cancelled,
        }

        cache_key = _cache_key(audio_path, spec)
        cached = None if args.no_cache else _load_cache(cache_key)
        # Run the pipeline with stdout redirected to stderr so that any library
        # chatter (e.g. WhisperX notices) can't corrupt our JSON output channel.
        if cached is not None:
            controller.checkpoint()
            eprint("INFO:cache hit, skipping pipeline execution")
            result = cached
        else:
            eprint("INFO:cache miss, running pipeline")
            timer_stop = _start_elapsed_timer(label="transcription")
            try:
                import soundfile as sf
                duration = sf.info(audio_path).duration
                eprint(f"INFO:audio duration is {duration:.2f} seconds")
            except Exception:
                duration = 0
            PARALLEL_THRESHOLD = 20 * 60  # seconds; if audio is longer than this, may use parallel path
            use_parallel = duration > PARALLEL_THRESHOLD
            t_id = (spec.get("transcriber") or {}).get("id")
            if use_parallel and t_id != "whisperx_vad":
                eprint(
                    f"WARN: parallel transcription is only implemented for transcriber "
                    f"'whisperx_vad'; got {t_id!r}. Using single-process pipeline."
                )
                use_parallel = False

            try:
                controller.checkpoint()

                if use_parallel:
                    from otter_py.parallel_transcribe import transcribe_parallel
                    eprint(f"INFO:audio duration exceeds {PARALLEL_THRESHOLD/60:.0f} minutes, enabling parallel execution (if supported by transcriber)")
                    from otter_py.pipeline_registry import _POSTS
                    import time

                    t_opts =(spec.get("transcriber") or {}).get("opts") or {}

                    controller.checkpoint()
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
                            eprint(f"INFO:running post-processor {p_id} with opts {p_opts}")
                            p0 = time.time()
                            words, p_meta = run_with_stdout_redirect(
                                lambda w=words, pid=p_id, opts=p_opts: _POSTS[pid]["fn"](
                                    w, opts, ctx
                                )
                            )
                            post_meta.append({
                                "id": p_id, 
                                "opts": p_opts, 
                                "runtime": round(time.time() - p0, 3),
                                "meta": p_meta or {}
                                })
                    result = {
                        "words": words,
                        "meta": {
                            "transcriber": {
                                "id": "whisperx_parallel",
                                "opts": t_opts,
                                "meta": t_meta
                            },
                            "post": post_meta
                        }
                    }
                else:
                    controller.checkpoint()
                    result = run_with_stdout_redirect(
                        lambda: run_pipeline(audio_path=audio_path, spec=spec, ctx=ctx)
                    )
            except TranscriptionCancelled as e:
                timer_stop.set()
                eprint(f"INFO:cancelled:{e}")
                json.dump({"error": "Cancelled", "message": str(e)}, sys.stdout)
                sys.stdout.write("\n")
                return 2
            except Exception as e:
                timer_stop.set()
                eprint(f"ERROR:{type(e).__name__}:{e}")
                json.dump({"error": type(e).__name__, "message": str(e)}, sys.stdout)
                sys.stdout.write("\n")
                return 1
            timer_stop.set()
            controller.checkpoint()
            _save_cache(cache_key, result)

        # Emit machine-readable JSON ONLY on stdout (no extra logs, progress, or library chatter).
        if not args.emit_meta:
            language = deep_get(result, "meta.transcriber.meta.language", default=None)
            if language is None:
                eprint("WARN: could not extract language from meta, defaulting to 'unknown'")
                language = "unknown"
            result.pop("meta", None)
            result["language"] = language
        
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        return 0

    if args.cmd == "clear-cache":
        # For testing/debugging: clear the cache directory
        cache = _cache_dir()
        deleted = 0
        for f in os.listdir(cache):
            if f.endswith(".json"):
                try:
                    os.remove(os.path.join(cache, f))
                    deleted += 1
                except OSError as e:
                    eprint(f"WARN: failed to remove cache file {f}: {e}")
        json.dump({"deleted": deleted, "cache_dir": cache}, sys.stdout)
        sys.stdout.write("\n")
        return 0
    parser.error("Unhandled command")
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise  # let normal exits through
    except Exception as ex:
        json.dump({"error": type(ex).__name__, "message": str(ex)}, sys.stdout)
        sys.stdout.write("\n")
        sys.exit(1)  # clean exit, no traceback
