import os
import sys
import time
import random
import uuid
import subprocess
import logging
from typing import Dict, Any, Optional, List

from modules.twitch_discovery import TwitchDiscovery
from modules.vod_downloader import VODDownloader
from modules.highlight_detector import HighlightDetector
from modules.shorts_editor import ShortsEditor
from modules.metadata_generator import MetadataGenerator
from modules.youtube_uploader import YouTubeUploader
from modules import database

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("Scheduler")

class Scheduler:
    def __init__(
        self,
        poll_interval_seconds: int = 60,
        live_capture_duration_seconds: float = 180.0,
        max_clips_per_capture: int = 1,
        max_daily_uploads: int = 15,
        min_upload_gap_seconds: int = 480,   # 8 minutes
        max_upload_gap_seconds: int = 600,   # 10 minutes
        min_highlight_score: float = 0.40,
        target_clip_duration: float = 45.0,
        game_id: str = "1867279146",         # GTA VI
        focus_live: bool = True,
        preferred_language: str = "en"
    ):
        self.poll_interval_seconds = poll_interval_seconds
        self.live_capture_duration_seconds = live_capture_duration_seconds
        self.max_clips_per_capture = max_clips_per_capture
        self.max_daily_uploads = max_daily_uploads
        self.min_upload_gap_seconds = min_upload_gap_seconds
        self.max_upload_gap_seconds = max_upload_gap_seconds
        self.min_highlight_score = min_highlight_score
        self.target_clip_duration = target_clip_duration
        self.game_id = game_id
        self.focus_live = focus_live
        self.preferred_language = preferred_language
        self.recent_streamers: List[str] = []

        self.twitch = TwitchDiscovery()
        self.downloader = VODDownloader()
        self.detector = HighlightDetector(target_clip_duration=target_clip_duration)
        self.editor = ShortsEditor()
        self.meta_gen = MetadataGenerator(target_region="UK")
        self.uploader = YouTubeUploader()
        self.is_running = False

    def check_speed_youtube_live(self) -> Optional[Dict[str, Any]]:
        """Checks if IShowSpeed is currently streaming live on YouTube."""
        url = "https://www.youtube.com/@IShowSpeed/live"
        try:
            cmd = [sys.executable, "-m", "yt_dlp", "--print", "%(id)s;%(title)s;%(is_live)s", url]
            res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
            if res.returncode == 0 and res.stdout.strip():
                parts = res.stdout.strip().split(";")
                is_live = parts[2].lower() == "true" if len(parts) >= 3 else True
                if is_live:
                    return {
                        "user_name": "IShowSpeed",
                        "user_login": "ishowspeed",
                        "title": parts[1] if len(parts) >= 2 else "IShowSpeed GTA 6 Live",
                        "stream_url": url,
                        "id": parts[0],
                        "platform": "youtube",
                        "viewer_count": 60000,
                        "is_uk_likely": False
                    }
        except Exception:
            pass
        return None

    def run_single_cycle(self) -> Dict[str, Any]:
        """
        Executes one cycle:
        1. Checks daily upload limit (15/day).
        2. Checks 10GB disk storage limit.
        3. Discovers IShowSpeed (YouTube) & English Twitch GTA 6 live streams.
        4. Captures live stream footage.
        5. Detects viral moment.
        6. Converts to 9:16 Shorts (alternates blurred background & stacked facecam).
        7. Generates relatable AI metadata with mandatory #shorts #gtavi #gta6.
        8. Uploads to YouTube as PUBLIC.
        9. Auto-deletes local files after upload.
        10. Waits random 8-10 min gap before next upload.
        """
        daily_uploads = database.get_daily_upload_count()
        if daily_uploads >= self.max_daily_uploads:
            logger.info("Daily upload limit reached: %d/%d", daily_uploads, self.max_daily_uploads)
            return {"status": "skipped", "reason": "daily_limit_reached"}

        if not self.downloader.check_storage_limit():
            logger.error("Storage limit reached (10GB). Halting until space is freed.")
            return {"status": "error", "reason": "storage_limit_10gb"}

        total_clips_uploaded = 0
        streams_processed = 0

        logger.info("Checking for LIVE GTA 6 streams (Speed + English Twitch) - Today: %d/%d...",
                    daily_uploads, self.max_daily_uploads)
        database.log_event("INFO", "Scheduler", f"Discovering LIVE GTA 6 streams ({daily_uploads}/{self.max_daily_uploads})")

        stream_queue = []

        # 1. Check IShowSpeed YouTube live stream first
        speed_stream = self.check_speed_youtube_live()
        if speed_stream:
            logger.info("IShowSpeed is LIVE on YouTube: %s", speed_stream["title"])
            stream_queue.append(speed_stream)

        # 2. Discover English Twitch live streams
        live_streams = self.twitch.discover_live_streams(
            game_id=self.game_id,
            language=self.preferred_language,
            limit=20
        )

        # Sort Twitch streams: preferred English creators first (KaiCenat, Jynxzi, etc.)
        preferred_names = ["kaicenat", "jynxzi", "stableronaldo", "xqcow", "ohnepixel", "theburntpeanut", "zackrawrr"]
        def twitch_priority(s):
            login = (s.get("user_login") or s.get("user_name", "")).lower()
            prio = 50 if any(p in login for p in preferred_names) else 0
            if s.get("is_uk_likely"):
                prio += 20
            return (prio, s.get("viewer_count", 0))

        live_streams.sort(key=twitch_priority, reverse=True)

        for s in live_streams:
            channel_name = s.get("user_name", "Streamer")
            channel_login = s.get("user_login") or channel_name.lower().replace(" ", "")
            stream_queue.append({
                "user_name": channel_name,
                "user_login": channel_login,
                "title": s.get("title", "GTA 6 Live Gameplay"),
                "stream_url": f"https://www.twitch.tv/{channel_login}",
                "id": str(s.get("id")),
                "platform": "twitch",
                "viewer_count": s.get("viewer_count", 0),
                "is_uk_likely": s.get("is_uk_likely", False)
            })

        # Fair rotation: Streamers NOT clipped recently get top priority
        def queue_rotation(s):
            login = s.get("user_login", "").lower()
            recently_clipped = 1 if login in self.recent_streamers else 0
            is_featured = 1 if any(p in login for p in ["speed", "kai", "jynxzi", "ronaldo", "xqc"]) else 0
            # Unclipped streamers first (recently_clipped=0), then featured creators, then viewers
            return (recently_clipped, -is_featured, -s.get("viewer_count", 0))

        stream_queue.sort(key=queue_rotation)
        logger.info("Total stream candidates queued: %d (Rotation: %s)", len(stream_queue), self.recent_streamers)

        for stream in stream_queue:
            if total_clips_uploaded + daily_uploads >= self.max_daily_uploads:
                logger.info("Daily target reached: %d/%d", total_clips_uploaded + daily_uploads, self.max_daily_uploads)
                break

            channel_name = stream["user_name"]
            stream_title = stream["title"]
            stream_url = stream["stream_url"]
            stream_id = stream["id"]

            logger.info("Connecting directly to LIVE stream [%s]: %s by %s (Viewers: %d)",
                        stream.get("platform", "stream"), stream_url, channel_name, stream.get("viewer_count", 0))

            # Capture directly from live stream
            live_file = self.downloader.capture_live_segment(
                stream_url=stream_url,
                duration_seconds=self.live_capture_duration_seconds
            )

            if not live_file or not os.path.exists(live_file):
                logger.warning("Failed to capture live stream for %s", channel_name)
                continue

            # Run AI Highlight detection on live segment
            try:
                highlights = self.detector.detect_highlights(
                    video_path=live_file,
                    vod_id=stream_id,
                    total_duration=self.live_capture_duration_seconds,
                    max_highlights=self.max_clips_per_capture,
                    min_score=self.min_highlight_score
                )
            except Exception as e:
                logger.error("Highlight detection failed on live capture: %s", e)
                if os.path.exists(live_file):
                    try:
                        os.remove(live_file)
                    except Exception:
                        pass
                continue

            if not highlights:
                logger.info("No highlights above threshold in captured live segment of %s", channel_name)
                if os.path.exists(live_file):
                    try:
                        os.remove(live_file)
                    except Exception:
                        pass
                continue

            logger.info("Detected %d highlight(s) from live stream of %s!", len(highlights), channel_name)

            for hl in highlights:
                if total_clips_uploaded + daily_uploads >= self.max_daily_uploads:
                    break

                clip_id = str(uuid.uuid4())[:8]
                short_filename = f"live_short_{clip_id}.mp4"

                # Edit into 9:16 vertical Short (alternating blurred background & stacked facecam)
                short_path = self.editor.create_shorts(
                    input_video_path=live_file,
                    output_filename=short_filename,
                    start_time=hl["start"],
                    duration=hl["duration"],
                    speech_segments=hl.get("segments", []),
                    enable_subtitles=True,
                    layout="auto"
                )

                if not short_path or not os.path.exists(short_path):
                    logger.error("Failed to render vertical short for clip %s", clip_id)
                    continue

                # Generate relatable AI metadata
                metadata = self.meta_gen.generate_metadata(
                    transcript_text=hl.get("text", ""),
                    streamer_name=channel_name,
                    vod_title=stream_title,
                    highlight_score=hl.get("highlight_score", 0.8)
                )

                # Save to DB
                database.add_clip(
                    clip_id=clip_id,
                    vod_id=stream_id,
                    start_time=hl["start"],
                    end_time=hl["end"],
                    duration=hl["duration"],
                    highlight_score=hl["highlight_score"],
                    score_breakdown=hl.get("score_breakdown", {}),
                    raw_clip_path=live_file,
                    shorts_path=short_path,
                    title=metadata["title"],
                    description=metadata["description"],
                    tags=",".join(metadata["tags"]),
                    status="generated"
                )

                # Upload to YouTube (PUBLIC)
                try:
                    yt_id = self.uploader.upload_short(
                        video_path=short_path,
                        title=metadata["title"],
                        description=metadata["description"],
                        tags=metadata["tags"],
                        category_id="20",
                        privacy_status="public"
                    )
                    if yt_id:
                        database.update_clip_status(clip_id, "uploaded", youtube_video_id=yt_id)
                        total_clips_uploaded += 1
                        logger.info("Successfully uploaded PUBLIC live clip %s -> YouTube ID: %s (%d/%d today)",
                                    clip_id, yt_id, total_clips_uploaded + daily_uploads, self.max_daily_uploads)

                        # Track streamer in recent rotation so next clip is from another streamer
                        self.recent_streamers.append(channel_login)
                        if len(self.recent_streamers) > 6:
                            self.recent_streamers.pop(0)

                        # Delete clip locally once uploaded to YouTube
                        self.downloader.delete_clip_files(shorts_path=short_path)

                        # Random 8 to 10 min gap between uploads
                        if total_clips_uploaded + daily_uploads < self.max_daily_uploads:
                            delay = random.uniform(self.min_upload_gap_seconds, self.max_upload_gap_seconds)
                            logger.info("Sleeping %.1f minutes (random 8-10 min gap) before next upload...", delay / 60.0)
                            time.sleep(delay)
                except Exception as upload_err:
                    logger.error("Upload failed for clip %s: %s", clip_id, upload_err)
                    database.update_clip_status(clip_id, "upload_failed", error_message=str(upload_err))

            # Clean up raw live capture file to free local disk space
            if os.path.exists(live_file):
                try:
                    os.remove(live_file)
                    logger.info("Deleted temporary raw live capture file: %s", live_file)
                except Exception:
                    pass

            streams_processed += 1

        return {
            "status": "completed",
            "live_streams_processed": streams_processed,
            "clips_uploaded": total_clips_uploaded
        }

    def start_loop(self):
        self.is_running = True
        logger.info("Live stream scheduler loop active: targeting %d uploads/day with 8-10 min random gaps.", self.max_daily_uploads)
        while self.is_running:
            try:
                self.run_single_cycle()
            except Exception as e:
                logger.error("Error in live stream scheduler cycle: %s", e)
            time.sleep(self.poll_interval_seconds)

    def stop_loop(self):
        self.is_running = False
        logger.info("Scheduler loop stopped.")
