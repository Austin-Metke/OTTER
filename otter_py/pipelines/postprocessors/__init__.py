"""
Post-processor component package.

Each module in this package defines a single post-processor and registers it
with the global pipeline registry using the @register_postprocessor decorator.

Important architectural note:
- Registration occurs at IMPORT TIME as a side effect of loading the module.
- The imports below are intentionally present even though the imported symbols
  are not referenced directly in this file.
- Linters may report these imports as "unused" (e.g. F401); such warnings are
  expected and suppressed where appropriate.

If you add a new post-processor module to this package, you MUST import it here
(or ensure it is imported via auto-discovery), otherwise it will not appear in
the registry and cannot be selected by the application.
"""

# Import modules for side effects (registration)
from . import adjust_short_words     # noqa: F401
from . import clean_word_timings     # noqa: F401
