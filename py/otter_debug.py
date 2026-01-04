import os
import sys
from enum import IntEnum
from typing import Optional


class DebugLevel(IntEnum):
    OFF = 0
    ERROR = 1
    WARNING = 2
    TRACE = 3
    DETAIL = 4


# Environment variables:
#   OTTER_DEBUG=0..4
#   OTTER_DEBUG_TAGS=comma,separated,optional

_DEBUG_LEVEL = DebugLevel(int(os.getenv("OTTER_DEBUG", "4")))

_DEBUG_TAGS = {
    tag.strip()
    for tag in os.getenv("OTTER_DEBUG_TAGS", "").split(",")
    if tag.strip()
}


def dbg(
    msg: str,
    level: DebugLevel = DebugLevel.TRACE,
    *,
    tag: Optional[str] = None,
):
    """
    Debug print to stderr controlled by OTTER_DEBUG.

    Default level is TRACE, so most call sites can just do:
        dbg("something happened")

    level:
        ERROR   – serious problems
        WARNING – unexpected but recoverable
        TRACE   – high-level algorithm flow (default)
        DETAIL  – inner-loop / numeric details
    """
    if _DEBUG_LEVEL < level:
        return

    if tag and _DEBUG_TAGS and tag not in _DEBUG_TAGS:
        return

    prefix = f"[{level.name}]"
    if tag:
        prefix += f"[{tag}]"

    print(f"{prefix} {msg}", file=sys.stderr, flush=True)