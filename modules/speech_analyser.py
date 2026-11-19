import os
import re
import subprocess
import numpy as np
from typing import List, Dict, Any, Optional
from faster_whisper import WhisperModel

class SpeechAnalyser:
    def __init__(self, model_size: str = "base", device: str = "cpu", compute_type: str = "int8"):
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self._model: Optional[WhisperModel] = None

        self.excitement_keywords = {
            "no way": 1.0, "omg": 1.0, "oh my god": 1.0, "wtf": 1.0, "what the": 0.9,
            "insane": 0.9, "holy shit": 1.0, "are you kidding": 0.9, "look at this": 0.8,
            "look at that": 0.8, "bro": 0.6, "dude": 0.6, "mate": 0.8, "blimey": 1.0,
            "swear down": 1.0, "proper": 0.7, "madness": 0.9, "mental": 0.9,
            "police": 0.8, "cops": 0.8, "run": 0.8, "dead": 0.7, "crash": 0.9,
            "exploded": 1.0, "explosion": 1.0, "unbelievable": 0.9, "hilarious": 0.9,
            "haha": 0.8, "lmao": 0.9, "died": 0.7, "glitch": 0.9, "bug": 0.8
        }

    def _get_model(self) -> WhisperModel:
        if self._model is None:
            self._model = WhisperModel(self.model_size, device=self.device, compute_type=self.compute_type)
        return self._model

    def _load_audio(self, file_path: str, sr: int = 16000) -> np.ndarray:
        """
        Reliable audio extraction using ffmpeg directly into numpy float32.
        Bypasses PyAV container compatibility issues completely.
        """
        cmd = [
            "ffmpeg", "-nostdin", "-threads", "0", "-i", file_path,
            "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", str(sr), "-"
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0:
            raise RuntimeError(f"FFmpeg failed to extract audio: {res.stderr[:200]}")
        return np.frombuffer(res.stdout, np.int16).flatten().astype(np.float32) / 32768.0

    def transcribe(self, audio_or_video_path: str) -> Dict[str, Any]:
        model = self._get_model()

        # Load audio via ffmpeg
        if isinstance(audio_or_video_path, str):
            audio = self._load_audio(audio_or_video_path)
        else:
            audio = audio_or_video_path

        segments, info = model.transcribe(
            audio,
            beam_size=3,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )

        results = []
        full_transcript = []

        for seg in segments:
            text = seg.text.strip()
            full_transcript.append(text)

            words_data = []
            if seg.words:
                for w in seg.words:
                    words_data.append({
                        "word": w.word,
                        "start": w.start,
                        "end": w.end,
                        "probability": w.probability
                    })

            score = self._score_text(text)

            results.append({
                "start": seg.start,
                "end": seg.end,
                "text": text,
                "speech_score": score,
                "words": words_data
            })

        return {
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": results,
            "full_text": " ".join(full_transcript)
        }

    def _score_text(self, text: str) -> float:
        text_lower = text.lower()
        score = 0.0

        for kw, weight in self.excitement_keywords.items():
            if kw in text_lower:
                score += weight

        exclamation_count = text.count("!")
        score += min(exclamation_count * 0.2, 0.6)

        words = text.split()
        if words:
            caps_words = [w for w in words if w.isupper() and len(w) > 1]
            score += min(len(caps_words) * 0.15, 0.6)

        return float(min(score, 1.0))
