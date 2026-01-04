"""
OTTER PoC - Transcriber component: WhisperX + Silero VAD

WhisperX pipeline (typical):
  1) ASR pass -> segments (coarse timestamps)
  2) Forced alignment -> word-level timestamps (more precise)

This component returns OTTER's canonical word list:
  [{"word": str, "start": float, "end": float, ...}, ...]

Notes:
- WhisperX is heavier than faster-whisper (extra alignment model + deps).
- Progress reporting is approximate (segment-based) but useful for UI.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple, Optional

from otter_py.pipeline_registry import register_transcriber

Word = Dict[str, Any]


@register_transcriber(
    id="whisperx_silero",
    label="WhisperX + Silero VAD (local)",
    description="WhisperX transcription + forced alignment for word-level timestamps, with Silero VAD segmentation.",
    options_schema={
        "type": "object",
        "properties": {
            # ASR model (WhisperX wraps whisper / faster-whisper internally depending on install)
            "model": {
                "type": "string",
                "description": "Whisper/WhisperX ASR model name (e.g., base, small, medium, large-v2, large-v3).",
                "default": "base",
            },
            "device": {
                "type": "string",
                "description": "Device for inference (cpu, cuda, mps depending on install).",
                "default": "cpu",
            },
            "compute_type": {
                "type": "string",
                "description": "Compute type (e.g., int8, float16).",
                "default": "int8",
            },

            # Language / batching
            "language": {
                "type": ["string", "null"],
                "description": "Force language code (e.g., 'en') or null to auto-detect.",
                "default": None,
            },
            "batch_size": {
                "type": "integer",
                "description": "Batch size for WhisperX ASR. Higher can be faster but uses more memory.",
                "default": 8,
                "minimum": 1,
                "maximum": 64,
            },

            # Silero VAD toggles/options (WhisperX supports passing vad_options)
            "vad_filter": {
                "type": "boolean",
                "description": "Enable VAD-based segmentation to skip non-speech.",
                "default": True,
            },
            "vad_onset": {
                "type": ["number", "null"],
                "description": "Optional Silero VAD onset tuning (if supported by your WhisperX version).",
                "default": None,
            },
            "vad_offset": {
                "type": ["number", "null"],
                "description": "Optional Silero VAD offset tuning (if supported by your WhisperX version).",
                "default": None,
            },

            # Alignment model (WhisperX chooses defaults based on language if omitted)
            "align_model": {
                "type": ["string", "null"],
                "description": "Optional alignment model override (e.g. wav2vec2.0 model name).",
                "default": None,
            },
        },
        "additionalProperties": True,
    },
)
def transcribe_whisperx_silero(
    audio_path: str,
    opts: Dict[str, Any],
    ctx: Dict[str, Any],
) -> Tuple[List[Word], Dict[str, Any]]:
    """
    Transcriber entry point for the OTTER pipeline system.

    ctx:
      - ctx["progress"] (callable): called with integer pct 0..100
      - ctx["_model_cache"] (dict): optional cache for loaded models across runs
    """
    import whisperx  # local import so registry import doesn't fail if deps missing

    progress_cb = ctx.get("progress") if callable(ctx.get("progress")) else None

    def emit(p: int) -> None:
        if progress_cb:
            progress_cb(max(0, min(100, int(p))))

    model_name = str(opts.get("model", "base"))
    device = str(opts.get("device", "cpu"))
    compute_type = str(opts.get("compute_type", "int8"))

    language: Optional[str] = opts.get("language", None)
    batch_size = int(opts.get("batch_size", 8))

    vad_filter = bool(opts.get("vad_filter", True))
    vad_onset = opts.get("vad_onset", None)
    vad_offset = opts.get("vad_offset", None)

    align_model_override: Optional[str] = opts.get("align_model", None)

    # Build VAD options dict only if values are provided.
    vad_options: Dict[str, Any] = {}
    if vad_onset is not None:
        vad_options["vad_onset"] = float(vad_onset)
    if vad_offset is not None:
        vad_options["vad_offset"] = float(vad_offset)

    # Cache WhisperX ASR model instances (helpful for iterative experiments)
    cache = ctx.setdefault("_model_cache", {})
    asr_key = ("whisperx_asr", model_name, device, compute_type, vad_filter, tuple(sorted(vad_options.items())))
    if asr_key in cache:
        asr_model = cache[asr_key]
    else:
        # WhisperX supports passing vad_options to load_model in many versions.
        # (Exact support varies by version; if your install doesn't accept vad_options,
        #  drop it and only use vad_filter at transcribe-time.)
        asr_model = whisperx.load_model(
            model_name,
            device=device,
            compute_type=compute_type,
            vad_options=vad_options if vad_options else None,
        )
        cache[asr_key] = asr_model

    emit(0)

    # 1) ASR transcription (segment-level)
    # WhisperX returns dict with "segments" and "language"
    result = asr_model.transcribe(
        audio_path,
        batch_size=batch_size,
        language=language,
        vad_filter=vad_filter,
    )

    segments = result.get("segments", []) or []
    detected_lang = result.get("language", None)
    lang_for_align = language or detected_lang

    # crude progress: ASR done
    emit(60)

    # 2) Alignment model load (cache by language/device/override)
    if not lang_for_align:
        # If language couldn't be determined, WhisperX may still align for some defaults,
        # but it's safer to fail loudly in the PoC.
        raise RuntimeError("WhisperX did not return a language; cannot select alignment model. Provide opts.language.")

    align_key = ("whisperx_align", lang_for_align, device, align_model_override)
    if align_key in cache:
        align_model, align_metadata = cache[align_key]
    else:
        align_model, align_metadata = whisperx.load_align_model(
            language_code=lang_for_align,
            device=device,
            model_name=align_model_override,
        )
        cache[align_key] = (align_model, align_metadata)

    emit(75)

    # 3) Forced alignment to produce word-level timestamps
    aligned = whisperx.align(
        segments,
        align_model,
        align_metadata,
        audio_path,
        device=device,
        return_char_alignments=False,
    )

    emit(95)

    # Flatten to OTTER words
    words_out: List[Word] = []
    for seg in aligned.get("segments", []) or []:
        for w in seg.get("words", []) or []:
            # WhisperX typically uses "word", "start", "end" keys
            if "word" in w and "start" in w and "end" in w:
                words_out.append(
                    {
                        "word": w["word"],
                        "start": float(w["start"]),
                        "end": float(w["end"]),
                        # Optional fields:
                        **({"conf": float(w["score"])} if "score" in w and w["score"] is not None else {}),
                    }
                )

    emit(100)

    meta: Dict[str, Any] = {
        "engine": "whisperx",
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "language": lang_for_align,
        "batch_size": batch_size,
        "vad_filter": vad_filter,
        "vad_options": vad_options,
        "align_model_override": align_model_override,
        "segments": len(segments),
        "words": len(words_out),
    }

    return words_out, meta