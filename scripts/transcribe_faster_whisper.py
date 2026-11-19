#!/usr/bin/env python3
"""
Transcription engine using faster-whisper with Silero VAD, word-level timestamps,
and Apple Silicon MPS GPU acceleration.
Outputs standard JSON: { "text": "...", "words": [{ "text": "...", "start": 0.0, "end": 0.5 }] }
"""

import sys
import os
import json
import warnings

# Suppress tokenizers warning & stderr noise
os.environ["TOKENIZERS_PARALLELISM"] = "false"
warnings.filterwarnings("ignore")

import ctranslate2
from faster_whisper import WhisperModel

def get_optimal_device():
    # Detect Apple Silicon MPS GPU support
    try:
        mps_types = ctranslate2.get_supported_compute_types("mps")
        if mps_types:
            compute_type = "float16" if "float16" in mps_types else "int8"
            return "mps", compute_type
    except Exception:
        pass
    return "cpu", "int8"

def transcribe_file(audio_path, model_size="small.en"):
    if not os.path.isfile(audio_path):
        return {"error": f"Audio file not found: {audio_path}", "text": "", "words": []}

    device, compute_type = get_optimal_device()

    try:
        model = WhisperModel(model_size, device=device, compute_type=compute_type)
    except Exception:
        # Fallback to CPU int8 if MPS encounters memory/driver constraint
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

    try:
        segments, info = model.transcribe(
            audio_path,
            beam_size=5,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400)
        )

        words = []
        text_segments = []

        for segment in segments:
            text_segments.append(segment.text.strip())
            if segment.words:
                for w in segment.words:
                    clean = w.word.strip()
                    if clean:
                        words.append({
                            "text": clean,
                            "start": round(w.start, 3),
                            "end": round(w.end, 3),
                            "probability": round(getattr(w, "probability", 1.0), 3)
                        })

        full_text = " ".join(text_segments).strip()
        return {
            "text": full_text,
            "words": words,
            "language": info.language,
            "duration": round(info.duration, 3)
        }
    except Exception as e:
        return {"error": str(e), "text": "", "words": []}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcribe_faster_whisper.py <audio_path> [model_size]", "text": "", "words": []}))
        sys.exit(1)

    audio_file = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small.en"
    res = transcribe_file(audio_file, model_name)
    print(json.dumps(res))
