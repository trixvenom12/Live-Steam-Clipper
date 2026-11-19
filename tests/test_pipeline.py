import os
import sys
import unittest
import numpy as np
from scipy.io import wavfile
import cv2

# Add parent dir to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from modules.database import init_db, add_vod, is_vod_processed, add_clip, get_daily_upload_count
from modules.twitch_discovery import TwitchDiscovery
from modules.audio_analyser import AudioAnalyser
from modules.speech_analyser import SpeechAnalyser
from modules.visual_analyser import VisualAnalyser
from modules.subtitle_generator import SubtitleGenerator
from modules.metadata_generator import MetadataGenerator, MANDATORY_HASHTAGS
from modules.shorts_editor import ShortsEditor

class TestClipperPipeline(unittest.TestCase):

    def setUp(self):
        self.test_dir = os.path.join(os.path.dirname(__file__), "test_assets")
        os.makedirs(self.test_dir, exist_ok=True)

    def test_01_database(self):
        db_path = os.path.join(self.test_dir, "test.db")
        if os.path.exists(db_path):
            os.remove(db_path)
        init_db(db_path)

        # Test add vod
        added = add_vod("test_vod_1", "Shroud", "123", "GTA 6 First Gameplay", "https://twitch.tv/videos/1", 3600, "en", "2026-11-18", db_path)
        self.assertTrue(added)
        # Duplicate should return False
        dup = add_vod("test_vod_1", "Shroud", "123", "GTA 6 First Gameplay", "https://twitch.tv/videos/1", 3600, "en", "2026-11-18", db_path)
        self.assertFalse(dup)

        self.assertFalse(is_vod_processed("test_vod_1", db_path))

        # Add clip
        add_clip("clip_1", "test_vod_1", 10.0, 45.0, 35.0, 0.85, {"test": 1}, "raw.mp4", "short.mp4", "Title", "Desc", "tags", "generated", db_path)
        count = get_daily_upload_count(db_path)
        self.assertEqual(count, 0)

    def test_02_metadata_generator(self):
        mg = MetadataGenerator(target_region="UK")

        # Case 1: Police chase content
        meta = mg.generate_metadata("The police are shooting and chasing us, run!", "StreamerX", "GTA VI Live")
        self.assertTrue(meta["title"].endswith(MANDATORY_HASHTAGS))
        self.assertIn("#shorts", meta["title"])
        self.assertIn("#gtavi", meta["title"])
        self.assertIn("#gta6", meta["title"])
        self.assertIn("StreamerX", meta["description"])
        self.assertTrue(len(meta["tags"]) > 5)

        # Validation check
        valid, errors = mg.validate_metadata(meta)
        self.assertTrue(valid, f"Validation errors: {errors}")

        # Enforce title rules check
        bad_title = "Crazy GTA Moment #gaming #viral"
        fixed = mg.enforce_title_rules(bad_title)
        self.assertTrue(fixed.endswith(MANDATORY_HASHTAGS))
        self.assertNotIn("#viral", fixed)

    def test_03_subtitle_generator(self):
        sg = SubtitleGenerator()
        ass_path = os.path.join(self.test_dir, "test.ass")
        segments = [
            {
                "start": 0.0, "end": 2.5, "text": "Look at that car flying",
                "words": [
                    {"word": "Look", "start": 0.0, "end": 0.5},
                    {"word": "at", "start": 0.5, "end": 0.8},
                    {"word": "that", "start": 0.8, "end": 1.2},
                    {"word": "car", "start": 1.2, "end": 1.8},
                    {"word": "flying", "start": 1.8, "end": 2.5}
                ]
            }
        ]
        ok = sg.generate_ass(segments, clip_start_offset=0.0, output_ass_path=ass_path)
        self.assertTrue(ok)
        self.assertTrue(os.path.exists(ass_path))
        with open(ass_path, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("Dialogue: 0,", content)
        self.assertIn("LOOK AT THAT", content)

    def test_04_audio_visual_analysis(self):
        # Create a synthetic 5-second test video with 1-second loud beep
        video_path = os.path.join(self.test_dir, "synth_video.mp4")

        # Generate audio: 440Hz sine wave with spike at 2-3s
        sr = 16000
        dur = 5.0
        t = np.linspace(0, dur, int(sr * dur), endpoint=False)
        audio = 0.05 * np.sin(2 * np.pi * 440 * t)
        # Spike
        spike_start = int(2.0 * sr)
        spike_end = int(3.0 * sr)
        audio[spike_start:spike_end] = 0.9 * np.sin(2 * np.pi * 880 * t[spike_start:spike_end])
        audio_int16 = (audio * 32767).astype(np.int16)

        wav_path = os.path.join(self.test_dir, "synth_audio.wav")
        wavfile.write(wav_path, sr, audio_int16)

        # Generate simple video frames: 5 seconds, 10 fps
        fps = 10
        width, height = 320, 240
        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        vw = cv2.VideoWriter(video_path, fourcc, fps, (width, height))
        for f in range(int(dur * fps)):
            # Create motion spike at frame 20-30
            val = 255 if 20 <= f <= 30 else 50
            frame = np.full((height, width, 3), val, dtype=np.uint8)
            vw.write(frame)
        vw.release()

        # Combine video and audio with ffmpeg
        combined_path = os.path.join(self.test_dir, "synth_combined.mp4")
        import subprocess
        subprocess.run([
            "ffmpeg", "-y", "-i", video_path, "-i", wav_path,
            "-c:v", "libx264", "-c:a", "aac", combined_path
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # Run Audio Analyser
        aa = AudioAnalyser(temp_dir=self.test_dir)
        a_scores = aa.analyse_audio(combined_path)
        self.assertTrue(len(a_scores) > 0)
        # Verify spike around 2-3s
        spike_detected = any(s["timestamp"] in [2.0, 3.0] and s["loudness_spike"] > 0.3 for s in a_scores)
        self.assertTrue(spike_detected)

        # Run Visual Analyser
        va = VisualAnalyser(sample_fps=2.0)
        v_scores = va.analyse_video(combined_path)
        self.assertTrue(len(v_scores) > 0)
        # Verify visual score peak around 2s
        vis_peak = any(s["visual_score"] > 0.3 for s in v_scores)
        self.assertTrue(vis_peak)

    def test_05_twitch_discovery(self):
        td = TwitchDiscovery()
        token = td._ensure_token()
        self.assertTrue(bool(token))

        game_id = td.get_game_id("Grand Theft Auto VI")
        self.assertEqual(game_id, "1867279146")

        streams = td.discover_live_streams(game_id=game_id, limit=5)
        self.assertIsInstance(streams, list)

        vods = td.discover_vods(game_id=game_id, limit=5)
        self.assertIsInstance(vods, list)

if __name__ == "__main__":
    unittest.main()
