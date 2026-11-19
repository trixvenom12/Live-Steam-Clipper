import os
import threading
from flask import Flask, render_template_string, jsonify, request
from modules import database
from modules.scheduler import Scheduler
from modules.vod_downloader import VODDownloader

app = Flask(__name__)
scheduler_instance: Scheduler = None
scheduler_thread: threading.Thread = None

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AutoBot Clipper - GTA 6 Live Shorts Automation</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <style>
        body { background-color: #121212; color: #e0e0e0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        .card { background-color: #1e1e1e; border: 1px solid #333; margin-bottom: 20px; }
        .table { color: #e0e0e0; }
        .table-dark { background-color: #1e1e1e; }
        .btn-gta { background: linear-gradient(45deg, #f093fb 0%, #f5576c 100%); color: white; border: none; }
        .btn-gta:hover { color: white; opacity: 0.9; }
        .stat-card { border-left: 4px solid #f5576c; }
        .badge-live { background-color: #e91e63; animation: pulse 1.5s infinite; }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
    </style>
</head>
<body>
<div class="container-fluid py-4">
    <div class="d-flex justify-content-between align-items-center mb-4">
        <div>
            <h1 class="h3 mb-0 text-white">GTA 6 Live Clipper & Shorts Publisher <span class="badge badge-live ms-2">LIVE FIRST</span></h1>
            <p class="text-secondary mb-0">Captures directly from active GTA 6 live streams, detects viral moments, converts to 9:16 Shorts, and auto-deletes locally upon upload.</p>
        </div>
        <div>
            <button id="btn-run-once" class="btn btn-outline-info me-2" onclick="runOnce()">Trigger Run Once</button>
            <button id="btn-toggle" class="btn btn-gta" onclick="toggleAutomation()">Start Automation Loop</button>
        </div>
    </div>

    <!-- Stats row -->
    <div class="row mb-4">
        <div class="col-md-3">
            <div class="card stat-card p-3">
                <span class="text-secondary">Live GTA 6 Streams</span>
                <h3 id="stat-live" class="text-white">0</h3>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card stat-card p-3">
                <span class="text-secondary">Clips Published</span>
                <h3 id="stat-clips" class="text-white">0</h3>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card stat-card p-3">
                <div class="d-flex justify-content-between align-items-center">
                    <span class="text-secondary">Today's Uploads</span>
                    <button class="btn btn-xs btn-outline-secondary py-0 px-1 text-xs" style="font-size: 0.7rem;" onclick="resetToday()">Reset</button>
                </div>
                <h3 id="stat-uploads" class="text-white">0 / 15</h3>
            </div>
        </div>
        <div class="col-md-3">
            <div class="card stat-card p-3">
                <span class="text-secondary">Local Disk Usage (Max 10 GB)</span>
                <h3 id="stat-storage" class="text-info">0.00 / 10.00 GB</h3>
            </div>
        </div>
    </div>

    <!-- Main Content -->
    <div class="row">
        <!-- Clips Column -->
        <div class="col-lg-8">
            <div class="card">
                <div class="card-header bg-dark border-secondary d-flex justify-content-between align-items-center">
                    <span class="text-white fw-bold">Published & Processed Shorts</span>
                    <button class="btn btn-sm btn-outline-secondary" onclick="loadData()">Refresh</button>
                </div>
                <div class="card-body p-0">
                    <div class="table-responsive">
                        <table class="table table-dark table-hover mb-0 align-middle">
                            <thead>
                                <tr>
                                    <th>Title & Tags</th>
                                    <th>Duration</th>
                                    <th>Score</th>
                                    <th>Status</th>
                                    <th>Local File</th>
                                </tr>
                            </thead>
                            <tbody id="clips-table">
                                <tr><td colspan="5" class="text-center py-4 text-secondary">No clips generated yet.</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- Discovered Streams & Logs Column -->
        <div class="col-lg-4">
            <div class="card mb-3">
                <div class="card-header bg-dark border-secondary">
                    <span class="text-white fw-bold">Active Live Streams</span>
                </div>
                <div class="card-body p-0" style="max-height: 280px; overflow-y: auto;">
                    <ul id="live-list" class="list-group list-group-flush bg-transparent">
                        <li class="list-group-item bg-transparent text-secondary">Discovering live streams...</li>
                    </ul>
                </div>
            </div>

            <div class="card">
                <div class="card-header bg-dark border-secondary">
                    <span class="text-white fw-bold">Execution Logs</span>
                </div>
                <div class="card-body p-2 font-monospace" style="max-height: 250px; overflow-y: auto; font-size: 0.85rem; background: #000;" id="logs-container">
                    <div class="text-secondary">[Ready] System initialized.</div>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
    async function loadData() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            document.getElementById('stat-live').innerText = data.total_live;
            document.getElementById('stat-clips').innerText = data.total_clips;
            document.getElementById('stat-uploads').innerText = `${data.daily_uploads} / 15`;
            document.getElementById('stat-storage').innerText = `${data.storage_gb} / 10.00 GB`;

            document.getElementById('btn-toggle').innerText = data.is_running ? 'Stop Automation' : 'Start Automation Loop';
            document.getElementById('btn-toggle').className = data.is_running ? 'btn btn-danger' : 'btn btn-gta';

            // Populate clips
            const tbody = document.getElementById('clips-table');
            if (data.clips && data.clips.length > 0) {
                tbody.innerHTML = data.clips.map(c => `
                    <tr>
                        <td>
                            <div class="fw-bold text-white">${c.title || 'Untitled'}</div>
                            <small class="text-secondary">${c.clip_id} | ${c.created_at ? c.created_at.slice(0,19) : ''}</small>
                        </td>
                        <td>${c.duration}s</td>
                        <td><span class="badge bg-primary">${(c.highlight_score * 100).toFixed(0)}%</span></td>
                        <td>
                            <span class="badge ${c.status === 'uploaded' ? 'bg-success' : (c.status === 'upload_failed' ? 'bg-danger' : 'bg-secondary')}">${c.status}</span>
                            ${c.youtube_video_id ? `<br><a href="https://youtu.be/${c.youtube_video_id}" target="_blank" class="small text-info">View YouTube</a>` : ''}
                        </td>
                        <td>
                            <span class="text-muted small">${c.status === 'uploaded' ? 'Auto-Deleted' : 'Retained'}</span>
                        </td>
                    </tr>
                `).join('');
            }

            // Populate live streams
            const llist = document.getElementById('live-list');
            if (data.live_streams && data.live_streams.length > 0) {
                llist.innerHTML = data.live_streams.map(s => `
                    <li class="list-group-item bg-transparent text-light border-secondary">
                        <div class="d-flex justify-content-between">
                            <strong>${s.user_name}</strong>
                            <span class="badge bg-danger">LIVE (${s.viewer_count} viewers)</span>
                        </div>
                        <small class="text-secondary text-truncate d-block">${s.title}</small>
                    </li>
                `).join('');
            }

            // Populate logs
            const lcont = document.getElementById('logs-container');
            if (data.logs && data.logs.length > 0) {
                lcont.innerHTML = data.logs.map(l => `<div><span class="text-muted">[${l.timestamp.slice(11,19)}]</span> <span class="text-${l.level === 'ERROR' ? 'danger' : 'info'}">[${l.module}]</span> ${l.message}</div>`).join('');
            }
        } catch (e) {
            console.error(e);
        }
    }

    async function toggleAutomation() {
        await fetch('/api/toggle', { method: 'POST' });
        loadData();
    }

    async function runOnce() {
        alert('Capturing live GTA 6 stream and processing Short...');
        await fetch('/api/run-once', { method: 'POST' });
        loadData();
    }

    async function resetToday() {
        if (confirm('Reset today upload counter to 0?')) {
            await fetch('/api/reset-today', { method: 'POST' });
            loadData();
        }
    }

    setInterval(loadData, 5000);
    loadData();
</script>
</body>
</html>
"""

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/api/status")
def get_status():
    global scheduler_instance
    if not scheduler_instance:
        scheduler_instance = Scheduler()

    dl = VODDownloader()
    storage_bytes = dl.get_total_storage_bytes()
    storage_gb = round(storage_bytes / (1024 ** 3), 2)

    live_streams = []
    try:
        speed = scheduler_instance.check_speed_youtube_live()
        if speed:
            live_streams.append(speed)
    except Exception:
        pass
    twitch_streams = scheduler_instance.twitch.discover_live_streams(game_id=scheduler_instance.game_id, language="en", limit=15)
    live_streams.extend(twitch_streams)
    clips = database.get_all_clips(limit=25)
    logs = database.get_recent_logs(limit=20)
    daily_uploads = database.get_daily_upload_count()
    is_running = scheduler_instance.is_running if scheduler_instance else False

    return jsonify({
        "total_live": len(live_streams),
        "live_streams": live_streams,
        "total_clips": len(clips),
        "daily_uploads": daily_uploads,
        "storage_gb": storage_gb,
        "is_running": is_running,
        "clips": clips,
        "logs": logs
    })

@app.route("/api/toggle", methods=["POST"])
def toggle_automation():
    global scheduler_instance, scheduler_thread
    if not scheduler_instance:
        scheduler_instance = Scheduler()

    if scheduler_instance.is_running:
        scheduler_instance.stop_loop()
    else:
        scheduler_thread = threading.Thread(target=scheduler_instance.start_loop, daemon=True)
        scheduler_thread.start()

    return jsonify({"status": "toggled", "is_running": scheduler_instance.is_running})

@app.route("/api/run-once", methods=["POST"])
def run_once():
    global scheduler_instance
    if not scheduler_instance:
        scheduler_instance = Scheduler()
    threading.Thread(target=scheduler_instance.run_single_cycle, daemon=True).start()
    return jsonify({"status": "started"})

@app.route("/api/reset-today", methods=["POST"])
def reset_today():
    database.reset_daily_uploads()
    return jsonify({"status": "reset", "daily_uploads": database.get_daily_upload_count()})

def run_dashboard(port: int = 5000, host: str = "127.0.0.1"):
    global scheduler_instance
    if not scheduler_instance:
        scheduler_instance = Scheduler()
    app.run(host=host, port=port, debug=False)

if __name__ == "__main__":
    run_dashboard()
