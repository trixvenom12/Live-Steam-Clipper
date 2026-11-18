# GTA Clipper

Automated stream clipper for Twitch, Kick and YouTube. It watches a channel, records
while it's live, finds the loud + hype moments from chat and audio, then cuts vertical
9:16 clips with word-synced captions locally. Optional YouTube uploads use your own
Google OAuth credentials.

```
yt-dlp ──► ffmpeg segmenter ──► chat + loudness scoring ──► whisper.cpp ──► ffmpeg
 (grab)      (2 min chunks)        (per-chunk peaks)        (word timings)   (9:16 + ASS)
```

## Requirements

- macOS (Apple Silicon recommended — Metal whisper + Vision face detection)
- Node 22+
- ffmpeg + ffprobe on `PATH`

`npm run setup` vendors everything else into `.tools/` and `models/`:
yt-dlp, CMake, whisper.cpp (Metal build) and `ggml-small.en-q5_1.bin`.

```bash
npm run setup
npm run doctor
```

## Quick start

```bash
# 1. add channels — a handle or a pasted URL, both work
node src/cli.js add twitch yourstreamer
node src/cli.js add kick https://kick.com/anotherstreamer
node src/cli.js add youtube @somechannel

# 2. open the dashboard (phone-friendly); it starts monitoring automatically
node src/cli.js ui              # dashboard + watcher: http://localhost:4321

# Watch the channels even without the dashboard
node src/cli.js watch

# 3. or clip a finished stream
node src/cli.js vod "https://www.youtube.com/watch?v=..." --top 10

# 4. or clip one file you already have
node src/cli.js clip ./stream.mp4 --at 1:12:30 --len 30
```

Clips land in `clips/` as `.mp4` + `.jpg` + `.json` (transcript, words, hook, score).

## Dashboard (and your phone)

`ui` binds `0.0.0.0` and prints two URLs:

```
dashboard  http://localhost:4321
phone      http://192.168.1.20:4321/?k=…
```

Open the phone URL once on the same Wi-Fi. The `?k=` token is exchanged for a cookie,
so the dashboard stays signed in for a year. Every other device on the network gets
`401` until it has that link. On iPhone use Share → **Add to Home Screen**; on Android
Chrome use **Install app** / **Add to Home screen** — it launches standalone with the
manifest icon.

Four tabs, all touch-sized (44 px targets, safe-area insets, no hover-only actions):

| Tab | What you can do |
|---|---|
| **Home** | start/stop the watcher, see live recordings and stop a session, queue a VOD, watch the activity log |
| **Clips** | search hooks and transcripts, filter by channel, play inline, save, copy transcript, delete (confirmed) |
| **Channels** | add Twitch/Kick/YouTube channels, remove them |
| **Settings** | tune detection, clip length, captions and framing — saved instantly, clamped server-side |

The page polls `/api/state` every 4 s and pauses while the tab is hidden. Everything on
the phone goes through the same local server; no cloud, no account.

```bash
node src/cli.js ui                # dashboard + start watching immediately
node src/cli.js ui --no-watch     # dashboard only (do not monitor channels)
node src/cli.js ui --open         # no token (trusted network only)
node src/cli.js ui --port 8080 --host 127.0.0.1
```

The token lives in `data/ui-token`. Delete it while the server is stopped to rotate it.

### YouTube uploads

The Clips gallery and clip player have an **Upload** button. It suggests a short title,
description and tags from the clip; review/edit them before posting. Uploads default to
**Private** and use YouTube's Gaming category. OAuth refresh credentials stay in
`data/youtube-token.json`.

#### One-time Google API setup

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project.
2. In **APIs & Services → Library**, enable **YouTube Data API v3**.
3. In **Google Auth platform → Branding**, set an app name and support email. Configure
   **Audience**; if External and still in Testing, add your Google account as a test user.
   Testing-mode refresh tokens for this YouTube scope can expire after 7 days.
   Google may also restrict uploads from unverified API projects to Private until the
   project completes YouTube's API compliance audit.
4. In **Google Auth platform → Clients**, create an OAuth client ID with application
   type **Web application**. Add this exact authorized redirect URI:
   `http://localhost:4321/api/youtube/callback`
5. Copy the client ID and secret. In Terminal, from this project folder, set them and
   start the dashboard:

   ```bash
   export YOUTUBE_CLIENT_ID='paste-client-id'
   export YOUTUBE_CLIENT_SECRET='paste-client-secret'
   node src/cli.js ui
   ```

6. In the Clips tab, choose **Upload → Connect YouTube account**, approve access, then
   return to the app. Choose visibility and press **Upload video**. Keep the dashboard
   running until the upload finishes.

For a non-default dashboard port, also register
`http://localhost:<port>/api/youtube/callback` in Google Cloud and start the UI on that
same port. Never commit OAuth secrets or `data/youtube-token.json`.

## How a live session works

