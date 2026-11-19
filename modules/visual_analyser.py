import os
import cv2
import numpy as np
from typing import List, Dict, Any

class VisualAnalyser:
    def __init__(self, sample_fps: float = 2.0):
        self.sample_fps = sample_fps

    def analyse_video(self, video_path: str) -> List[Dict[str, Any]]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return []

        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        frame_interval = max(int(fps / self.sample_fps), 1)

        prev_gray = None
        scores = []
        frame_idx = 0

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            if frame_idx % frame_interval == 0:
                timestamp = frame_idx / fps
                small = cv2.resize(frame, (320, 180))
                gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

                if prev_gray is not None:
                    # Motion energy: frame difference
                    diff = cv2.absdiff(gray, prev_gray)
                    motion_score = float(np.mean(diff) / 50.0)
                    motion_score = min(max(motion_score, 0.0), 1.0)

                    # Brightness / flash shift (explosion or muzzle flash)
                    curr_brightness = np.mean(gray)
                    prev_brightness = np.mean(prev_gray)
                    flash_score = float(abs(curr_brightness - prev_brightness) / 60.0)
                    flash_score = min(max(flash_score, 0.0), 1.0)

                    visual_score = float(0.7 * motion_score + 0.3 * flash_score)
                else:
                    motion_score = 0.0
                    flash_score = 0.0
                    visual_score = 0.0

                prev_gray = gray
                scores.append({
                    "timestamp": timestamp,
                    "motion_score": motion_score,
                    "flash_score": flash_score,
                    "visual_score": visual_score
                })

            frame_idx += 1

        cap.release()
        return scores

