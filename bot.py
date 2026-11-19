import os
import sys
import argparse
import logging
from dotenv import load_dotenv

load_dotenv()

from modules.scheduler import Scheduler
from modules.dashboard import run_dashboard
from modules import database
import videotrim_util
import ytupload_util

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("AutoBotClipper")

def credits():
    print("""
=============================================================
  GTA 6 Twitch Clipper & YouTube Shorts Publisher (AutoBot)
  Automated Discovery | AI Highlights | Shorts Editor | Uploader
=============================================================
    """)

def run_legacy_interactive():
    credits()
    print("[*] Running in Legacy Interactive Mode...")
    creator_name = input("[+] Twitch Creator name: ").replace(" ", "")
    twitch_url = input("[+] Twitch VOD URL: ")
    start_time = input("[+] Clip Start time (HH:MM:SS): ")
    end_time = input("[+] Clip End time (HH:MM:SS): ")

    from modules.vod_downloader import VODDownloader
    downloader = VODDownloader()

    def parse_hms(s):
        parts = list(map(int, s.split(":")))
        return parts[0] * 3600 + parts[1] * 60 + parts[2]

    start_sec = parse_hms(start_time)
    end_sec = parse_hms(end_time)
    duration = end_sec - start_sec

    filename = downloader.download_vod_segment(twitch_url, start_sec, duration)
    if not filename or not os.path.isfile(filename):
        print("[!] Download failed!")
        return

    print(f"[*] Downloaded clip successfully: {filename}")
    try:
        os.startfile(filename)
    except Exception:
        pass

    op = input("[+] Do you want to trim the video? (Y/n): ").strip().lower()
    if op in ["y", ""]:
        if videotrim_util.trimVideo(filename):
            print("[*] Video trimmed successfully!")
            filename = os.path.splitext(filename)[0] + "_trimmed.mp4"

    op = input("[+] Upload to YouTube? (Y/n): ").strip().lower()
    if op in ["y", ""]:
        yt_title = input("[+] Video Title: ")
        yt_description = input("[+] Video Description (leave empty for default): ")
        yt_tags = input("[+] Video Tags (separated by commas): ")
        yt_categoryId = input("[+] Category ID (Leave empty for Gaming - 20): ") or "20"
        yt_privacyStatus = input("[+] Privacy Status (public/private/unlisted, default private): ") or "private"
        yt_credits = input("[+] Credits for Original Creator: ")

        if yt_credits:
            yt_description += f"\nCredits:\n{yt_credits}"

        videoId = ytupload_util.upload(filename, yt_title, yt_description, yt_tags, yt_categoryId, yt_privacyStatus)
        if videoId:
            print(f"[*] Successfully uploaded video: https://www.youtube.com/watch?v={videoId}")
        else:
            print("[!] Video upload failed.")

def main():
    parser = argparse.ArgumentParser(description="AutoBot Clipper - GTA 6 Twitch to YouTube Shorts")
    parser.add_argument("--mode", choices=["auto", "dashboard", "once", "interactive"], default="auto",
                        help="Execution mode (default: auto)")
    parser.add_argument("--port", type=int, default=5000, help="Dashboard port (default: 5000)")
    parser.add_argument("--clips-per-vod", type=int, default=3, help="Max clips per VOD")
    parser.add_argument("--poll-interval", type=int, default=600, help="Seconds between discovery polls")
    args = parser.parse_args()

    database.init_db()

    if args.mode == "dashboard":
        credits()
        print(f"[*] Launching Web Dashboard at http://localhost:{args.port}...")
        run_dashboard(port=args.port)
    elif args.mode == "interactive":
        run_legacy_interactive()
    elif args.mode == "once":
        credits()
        print("[*] Running single automated cycle...")
        sched = Scheduler(max_clips_per_vod=args.clips_per_vod)
        result = sched.run_single_cycle()
        print("[+] Cycle result:", result)
    else:  # auto
        credits()
        print("[*] Starting Fully Automated GTA 6 Twitch Clipper & Shorts Uploader...")
        sched = Scheduler(
            poll_interval_seconds=args.poll_interval,
            max_clips_per_vod=args.clips_per_vod
        )
        try:
            sched.start_loop()
        except KeyboardInterrupt:
            print("\n[*] Stopping scheduler loop gracefully...")
            sched.stop_loop()

if __name__ == "__main__":
    main()
