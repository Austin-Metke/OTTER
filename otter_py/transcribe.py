#!/usr/bin/env python3
"""
transcribe.py

CLI wrapper for the OTTER PoC pipeline system.

This script is meant to be called from Electron (main process), and communicates
results via STDOUT (JSON). Diagnostic output (progress, logs) goes to STDERR.

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
from typing import Any, Dict, Optional
from contextlib import redirect_stdout
import sys
from pydash import get as deep_get

def run_with_stdout_redirect(fn):
    """
    Run `fn()` with stdout redirected to stderr.

    Rationale:
      Many ML/audio libraries print informational messages to stdout.
      Our contract is that stdout is reserved for machine-readable JSON.
      Redirecting stdout to stderr prevents accidental corruption of JSON output.
    """
    with redirect_stdout(sys.stderr):
        return fn()

def eprint(*args: Any, **kwargs: Any) -> None:
    """Print to stderr (keeps stdout reserved for machine-readable JSON)."""
    print(*args, file=sys.stderr, **kwargs)


def read_spec(spec_json: Optional[str], spec_file: Optional[str]) -> Dict[str, Any]:
    """Load the pipeline spec from a JSON string or file."""
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

    p_list = sub.add_parser("list", help="List available transcribers and post-processors")

    p_run = sub.add_parser("run", help="Run a pipeline spec on an audio file")
    p_run.add_argument("--audio", required=True, help="Path to input audio file")
    p_run.add_argument("--spec-json", help="Pipeline spec as JSON string")
    p_run.add_argument("--spec-file", help="Path to pipeline spec JSON file")

    # Optional: let Electron ask for meta too (debug)
    p_run.add_argument("--emit-meta", action="store_true", help="Emit {words, meta} instead of just words[]")

    args = parser.parse_args(argv)

    # Ensure repo root is on sys.path when invoked as a script (not as -m).
    # This makes 'import py....' work more reliably.
    here = os.path.abspath(os.path.dirname(__file__))
    repo_root = os.path.dirname(here)
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    from otter_py.pipeline_registry import load_components, list_components, run_pipeline
    load_components()

    if args.cmd == "list":
        data = list_components()
        json.dump(data, sys.stderr, indent=2)
        sys.stderr.write("\n")
        return 0

    if args.cmd == "run":
        spec = read_spec(args.spec_json, args.spec_file)

        audio_path = args.audio
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        # Progress callback for Electron:
        # - emit "PROGRESS:NN" lines to stderr (easy to parse, keeps stdout clean)
        def progress(pct: int) -> None:
            eprint(f"PROGRESS:{pct}")

        ctx: Dict[str, Any] = {"progress": progress}

        # Run the pipeline with stdout redirected to stderr so that any library
        # chatter (e.g. WhisperX notices) can't corrupt our JSON output channel.
        result = run_with_stdout_redirect(
            lambda: run_pipeline(audio_path=audio_path, spec=spec, ctx=ctx)
        )

        # Emit machine-readable JSON ONLY on stdout.
        if not args.emit_meta:
            language = deep_get(result, "meta.transcriber.meta.language", default="unknown")
            result.pop("meta", None)
            result["language"] = language
        
        json.dump(result, sys.stdout)

        sys.stdout.write("\n")
        return 0


    parser.error("Unhandled command")
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as ex:
        # Emit a structured error to stderr so Electron can show it / log it.
        eprint(f"ERROR:{type(ex).__name__}:{ex}")
        raise