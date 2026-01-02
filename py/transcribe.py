import json, sys
from faster_whisper import WhisperModel

def main():
    audio_path = sys.argv[1]
    model = WhisperModel("base", device="cpu", compute_type="int8")

    segments, info = model.transcribe(audio_path, word_timestamps=True, vad_filter=True)
    total = float(info.duration) if info.duration else None

    words_out = []
    last_pct = -1

    for seg in segments:
        # progress
        if total and seg.end is not None:
            pct = int(min(99, (float(seg.end) / total) * 100))
            if pct != last_pct:
                print(f"PROGRESS {pct}", file=sys.stderr, flush=True)
                last_pct = pct

        # words
        if seg.words:
            for w in seg.words:
                words_out.append({"word": w.word, "start": float(w.start), "end": float(w.end)})

    print("PROGRESS 100", file=sys.stderr, flush=True)

    print(json.dumps({
        "language": info.language,
        "duration": float(info.duration),
        "words": words_out
    }))

if __name__ == "__main__":
    main()