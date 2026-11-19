#!/usr/bin/env python3
"""
Fast scene cut detector using PySceneDetect.
Outputs JSON array of scene transitions and cut timestamps in seconds.
"""

import sys
import os
import json
import warnings

# Suppress stderr noise from OpenCV / AV libraries
os.environ["OPENCV_LOG_LEVEL"] = "OFF"
warnings.filterwarnings("ignore")

from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector, AdaptiveDetector

def detect_scenes(video_path, threshold=27.0, min_scene_len=15):
    if not os.path.isfile(video_path):
        return {"error": f"File not found: {video_path}", "cuts": [], "scenes": []}

    try:
        video = open_video(video_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(ContentDetector(threshold=threshold, min_scene_len=min_scene_len))
        scene_manager.detect_scenes(video)
        scene_list = scene_manager.get_scene_list()

        scenes = []
        cuts = []
        for i, scene in enumerate(scene_list):
            start_s = round(scene[0].get_seconds(), 3)
            end_s = round(scene[1].get_seconds(), 3)
            dur_s = round(end_s - start_s, 3)
            scenes.append({
                "scene": i + 1,
                "start": start_s,
                "end": end_s,
                "duration": dur_s
            })
            if i > 0:
                cuts.append(start_s)

        return {
            "cuts": cuts,
            "scenes": scenes,
            "count": len(scenes)
        }
    except Exception as e:
        return {"error": str(e), "cuts": [], "scenes": []}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: detect_scenes.py <video_path> [threshold]", "cuts": [], "scenes": []}))
        sys.exit(1)

    video_file = sys.argv[1]
    th = float(sys.argv[2]) if len(sys.argv) > 2 else 27.0
    result = detect_scenes(video_file, threshold=th)
    print(json.dumps(result))
