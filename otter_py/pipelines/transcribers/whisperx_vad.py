"""
OTTER PoC - Transcriber component: WhisperX + Silero VAD

WhisperX pipeline (typical):
  1) ASR pass -> segments (coarse timestamps)
  2) Forced alignment -> word-level timestamps (more precise)

This component returns OTTER's canonical word list:
  [{"word": str, "start": float, "end": float, ...}, ...]

PoC choices:
- We force VAD to Silero via vad_method="silero".
  This avoids the pyannote-based VAD code path that can trigger PyTorch
  2.6+ "weights_only" checkpoint loading issues (OmegaConf allowlisting).
- We keep the option surface minimal and stable: model/device/compute_type,
  language (optional), batch_size, and optional align_model override.

Notes:
- WhisperX is heavier than faster-whisper (extra alignment model + deps).
- Progress reporting is approximate but useful for UI.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple, Optional

from otter_py.pipeline_registry import register_transcriber
from otter_py.otter_debug import dbg, DebugLevel

Word = Dict[str, Any]


@register_transcriber(
    id="whisperx_vad",
    label="WhisperX + Silero VAD (local)",
    description="WhisperX transcription + forced alignment for word-level timestamps, using Silero VAD segmentation.",
    options_schema={
        "type": "object",
        "properties": {
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
            "align_model": {
                "type": ["string", "null"],
                "description": "Optional alignment model override (model_name passed to whisperx.load_align_model).",
                "default": None,
            },
        },
        "additionalProperties": True,
    },
)
def transcribe_whisperx_vad(
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

    dbg("Entered transcribe_whisperx_vad")
    
    # Note:
    # WhisperX pulls in pyannote/speechbrain dependencies which currently emit
    # deprecation warnings about torchaudio.list_audio_backends(). These warnings
    # are upstream (TorchAudio → WhisperX) and not actionable here, so we suppress
    # them locally to keep PoC output readable.
    import warnings
    warnings.filterwarnings(
        "ignore",
        message=".*torchaudio\\._backend\\.list_audio_backends has been deprecated.*",
        category=UserWarning,
    )

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
    align_model_override: Optional[str] = opts.get("align_model", None)

    cache: Dict[Any, Any] = ctx.setdefault("_model_cache", {})

    emit(0)

    # 1) Load ASR model (cached)
    asr_key = ("whisperx_asr", model_name, device, compute_type, "silero")
    if asr_key in cache:
        asr_model = cache[asr_key]
    else:
        # Force Silero VAD to avoid pyannote VAD checkpoint loads.
        asr_model = whisperx.load_model(
            model_name,
            device=device,
            compute_type=compute_type,
            vad_method="silero",
        )
        cache[asr_key] = asr_model

    emit(10)

    # 2) Load audio for WhisperX
    audio = whisperx.load_audio(audio_path)
    emit(15)

    # 3) ASR transcription (segment-level)
    # WhisperX returns dict with "segments" and "language"
    result = asr_model.transcribe(
        audio,
        batch_size=batch_size,
        language=language,
    )
    segments = result.get("segments", []) or []
    detected_lang = result.get("language", None)
    lang_for_align = language or detected_lang

    emit(70)

    # 4) Alignment model load (cached)
    if not lang_for_align:
        raise RuntimeError(
            "WhisperX did not return a language; cannot select alignment model. "
            "Provide opts.language (e.g., 'en')."
        )

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

    # 5) Forced alignment to produce word-level timestamps
    aligned = whisperx.align(
        segments,
        align_model,
        align_metadata,
        audio,
        device,
        return_char_alignments=False,
    )

    emit(95)

    # 6) Flatten to OTTER words
    words_out: List[Word] = []
    for seg in aligned.get("segments", []) or []:
        for w in seg.get("words", []) or []:
            if "word" in w and "start" in w and "end" in w:
                words_out.append(
                    {
                        "word": w["word"],
                        "start": float(w["start"]),
                        "end": float(w["end"]),
                        **(
                            {"conf": float(w["score"])}
                            if "score" in w and w["score"] is not None
                            else {}
                        ),
                    }
                )

    emit(100)

    meta: Dict[str, Any] = {
        "engine": "whisperx",
        "vad_method": "silero",
        "model": model_name,
        "device": device,
        "compute_type": compute_type,
        "language": lang_for_align,
        "batch_size": batch_size,
        "align_model_override": align_model_override,
        "segments": len(segments),
        "words": len(words_out),
    }

    return words_out, meta