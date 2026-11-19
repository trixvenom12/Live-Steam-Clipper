import os
import sys
from dotenv import load_dotenv
from modules.youtube_uploader import YouTubeUploader
from modules.twitch_discovery import TwitchDiscovery

load_dotenv()

def authenticate_youtube():
    print("[*] Initiating YouTube OAuth Desktop Authorization...")
    uploader = YouTubeUploader()
    try:
        if uploader.authenticate(open_browser=True):
            print("[+] YouTube authentication successful! Credentials saved to token.json.")
            return True
        else:
            print("[!] YouTube authentication failed.")
            return False
    except Exception as e:
        print(f"[!] Error authenticating YouTube: {e}")
        return False

def verify_twitch():
    print("[*] Verifying Twitch Helix API credentials...")
    try:
        twitch = TwitchDiscovery()
        token = twitch._ensure_token()
        if token:
            print("[+] Twitch API authentication successful!")
            return True
    except Exception as e:
        print(f"[!] Twitch API verification failed: {e}")
        return False

def check_all():
    print("=" * 50)
    print("GTA 6 Clipper Configuration & Health Check")
    print("=" * 50)

    twitch_ok = verify_twitch()
    print("-" * 50)
    yt_ok = False
    if os.path.exists("token.json"):
        try:
            uploader = YouTubeUploader()
            yt_ok = uploader.authenticate(open_browser=False)
            if yt_ok:
                print("[+] YouTube token.json is valid and authorized.")
        except Exception:
            yt_ok = False

    if not yt_ok:
        print("[!] YouTube not yet authenticated. Run: python config.py --auth")

    print("=" * 50)
    return twitch_ok and yt_ok

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--auth":
        authenticate_youtube()
    else:
        check_all()
