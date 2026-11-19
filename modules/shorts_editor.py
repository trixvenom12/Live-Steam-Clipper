import os
import subprocess
import shutil
import random
from typing import Optional, List, Dict, Any
from modules.subtitle_generator import SubtitleGenerator

class ShortsEditor:
    def __init__(self, output_dir: str = "clips"):
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.output_dir = os.path.join(self.base_dir, output_dir)
        os.makedirs(self.output_dir, exist_ok=True)
        self.sub_gen = SubtitleGenerator()

    def create_shorts(
        self,
        input_video_path: str,
        output_filename: str,
        start_time: float,
        duration: float,
        speech_segments: Optional[List[Dict[str, Any]]] = None,
        enable_subtitles: bool = True,
        layout: str = "auto"
    ) -> Optional[str]:
        output_path = os.path.join(self.output_dir, output_filename)

        # 1. First extract raw subclip accurately
        raw_clip_path = os.path.join(self.output_dir, f"raw_{output_filename}")
        extract_cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_time),
            "-i", input_video_path,
            "-t", str(duration),
            "-c:v", "libx264", "-preset", "fast", "-crf", "18",
            "-c:a", "aac", "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            raw_clip_path
        ]

        res = subprocess.run(extract_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res.returncode != 0 or not os.path.exists(raw_clip_path):
            return None

        # 2. Generate subtitles if enabled
        ass_path = None
        if enable_subtitles and speech_segments:
            ass_path = os.path.join(self.output_dir, f"subs_{output_filename}.ass")
            self.sub_gen.generate_ass(speech_segments, clip_start_offset=start_time, output_ass_path=ass_path)

        # 3. Choose layout style: "blurred" vs "stacked" (Gameplay top, Facecam bottom)
        chosen_layout = layout
        if layout == "auto":
            chosen_layout = random.choice(["blurred", "stacked"])

        if chosen_layout == "stacked":
            # Stacked: Upper 1080x1080 is gameplay, lower 1080x840 is streamer facecam
            filter_complex = (
                "[0:v]crop=w=iw:h=ih*0.72:x=0:y=0,scale=1080:1080[top];"
                "[0:v]crop=w=iw*0.45:h=ih*0.55:x=iw*0.55:y=ih*0.45,scale=1080:840[bottom];"
                "[top][bottom]vstack=inputs=2[merged]"
            )
        else:
            # Blurred background + sharp centered 16:9 gameplay
            filter_complex = (
                "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
                "crop=1080:1920,gblur=sigma=25[bg];"
                "[0:v]scale=1080:-2[fg];"
                "[bg][fg]overlay=(W-w)/2:(H-h)/2[merged]"
            )

        video_stream_label = "[merged]"

        if ass_path and os.path.exists(ass_path):
            escaped_ass = ass_path.replace("\\", "/").replace(":", "\\:")
            filter_complex += f";[merged]ass='{escaped_ass}'[v]"
            video_stream_label = "[v]"

        render_cmd = [
            "ffmpeg", "-y",
            "-i", raw_clip_path,
            "-filter_complex", filter_complex,
            "-map", video_stream_label,
            "-map", "0:a?",
            "-c:v", "libx264", "-preset", "fast", "-crf", "20",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p",
            output_path
        ]

        try:
            render_res = subprocess.run(render_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
            if render_res.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024 * 50:
                return output_path
        finally:
            if ass_path and os.path.exists(ass_path):
                try:
                    os.remove(ass_path)
                except Exception:
                    pass
            if os.path.exists(raw_clip_path):
                try:
                    os.remove(raw_clip_path)
                except Exception:
                    pass

        return None
