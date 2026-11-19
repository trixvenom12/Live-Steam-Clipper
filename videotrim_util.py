import os
import subprocess
import datetime
import time

def trimVideo(filename: str) -> bool:
    print("Choose which part of the video to keep. The rest of the video will be cut off.")

    start_time = input("[+] Start time (HH:MM:SS): ")
    end_time = input("[+] End time (HH:MM:SS): ")

    try:
        x = time.strptime(start_time, "%H:%M:%S")
        start_seconds = datetime.timedelta(hours=x.tm_hour, minutes=x.tm_min, seconds=x.tm_sec).total_seconds()

        y = time.strptime(end_time, "%H:%M:%S")
        end_seconds = datetime.timedelta(hours=y.tm_hour, minutes=y.tm_min, seconds=y.tm_sec).total_seconds()

        duration = end_seconds - start_seconds
        if duration <= 0:
            print("[!] End time must be greater than start time.")
            return False

        target_name = os.path.splitext(filename)[0] + "_trimmed.mp4"
        cmd = [
            "ffmpeg", "-y",
            "-ss", str(start_seconds),
            "-i", filename,
            "-t", str(duration),
            "-c:v", "libx264", "-c:a", "aac",
            "-avoid_negative_ts", "make_zero",
            target_name
        ]

        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return res.returncode == 0 and os.path.exists(target_name)
    except Exception as e:
        print(f"[!!] ERROR - {e}")
        return False
