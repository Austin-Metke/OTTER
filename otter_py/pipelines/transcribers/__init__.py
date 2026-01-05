"""
Component registration module.

This package uses *import-time registration* for transcription pipelines and
post-processors. Each concrete transcriber or post-processor lives in its own
module and registers itself with the global pipeline registry using decorators
(e.g. @register_transcriber, @register_postprocessor).

Important:
- Registration happens as a SIDE EFFECT of importing the module.
- The symbols imported here are not referenced directly in code.
- These imports exist solely to ensure that all components are loaded and
  registered before the pipeline registry is queried or executed.

Because of this, linters may report these imports as "unused" (e.g. F401).
Such warnings are intentionally suppressed where applicable.

If you add a new transcriber or post-processor module to this package,
you must ensure it is imported here (or that auto-discovery imports it),
otherwise it will not appear in the registry.
"""

from . import faster_whisper  # noqa: F401  (import triggers decorator registration)
from . import whisperx_vad  # noqa: F401  (import triggers decorator registration)