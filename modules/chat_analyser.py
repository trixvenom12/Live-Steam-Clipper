import os
import re
import requests
from typing import List, Dict, Any, Optional

class ChatAnalyser:
    def __init__(self, client_id: Optional[str] = None):
        self.client_id = client_id or os.getenv("TWITCH_CLIENT_ID")
        self.hype_emotes = [
            "lul", "kekw", "lol", "wtf", "no way", "omegalul", "pog", "poggers",
            "holy", "wth", "lmao", "dead", "skull", "omg", "w", "rip", "💀", "😭", "🔥", "🤯"
        ]

    def fetch_vod_chat(self, vod_id: str, max_messages: int = 5000) -> List[Dict[str, Any]]:
        # Twitch GQL or Helix chat endpoints
        # Twitch public GQL endpoint allows fetching chat comments for VODs
        clean_id = re.sub(r"\D", "", vod_id)
        if not clean_id:
            return []

        url = "https://gql.twitch.tv/gql"
        headers = {
            "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko"  # standard public twitch web client id
        }
        query = """
        query($videoID: ID!, $cursor: String) {
          video(id: $videoID) {
            comments(after: $cursor) {
              edges {
                cursor
                node {
                  contentOffsetSeconds
                  message {
                    fragments {
                      text
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        }
        """

        messages = []
        cursor = None

        try:
            for _ in range(5):  # fetch up to 5 pages
                payload = {
                    "query": query,
                    "variables": {"videoID": clean_id, "cursor": cursor}
                }
                res = requests.post(url, json=payload, headers=headers, timeout=10)
                if res.status_code != 200:
                    break
                data = res.json()
                video_data = data.get("data", {}).get("video")
                if not video_data or not video_data.get("comments"):
                    break
                edges = video_data["comments"].get("edges", [])
                if not edges:
                    break
                for edge in edges:
                    node = edge.get("node", {})
                    offset = node.get("contentOffsetSeconds", 0)
                    fragments = node.get("message", {}).get("fragments", [])
                    text = "".join([f.get("text", "") for f in fragments])
                    messages.append({"offset": offset, "text": text})
                    cursor = edge.get("cursor")

                if len(messages) >= max_messages or not video_data["comments"]["pageInfo"].get("hasNextPage"):
                    break
        except Exception:
            pass

        return messages

    def analyse_chat(self, messages: List[Dict[str, Any]], duration_seconds: float, window_seconds: float = 5.0) -> List[Dict[str, Any]]:
        if not messages:
            return []

        num_windows = int(duration_seconds / window_seconds) + 1
        windows = [{"count": 0, "hype_count": 0, "caps_count": 0} for _ in range(num_windows)]

        for msg in messages:
            offset = msg.get("offset", 0)
            idx = int(offset / window_seconds)
            if 0 <= idx < num_windows:
                text = msg.get("text", "")
                windows[idx]["count"] += 1

                lower = text.lower()
                for emote in self.hype_emotes:
                    if emote in lower:
                        windows[idx]["hype_count"] += 1
                        break

                if text.isupper() and len(text) > 3:
                    windows[idx]["caps_count"] += 1

        total_msgs = sum(w["count"] for w in windows)
        if total_msgs == 0:
            return []

        avg_velocity = total_msgs / max(num_windows, 1)

        results = []
        for i, w in enumerate(windows):
            timestamp = i * window_seconds
            # Velocity score
            velocity_ratio = w["count"] / (avg_velocity + 1e-5)
            velocity_score = min(velocity_ratio / 3.0, 1.0)

            # Hype emote ratio
            hype_ratio = (w["hype_count"] / max(w["count"], 1))
            chat_score = float(0.6 * velocity_score + 0.4 * hype_ratio)

            results.append({
                "timestamp": timestamp,
                "msg_count": w["count"],
                "hype_count": w["hype_count"],
                "chat_score": chat_score
            })

        return results

