import os
import sqlite3
import json
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "database", "clipper.db")

def get_connection(db_path: str = DB_PATH) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    return conn

def init_db(db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS vods (
        vod_id TEXT PRIMARY KEY,
        streamer_name TEXT,
        streamer_id TEXT,
        title TEXT,
        url TEXT,
        duration_seconds INTEGER,
        language TEXT,
        created_at TEXT,
        status TEXT DEFAULT 'discovered',
        processed_at TEXT,
        error_message TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS clips (
        clip_id TEXT PRIMARY KEY,
        vod_id TEXT,
        start_time REAL,
        end_time REAL,
        duration REAL,
        highlight_score REAL,
        score_breakdown TEXT,
        raw_clip_path TEXT,
        shorts_path TEXT,
        title TEXT,
        description TEXT,
        tags TEXT,
        status TEXT DEFAULT 'generated',
        youtube_video_id TEXT,
        created_at TEXT,
        uploaded_at TEXT,
        error_message TEXT,
        FOREIGN KEY (vod_id) REFERENCES vods(vod_id)
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        level TEXT,
        module TEXT,
        message TEXT
    )
    """)

    cur.execute("""
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
    """)

    conn.commit()
    conn.close()

def log_event(level: str, module: str, message: str, db_path: str = DB_PATH) -> None:
    try:
        conn = get_connection(db_path)
        cur = conn.cursor()
        now = datetime.now(timezone.utc).isoformat()
        cur.execute("INSERT INTO logs (timestamp, level, module, message) VALUES (?, ?, ?, ?)",
                    (now, level, module, message))
        conn.commit()
        conn.close()
    except Exception:
        pass

def add_vod(vod_id: str, streamer_name: str, streamer_id: str, title: str,
            url: str, duration_seconds: int, language: str, created_at: str,
            db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    cur = conn.cursor()
    try:
        cur.execute("""
        INSERT INTO vods (vod_id, streamer_name, streamer_id, title, url, duration_seconds, language, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'discovered')
        """, (vod_id, streamer_name, streamer_id, title, url, duration_seconds, language, created_at))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

def is_vod_processed(vod_id: str, db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT status FROM vods WHERE vod_id = ?", (vod_id,))
    row = cur.fetchone()
    conn.close()
    if row is None:
        return False
    return row["status"] in ("completed", "processing", "ignored")

def update_vod_status(vod_id: str, status: str, error_message: Optional[str] = None, db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    cur = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    cur.execute("""
    UPDATE vods SET status = ?, processed_at = ?, error_message = ? WHERE vod_id = ?
    """, (status, now, error_message, vod_id))
    conn.commit()
    conn.close()

def add_clip(clip_id: str, vod_id: str, start_time: float, end_time: float,
             duration: float, highlight_score: float, score_breakdown: Dict[str, Any],
             raw_clip_path: str, shorts_path: str, title: str, description: str, tags: str,
             status: str = "generated", db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    cur = conn.cursor()
    now = datetime.now(timezone.utc).isoformat()
    cur.execute("""
    INSERT INTO clips (
        clip_id, vod_id, start_time, end_time, duration,
        highlight_score, score_breakdown, raw_clip_path, shorts_path,
        title, description, tags, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        clip_id, vod_id, start_time, end_time, duration,
        highlight_score, json.dumps(score_breakdown), raw_clip_path, shorts_path,
        title, description, tags, status, now
    ))
    conn.commit()
    conn.close()

def update_clip_status(clip_id: str, status: str, youtube_video_id: Optional[str] = None,
                       error_message: Optional[str] = None, db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    cur = conn.cursor()
    now = datetime.now().astimezone().isoformat()
    if youtube_video_id:
        cur.execute("""
        UPDATE clips SET status = ?, youtube_video_id = ?, uploaded_at = ?, error_message = ? WHERE clip_id = ?
        """, (status, youtube_video_id, now, error_message, clip_id))
    else:
        cur.execute("""
        UPDATE clips SET status = ?, error_message = ? WHERE clip_id = ?
        """, (status, error_message, clip_id))
    conn.commit()
    conn.close()

def get_daily_upload_count(db_path: str = DB_PATH) -> int:
    conn = get_connection(db_path)
    cur = conn.cursor()
    # Use local machine date for automatic midnight reset
    today_prefix = datetime.now().astimezone().strftime("%Y-%m-%d")
    cur.execute("""
    SELECT COUNT(*) as count FROM clips WHERE status = 'uploaded' AND uploaded_at LIKE ?
    """, (f"{today_prefix}%",))
    row = cur.fetchone()
    count = row["count"] if row else 0
    conn.close()
    return count

def reset_daily_uploads(db_path: str = DB_PATH) -> int:
    """Manually resets today's upload counter to 0."""
    conn = get_connection(db_path)
    cur = conn.cursor()
    today_prefix = datetime.now().astimezone().strftime("%Y-%m-%d")
    cur.execute("""
    UPDATE clips SET uploaded_at = 'archived_' || uploaded_at WHERE status = 'uploaded' AND uploaded_at LIKE ?
    """, (f"{today_prefix}%",))
    rows_affected = cur.rowcount
    conn.commit()
    conn.close()
    return rows_affected

def get_all_vods(limit: int = 50, db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM vods ORDER BY created_at DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def get_all_clips(limit: int = 50, db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM clips ORDER BY created_at DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

def get_recent_logs(limit: int = 100, db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    cur = conn.cursor()
    cur.execute("SELECT * FROM logs ORDER BY id DESC LIMIT ?", (limit,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows

init_db()

