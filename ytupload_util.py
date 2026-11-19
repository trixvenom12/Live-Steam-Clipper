import os
import sys
from typing import Optional, List
from modules.youtube_uploader import YouTubeUploader

default_description = "Thanks for watching. Please Subscribe."
default_categoryId = "20"

def upload(filename: str, title: str, description: str, tags: str, categoryId: str, privacyStatus: str) -> Optional[str]:
    """
    Modernized YouTube upload utility using OAuth 2.0 desktop flow, resumable uploads,
    and automatic token refresh.
    """
    try:
        uploader = YouTubeUploader()
        if not uploader.authenticate(open_browser=True):
            print("[!] YouTube authentication failed.")
            return None

        tag_list = [t.strip() for t in tags.split(",") if t.strip()] if isinstance(tags, str) else tags

        video_id = uploader.upload_short(
            video_path=filename,
            title=title,
            description=description or default_description,
            tags=tag_list,
            category_id=categoryId or default_categoryId,
            privacy_status=privacyStatus.lower() if privacyStatus else "private"
        )
        return video_id
    except Exception as e:
        print(f"[!!] ERROR uploading to YouTube: {e}")
        return None

def manual_upload():
    filename = input("[+] File path: ")
    yt_title = input("[+] Video Title: ")
    yt_description = input("[+] Video Description (leave empty for default description): ")
    yt_tags = input("[+] Video Tags (separated by commas): ")
    yt_categoryId = input("[+] Category ID (Leave empty for Gaming): ")
    yt_privacyStatus = input("[+] Privacy Status (public/private/unlisted, default: private): ")
    yt_credits = input("[+] Credits for Original Creator: ")

    if not yt_title:
        print("[!] Title cannot be empty")
        return

    if not yt_privacyStatus:
        yt_privacyStatus = "private"

    if yt_privacyStatus.lower() not in ["public", "private", "unlisted"]:
        print("[!] Invalid privacy status. Defaulting to private.")
        yt_privacyStatus = "private"

    if not yt_description:
        yt_description = default_description

    if not yt_categoryId:
        yt_categoryId = default_categoryId

    if yt_credits:
        yt_description += f"\nCredits:\n{yt_credits}"

    vid = upload(filename, yt_title, yt_description, yt_tags, yt_categoryId, yt_privacyStatus)
    if vid:
        print(f"[*] Uploaded successfully! Video URL: https://www.youtube.com/watch?v={vid}")
    else:
        print("[!] Upload failed.")

if __name__ == "__main__":
    manual_upload()
