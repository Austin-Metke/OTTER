"""
Post-processor: Clean Word Timings

Normalizes adjacent word boundaries to remove small overlaps and close tiny gaps.
This improves selection/playback behavior by ensuring word boundaries are "tight"
and consistent.

Algorithm (adjacent words only, assumes time-ordered words):
- If word[i].end > word[i+1].start: clamp overlap by setting both to midpoint.
- If there is a small positive gap (0 < gap < tiny_gap): close it to midpoint.

All time units in the canonical word list are seconds.
Options that take ms are explicitly named *_ms and converted internally.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple, Optional

from otter_py.pipeline_registry import register_postprocessor, Word

@register_postprocessor(
    id="clean_word_timings",
    label="Clean word timings (fix overlaps/gaps)",
    description="Clamps overlaps and closes tiny gaps between adjacent words using midpoints.",
    options_schema={
        "type": "object",
        "properties": {
            "tiny_gap_ms": {
                "type": "number",
                "description": "Close gaps smaller than this (milliseconds).",
                "default": 50.0,
            },
        },
        "additionalProperties": False,
    },
)
def clean_word_timings(
    words: List[Word],
    opts: Dict[str, Any],
    ctx: Dict[str, Any],
) -> Tuple[List[Word], Dict[str, Any]]:
    if len(words) < 2:
        return list(words), {"overlaps_fixed": 0, "gaps_closed": 0}

    tiny_gap_ms = float(opts.get("tiny_gap_ms", 50.0))
    tiny_gap = tiny_gap_ms / 1000.0

    out: List[Word] = [dict(w) for w in words]  # shallow-copy each word dict

    overlaps_fixed = 0
    gaps_closed = 0

    for i in range(len(out) - 1):
        w = out[i]
        n = out[i + 1]

        w_end = float(w["end"])
        n_start = float(n["start"])

        # 1) Clamp overlaps (w_end > n_start)
        if w_end > n_start:
            mid = (w_end + n_start) / 2.0
            w["end"] = mid
            n["start"] = mid
            overlaps_fixed += 1

            # refresh the locals
            w_end = float(w["end"])
            n_start = float(n["start"])

        # 2) Close tiny positive gaps
        gap = n_start - w_end
        if 0.0 < gap < tiny_gap:
            mid = (w_end + n_start) / 2.0
            w["end"] = mid
            n["start"] = mid
            gaps_closed += 1

    return out, {
        "tiny_gap_ms": tiny_gap_ms,
        "overlaps_fixed": overlaps_fixed,
        "gaps_closed": gaps_closed,
    }