import os
import sys
import subprocess
import shutil
import re
import logging
from typing import Optional, Tuple

logger = logging.getLogger("VODDownloader")

MAX_STORAGE_BYTES = 10 * 1024 * 1024 * 1024  # 10 GB limit

class VODDownloader:
    def __init__(self, download_dir: str = "downloads", clips_dir: str = "clips"):
        self.base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.download_dir = os.path.join(self.base_dir, download_dir)
        self.clips_dir = os.path.join(self.base_dir, clips_dir)
        os.makedirs(self.download_dir, exist_ok=True)
        os.makedirs(self.clips_dir, exist_ok=True)
        self.python_bin = sys.executable

    def get_total_storage_bytes(self) -> int:
        total = 0
        for folder in [self.download_dir, self.clips_dir]:
            for root, _, files in os.walk(folder):
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        total += os.path.getsize(fp)
                    except Exception:
                        pass
        return total

    def check_storage_limit(self) -> bool:
        """Returns True if within 10GB limit; False if exceeded."""
        current = self.get_total_storage_bytes()
        if current >= MAX_STORAGE_BYTES:
            logger.warning("Storage limit exceeded (%.2f GB / 10 GB). Purging oldest raw downloads...", current / (1024**3))
            self.auto_cleanup_oldest(target_free_bytes=2 * 1024 * 1024 * 1024)
            current = self.get_total_storage_bytes()
            if current >= MAX_STORAGE_BYTES:
                return False
        return True

    def auto_cleanup_oldest(self, target_free_bytes: int = 1024 * 1024 * 1024) -> None:
        """Deletes oldest downloaded files to free up space under 10GB."""
        files = []
        for folder in [self.download_dir, self.clips_dir]:
            for root, _, fs in os.walk(folder):
                for f in fs:
                    fp = os.path.join(root, f)
                    try:
                        files.append((fp, os.path.getmtime(fp), os.path.getsize(fp)))
                    except Exception:
                        pass

        # Sort by modification time ascending (oldest first)
        files.sort(key=lambda x: x[1])
        freed = 0
        for fp, _, size in files:
            if freed >= target_free_bytes:
                break
            try:
                os.remove(fp)
                freed += size
                logger.info("Auto-cleaned file: %s (freed %.2f MB)", fp, size / (1024 * 1024))
            except Exception:
                pass

    def delete_clip_files(self, shorts_path: Optional[str] = None, raw_path: Optional[str] = None) -> None:
        """Immediately deletes clip files after successful YouTube upload."""
        for path in [shorts_path, raw_path]:
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                    logger.info("Deleted uploaded file to save disk space: %s", path)
                except Exception as e:
                    logger.error("Failed to delete file %s: %s", path, e)

    def capture_live_segment(
        self,
        stream_url: str,
        duration_seconds: float = 120.0,
        output_filename: Optional[str] = None
    ) -> Optional[str]:
        """
        Directly captures live stream footage using streamlink in real-time.
        """
        if not self.check_storage_limit():
            logger.error("Cannot capture live stream: 10GB storage limit reached.")
            return None

        if not output_filename:
            sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", stream_url.rstrip("/").split("/")[-1])
            output_filename = f"live_{sanitized}_{int(duration_seconds)}s.mp4"

        output_path = os.path.join(self.download_dir, output_filename)
        ts_output = output_path.replace(".mp4", ".ts")

        # Streamlink command capturing live stream
        hls_dur = self._seconds_to_hms(duration_seconds)
        cmd = [
            self.python_bin, "-m", "streamlink",
            stream_url,
            "best",
            "--stream-segmented-duration", hls_dur,
            "-o", ts_output
        ]

        try:
            logger.info("Capturing live stream (%s) for %ds: %s", stream_url, int(duration_seconds), " ".join(cmd))
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=int(duration_seconds) + 60)
            if os.path.exists(ts_output) and os.path.getsize(ts_output) > 1024 * 100:
                # Fast convert TS to MP4 with stream copy
                ffmpeg_cmd = [
                    "ffmpeg", "-y", "-i", ts_output,
                    "-c:v", "copy", "-c:a", "copy",
                    "-avoid_negative_ts", "make_zero",
                    output_path
                ]
                subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
                if os.path.exists(ts_output):
                    try:
                        os.remove(ts_output)
                    except Exception:
                        pass

                if os.path.exists(output_path) and os.path.getsize(output_path) > 1024 * 100:
                    logger.info("Live capture successful: %s (%.2f MB)", output_path, os.path.getsize(output_path) / (1024 * 1024))
                    return output_path
            else:
                logger.warning("Streamlink live capture ended without sufficient data. Stderr: %s", res.stderr[:200])
        except Exception as e:
            logger.error("Live capture error: %s", e)

        return None

    def download_vod_segment(
        self,
        vod_url: str,
        start_seconds: float,
        duration_seconds: float,
        output_filename: Optional[str] = None
    ) -> Optional[str]:
        if not self.check_storage_limit():
            logger.error("Cannot download VOD segment: 10GB storage limit reached.")
            return None

        if not output_filename:
            sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", vod_url.split("/")[-1])
            output_filename = f"vod_{sanitized}_{int(start_seconds)}_{int(duration_seconds)}.mp4"

        output_path = os.path.join(self.download_dir, output_filename)

        if os.path.exists(output_path) and os.path.getsize(output_path) > 1024 * 100:
            return output_path

        hms_start = self._seconds_to_hms(start_seconds)
        hms_end = self._seconds_to_hms(start_seconds + duration_seconds)

        # Method 1: yt-dlp via python -m yt_dlp
        yt_cmd = [
            self.python_bin, "-m", "yt_dlp",
            "--download-sections", f"*{hms_start}-{hms_end}",
            "--force-keyframes-at-cuts",
            "-o", output_path,
            vod_url
        ]

        try:
            logger.info("Executing download command: %s", " ".join(yt_cmd))
            res = subprocess.run(yt_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240)
            if res.returncode == 0 and os.path.exists(output_path) and os.path.getsize(output_path) > 1024 * 50:
                logger.info("Successfully downloaded segment: %s", output_path)
                return output_path
            else:
                logger.warning("yt-dlp returned code %d. Stderr: %s", res.returncode, res.stderr[:200])
        except Exception as e:
            logger.error("yt-dlp execution error: %s", e)

        # Method 2: streamlink via python -m streamlink
        ts_output = output_path.replace(".mp4", ".ts")
        sl_cmd = [
            self.python_bin, "-m", "streamlink",
            vod_url,
            "best",
            "--stream-segmented-duration", self._seconds_to_hms(duration_seconds),
            "--hls-start-offset", hms_start,
            "-o", ts_output
        ]

        try:
            logger.info("Trying fallback streamlink: %s", " ".join(sl_cmd))
            res = subprocess.run(sl_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=240)
            if res.returncode == 0 and os.path.exists(ts_output) and os.path.getsize(ts_output) > 1024 * 50:
                ffmpeg_cmd = [
                    "ffmpeg", "-y", "-i", ts_output,
                    "-c:v", "copy", "-c:a", "copy",
                    "-avoid_negative_ts", "make_zero",
                    output_path
                ]
                subprocess.run(ffmpeg_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
                if os.path.exists(ts_output):
                    try:
                        os.remove(ts_output)
                    except Exception:
                        pass
                if os.path.exists(output_path) and os.path.getsize(output_path) > 1024 * 50:
                    return output_path
        except Exception as e:
            logger.error("streamlink fallback error: %s", e)

        return None

    @staticmethod
    def _seconds_to_hms(seconds: float) -> str:
        s = int(seconds)
        h = s // 3600
        m = (s % 3600) // 60
        sec = s % 60
        return f"{h:02d}:{m:02d}:{sec:02d}"
