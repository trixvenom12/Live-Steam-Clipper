import os
import time
import json
import httplib2
import http.client
from typing import Optional, Dict, Any, List

import google_auth_oauthlib.flow
import google.oauth2.credentials
from google.auth.transport.requests import Request
import googleapiclient.discovery
import googleapiclient.errors
from googleapiclient.http import MediaFileUpload

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
CLIENT_SECRETS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client_secrets.json")
TOKEN_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "token.json")

# Retriable HTTP errors
RETRIABLE_STATUS_CODES = [500, 502, 503, 504]
RETRIABLE_EXCEPTIONS = (
    httplib2.HttpLib2Error,
    IOError,
    http.client.NotConnected,
    http.client.IncompleteRead,
    http.client.ImproperConnectionState,
    http.client.CannotSendRequest,
    http.client.CannotSendHeader,
    http.client.ResponseNotReady,
    http.client.BadStatusLine
)

class YouTubeUploader:
    def __init__(self, client_secrets_file: str = CLIENT_SECRETS_FILE, token_file: str = TOKEN_FILE):
        self.client_secrets_file = client_secrets_file
        self.token_file = token_file
        self.credentials: Optional[google.oauth2.credentials.Credentials] = None
        self.youtube = None

    def authenticate(self, open_browser: bool = True) -> bool:
        """
        Authenticate using OAuth2 desktop flow. Checks token.json first.
        If expired, refreshes. If absent and open_browser=True, launches browser.
        """
        creds = None
        if os.path.exists(self.token_file):
            try:
                creds = google.oauth2.credentials.Credentials.from_authorized_user_file(self.token_file, SCOPES)
            except Exception:
                creds = None

        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                with open(self.token_file, "w", encoding="utf-8") as f:
                    f.write(creds.to_json())
            except Exception:
                creds = None

        if not creds or not creds.valid:
            if not open_browser:
                return False
            if not os.path.exists(self.client_secrets_file):
                raise FileNotFoundError(f"Missing {self.client_secrets_file}")

            flow = google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file(
                self.client_secrets_file, SCOPES
            )
            # Desktop application local server flow
            creds = flow.run_local_server(port=0)
            with open(self.token_file, "w", encoding="utf-8") as f:
                f.write(creds.to_json())

        self.credentials = creds
        self.youtube = googleapiclient.discovery.build("youtube", "v3", credentials=creds)
        return True

    def upload_short(
        self,
        video_path: str,
        title: str,
        description: str,
        tags: List[str],
        category_id: str = "20",
        privacy_status: str = "public",
        max_retries: int = 5
    ) -> Optional[str]:
        """
        Uploads video to YouTube with resumable upload, retry logic, and progress tracking.
        Initial uploads are strictly set to private.
        """
        if not self.youtube:
            if not self.authenticate(open_browser=False):
                raise PermissionError("YouTube authentication required. Run authenticate() first.")

        body = {
            "snippet": {
                "title": title,
                "description": description,
                "tags": tags,
                "categoryId": category_id
            },
            "status": {
                "privacyStatus": privacy_status,
                "selfDeclaredMadeForKids": False
            }
        }

        media = MediaFileUpload(video_path, chunksize=1024 * 1024 * 4, resumable=True)
        request = self.youtube.videos().insert(
            part="snippet,status",
            body=body,
            media_body=media
        )

        response = None
        retry = 0

        while response is None:
            try:
                status, response = request.next_chunk()
                if status:
                    progress = int(status.progress() * 100)
                    print(f"[*] Upload progress: {progress}%")
            except googleapiclient.errors.HttpError as e:
                if e.resp.status in RETRIABLE_STATUS_CODES:
                    retry += 1
                    if retry > max_retries:
                        raise e
                    sleep_sec = 2 ** retry
                    time.sleep(sleep_sec)
                elif "quotaExceeded" in str(e):
                    raise RuntimeError("YouTube API quota exceeded for today.")
                else:
                    raise e
            except RETRIABLE_EXCEPTIONS as e:
                retry += 1
                if retry > max_retries:
                    raise e
                sleep_sec = 2 ** retry
                time.sleep(sleep_sec)

        video_id = response.get("id")
        return video_id

