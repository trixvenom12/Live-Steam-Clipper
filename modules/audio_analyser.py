import os
import subprocess
import numpy as np
from scipy.io import wavfile
from typing import List, Dict, Any, Tuple

class AudioAnalyser:
    def __init__(self, temp_dir: str = "downloads"):
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.temp_dir = os.path.join(self.base_dir, temp_dir)
        os.makedirs(self.temp_dir, exist_ok=True)

    def extract_audio(self, video_path: str, output_wav: str) -> bool:
        cmd = [
            "ffmpeg", "-y", "-i", video_path,
            "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
            output_wav
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return res.returncode == 0 and os.path.exists(output_wav)

    def analyse_audio(self, video_path: str, window_seconds: float = 1.0) -> List[Dict[str, Any]]:
        wav_path = os.path.join(self.temp_dir, "temp_analysis.wav")
        if not self.extract_audio(video_path, wav_path):
            return []

        try:
            sample_rate, audio_data = wavfile.read(wav_path)
            if audio_data.dtype != np.float32:
                audio_data = audio_data.astype(np.float32) / 32768.0

            total_samples = len(audio_data)
            duration = total_samples / sample_rate
            window_samples = int(window_seconds * sample_rate)

            scores = []
            rms_list = []
            zcr_list = []

            for start in range(0, total_samples, window_samples):
                chunk = audio_data[start : start + window_samples]
                if len(chunk) < window_samples // 2:
                    break

                # RMS energy (loudness)
                rms = float(np.sqrt(np.mean(chunk**2) + 1e-9))
                rms_list.append(rms)

                # Zero crossing rate (indicates high frequency / screams / harsh sounds)
                zcr = float(np.mean(np.abs(np.diff(np.sign(chunk)))) / 2.0)
                zcr_list.append(zcr)

            if not rms_list:
                return []

            rms_arr = np.array(rms_list)
            zcr_arr = np.array(zcr_list)

            mean_rms = np.mean(rms_arr)
            std_rms = np.std(rms_arr) + 1e-6

            # Compute spike score: how many standard deviations above average
            loudness_spikes = (rms_arr - mean_rms) / std_rms
            loudness_spikes = np.clip(loudness_spikes, 0, 5.0) / 5.0

            # Scream/high-energy reaction detection (high RMS + high ZCR)
            scream_score = loudness_spikes * np.clip(zcr_arr * 5.0, 0, 1.0)

            # Silence penalty (very low RMS gets 0 score)
            silence_mask = rms_arr < (mean_rms * 0.2)

            for i in range(len(rms_list)):
                timestamp = i * window_seconds
                if silence_mask[i]:
                    combined_audio_score = 0.0
                else:
                    combined_audio_score = float(0.6 * loudness_spikes[i] + 0.4 * scream_score[i])

                scores.append({
                    "timestamp": timestamp,
                    "rms": float(rms_arr[i]),
                    "loudness_spike": float(loudness_spikes[i]),
                    "scream_score": float(scream_score[i]),
                    "audio_score": combined_audio_score,
                    "is_silent": bool(silence_mask[i])
                })

            return scores

        finally:
            if os.path.exists(wav_path):
                try:
                    os.remove(wav_path)
                except Exception:
                    pass