1. `watch` probes every channel once a minute (`yt-dlp -J`, one code path for all 3 sites).
2. When live, `yt-dlp` pipes the stream into ffmpeg's segment muxer → `data/sessions/<id>/segments/00001.ts` (120 s each, stream-copied, no re-encode).
3. Chat is captured in parallel (Twitch IRC, Kick pusher, YouTube `live_chat` via yt-dlp) into `chat.jsonl`.
4. Every **completed** segment is scored: chat messages/second and audio RMS in 1 s buckets, z-scored, smoothed, then local maxima are picked with a minimum gap and a per-hour cap. A segment is only scored once the next one exists, so a clip can run past the boundary.
5. Peaks become jobs in a disk-backed queue. One job at a time: transcribe → snap to speech → reframe → burn captions.
6. Old segments stay on disk so any job can be re-rendered.

Because scoring happens per closed 2-minute chunk, a clip is typically ready a few minutes
after the moment. The VOD path (`vod`) does the same thing over the whole file at once.

## What makes the clips not look auto-generated

- **Auto split layout** (`--layout auto`, default). Samples up to 12 frames, asks the macOS
  Vision framework for faces, and when a small face is stable and corner-anchored it treats
  that region as the webcam: game square on top, facecam band below, captions on the seam.
  Falls back to blurred-background vertical when there is no webcam.
- **Speech-aligned cuts.** The clip is cut with ~2.5 s of padding, transcribed, then
  trimmed back to the first/last word so clips don't start mid-sentence or end on silence.
- **Word-synced captions.** whisper.cpp token timings are merged into words, grouped 3 per
  line, with the active word popped and hype words in a second colour.
- **Hook line.** The most hyped sentence of the transcript becomes the card title / post copy.

Override the framing when the detector guesses wrong:

```bash
node src/cli.js clip ./stream.mp4 --at 10:00 --cam 0.72,0.62,0.28,0.36   # x,y,w,h normalized
node src/cli.js clip ./stream.mp4 --at 10:00 --layout crop              # fill the frame
node src/cli.js clip ./stream.mp4 --at 10:00 --layout blur              # blurred background
```

## Commands

| Command | What it does |
|---|---|
| `setup` | install yt-dlp, CMake, build whisper.cpp, download model, build face detector |
| `doctor` | check every binary, model, font, channel and clip count |
| `add <platform> <handle or URL>` / `remove` / `list` | manage watched channels |
| `watch [--ui] [--once]` | monitor channels, record live, queue clips |
| `record <platform> <slug>` | record one live channel now |
| `vod <url> [--top N]` | download a finished stream and clip its best N moments |
| `clip <file> --at 12:30 [--len 30]` | manual clip from any local file |
| `ui [--port 4321] [--no-watch] [--open]` | dashboard + automatic channel monitoring (alias `serve`) |

## Config

`data/config.json` is created on first run and deep-merged over the defaults
(`src/config.js`). The dashboard's Settings tab writes the same file; the CLI flags
(`--segment`, `--layout`, `--cam`, `--pre`, `--len`) still win for one run. Useful knobs:

```jsonc
{
  "record":   { "segmentSeconds": 120, "maxHeight": 1080 },
  "detect":   { "minScore": 2.0, "minMessages": 12, "minGapSeconds": 75, "maxClipsPerHour": 10 },
  "clip":     { "preRollSeconds": 12, "lengthSeconds": 30, "minLengthSeconds": 18, "maxLengthSeconds": 45, "layout": "auto" },
  "captions": { "font": "Arial Black", "fontSize": 78, "wordsPerLine": 3, "highlight": "&H0033D6FF", "emphasis": "&H002B4BFF", "marginV": 360 },
  "whisper":  { "model": "models/ggml-small.en-q5_1.bin", "threads": 6, "language": "en" }
}
```

Whisper is English-only by default because the model is `small.en`. Swap
`whisper.model` to a multilingual `ggml-*.bin` and set `whisper.language`.

## Tests

```bash
npm test
```

Covers peak picking, caption grouping/timing, speech snapping, webcam-inset heuristics,
hook selection and the dashboard's settings clamps. No network, no media needed.

## Notes and limits

- Kick chat uses Kick's public pusher channel; it can break when they change keys.
  Detection still falls back to audio-only.
- YouTube live chat is captured by a yt-dlp subprocess tailing `live_chat` JSON.
- Twitch VOD chat uses the public GQL client id; if Twitch closes it, VODs use audio only.
- Live recording starts from the current point of the stream (`--live-from-start` is passed,
  which is honoured where the platform allows it).
- Disk: 1080p60 MPEG-TS ≈ 2.5 GB/hour. Segments are kept for re-renders; delete
  `data/sessions/*/segments` when you're done with a stream.
- Auto-detected webcam framing assumes the person is actually visible (face detector).
  Use `--cam` for a talking-head-free overlay, or `--layout blur`.
- No auto-posting: clips are local files you upload yourself.
- The dashboard controls recording and disk writes. Don't expose it to the public
  internet — it is meant for your own LAN, protected by the `data/ui-token` link.

## Sources

The teardown in `docs/competitive-teardown.md` compares this pipeline with OpenShorts,
AutoClip and Opus Clip. Borrowed ideas: webcam-inset framing and speaker/layout routing
(OpenShorts), sentence-aligned clip boundaries and per-platform duration profiles
(AutoClip), multi-format reframing and brand templates (Opus). Deliberately not borrowed:
cloud LLM moment picking — the local chat+audio signal needs no key and costs nothing.
# Live-Steam-Clipper
# Live-Steam-Clipper
