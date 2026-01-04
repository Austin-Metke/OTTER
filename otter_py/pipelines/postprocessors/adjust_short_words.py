"""
Post-processor: Adjust Short Words

Heuristic pass that expands very short words by extending their start time
leftward, without overlapping the previous word.

Motivation:
- Some ASR pipelines produce extremely short word durations (especially
  function words), which can make precise selection and playback difficult.
- This pass trades temporal precision for usability by enforcing a minimum
  effective duration.

This processor operates entirely in word-time space and does not inspect audio.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

from otter_py.pipeline_registry import register_postprocessor, Word

@register_postprocessor(
    id="adjust_short_words",
    label="Adjust short words (extend left)",
    description="Expands very short words by extending their start time leftward, avoiding overlap.",
    options_schema={
        "type": "object",
        "properties": {
            "max_len": {
                "type": "number",
                "description": "Words shorter than this (seconds) will be expanded.",
                "default": 0.30,
            },
            "min_extend": {
                "type": "number",
                "description": "Minimum extension duration applied to short words (seconds).",
                "default": 0.10,
            },
        },
        "additionalProperties": False,
    },
)
def adjust_short_words(
    words: List[Word],
    opts: Dict[str, Any],
    ctx: Dict[str, Any],
) -> Tuple[List[Word], Dict[str, Any]]:
    max_len = float(opts.get("max_len", 0.30))
    min_extend = float(opts.get("min_extend", 0.10))

    if len(words) < 3:
        # Nothing to do; return a shallow copy
        return list(words), {"adjusted": 0}

    out: List[Word] = []
    adjusted = 0

    # Copy first word unchanged
    out.append(dict(words[0]))

    for i in range(1, len(words) - 1):
        prev = out[i - 1]
        w = dict(words[i])  # copy
        duration = w["end"] - w["start"]

        if duration < max_len:
            extend = max(duration, min_extend)
            new_start = max(w["start"] - extend, prev["end"])

            if new_start < w["start"]:
                w["start"] = new_start
                adjusted += 1

        out.append(w)

    # Copy last word unchanged
    out.append(dict(words[-1]))

    return out, {
        "adjusted": adjusted,
        "max_len": max_len,
        "min_extend": min_extend,
    }