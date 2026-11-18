# Competitive teardown: OpenShorts, AutoClip, Opus Clip

Method: source-level review of the two open-source repos (file trees + core modules read
from GitHub, no social engineering, no proprietary code), and public product/feature
analysis for Opus Clip. No REA/binary work: two targets are complete source repos, and
Opus Clip ships no local artifact — its only public surface is the website.

## What each one actually is

### 01 · OpenShorts (`mutonby/openshorts`, MIT, Python, ~8.6k★)

Not a single script — a three-product platform (`app.py`): Clip Generator, AI Shorts
(UGC actors), YouTube Studio. The clip pipeline is Gemini-driven and unusually careful
about framing.

Evidence from the source:

- `clip_selection.py` — clip selection is LLM-only (Gemini 2.5/3.x, priced per model),
  with a **two-pass** design: cheap "shortlist" scoring windows, then a detail pass.
  Interesting bit: target clip count is derived from retention data, not from the prompt
  (`clip_count_targets`: jobs returning 1–3 clips had 0.4% day-2 return, 4–9 clips had
  16.1%). They put a floor and a ceiling on how many clips the model may return.
- `burned_subtitles.py` — detects subtitles **already burned into the source** (12 stills,
  asked per video, ≥40% presence) and trims that band before reframing, so captions don't
  stack.
- `camera_inset.py` — the important one for game/stream content: finds the **webcam inset
  in a screen recording**. Locate the person → decide which corner → grow a box from that
  corner. Rules: corner margin 0.20, stable centre across frames, inset height 0.10–0.38 of
  frame, padding 1.45×, 16:9 assumption, face ≈ 1/3 of inset width.
- `active_speaker.py` — mouth-motion change in each known face box, gated by audio RMS, so
  a silent person isn't stacked for 30 s.
- Layouts: `TALK`, `SPLIT`, `SCREENCAST`/split with the inset, plus automatic layout choice
  from stills. Caption style presets exist as demo renders (`caption-hormozi`, `caption-lime`,
  `caption-pill`, `caption-oneword`).

Weakness: self-hosted CPU is 5–8 min per 8-min video, needs Docker + 8 GB RAM, and moment
picking stops entirely if you don't bring a Gemini key. Cloud-only features (auto-post,
Autopilot, always-on MCP) are not in the repo.

### 02 · AutoClip (`zhouxiaoka/autoclip`, MIT, Python + Tauri, ~10.6k★)

Desktop app + CLI + MCP. Pipeline is LLM-over-transcript, engineered for robustness.

Evidence from the source:

- `backend/pipeline/clip_finder.py` — one-pass "whole transcript in, finished clips out".
  Transcript rows go to the model as `id|time|text` (no SRT timestamps, ~40% fewer tokens);
  long videos split into ~60-min windows with 4-min overlap, analysed in parallel, then
  deduplicated (`DUPLICATE_OVERLAP = 0.5`). Local models get 20-min/12k-char windows.
- Quality layer (`backend/pipeline/quality.py`): every returned clip is validated,
  **snapped by `refine_timeline`** (sentence boundaries), and selected with **duration
  profiles** — short-video tier vs the old podcast tier (90 s min, 2–6 min target), so a
  60 s answer isn't padded to 90 s.
- Subtitles: `studio/caption_layout.py`, `subtitle_highlights.py`, `cjk_segment.py`,
  `burned_subtitles.py`, plus tests for caption blinks, holes, truncation, pagination.
- Output per clip: video, **cover image, and post copy** — not just the MP4.
- Fallback chain: `ClipFinderError` on invalid LLM output → legacy outline/timeline path.

Weakness: moment detection is only as good as the transcript — no visual signal; needs a
model (cloud or local) for every video; desktop-centric.

### 03 · Opus Clip (closed SaaS)

Public claims: `ClipAnything` (multimodal — visuals + audio + sentiment, explicitly
including **gaming** and low-dialogue footage, plus natural-language prompts), and
`ReframeAnything` (AI object tracking that keeps moving subjects centred, with manual
tracking override). Also: 20+ languages, brand templates (font/colour/logo/intro/outro),
team workspaces, API, one-click publishing, CTA endings. Free tier = 60 credits/month,
watermark and minute caps.

Strength is distribution and polish, not a fundamentally different clip model. Nothing it
does requires a cloud to work — it requires a cloud to *scale*.

## Side-by-side

| | OpenShorts | AutoClip | Opus Clip | **GTA Clipper (this repo)** |
|---|---|---|---|---|
| Moment signal | Gemini (video+audio+text) | LLM over transcript | multimodal + trends | **chat rate + audio energy** |
| Needs API key | Yes for clipping | Yes (or local model) | Yes (SaaS) | **No** |
| Live while streaming | No (upload a file) | No | No | **Yes**, 2-min segments |
| Webcam inset framing | **Yes** (screen recordings) | speaker framing | object tracking | **Yes** (Vision face detector) |
| Speech-aligned cuts | transcript-driven | `refine_timeline` | AI edit | **Yes** (word timings) |
| Captions | burned, 4+ presets | pagination + highlights | 99% accuracy, editable | word-synced ASS, hype colour |
| Output extras | thumbnails, captions | **cover + post copy** | brand templates, CTA | hook line |
| Auto-posting | cloud only | manual | **Yes** | No |
| Local/free | Yes (bring key) | Yes (bring model) | No | **Yes, fully** |
| Multi-language | Yes (Gemini) | Yes (LLM) | 20+ | English by default |

## Where this repo is already ahead

1. **Live is the product.** All three are post-hoc: you finish the stream, upload it, wait.
   Here a clip exists minutes after the moment, because scoring runs on closed segments.
2. **Zero marginal cost.** Chat rate + RMS loudness needs no model call per minute. On a
   6-hour GTA stream that's the difference between $0 and a real bill.
3. **No upload, no queue in someone's cloud.** The full-quality source stays local.

## Gaps worth closing, ranked by value ÷ effort

| # | Gap | Why it matters | Effort |
|---|---|---|---|
| 1 | ~~No webcam awareness~~ | **Done** — `vision.js` + `face-scan.swift`, `--layout auto` | — |
| 2 | ~~Cuts mid-sentence~~ | **Done** — pad → transcribe → snap to first/last word | — |
| 3 | ~~Flat captions~~ | **Done** — hype-word second colour + pop | — |
| 4 | ~~No title/copy~~ | **Done** — `hook.js` picks the hyped sentence | — |
| 5 | No transcript signal at all | Chat spikes miss quiet-but-funny lines; a text score (laughter, "no way", repeated words, profanity density) is free and catches them | S |
| 6 | One output format | 1:1 and 16:9 exports from the same cut (Opus ships this) | S |
| 7 | Fixed 30 s length | Score-driven length: extend while chat stays hot, cut on the fall | S |
| 8 | No cover image / post copy | AutoClip ships both; we already have the hook and transcript | S |
| 9 | English-only model | Swap to `ggml-small.bin` multilingual + per-channel language | S |
| 10 | No speaker-aware split | Two-person co-streams need mouth-motion routing (OpenShorts `active_speaker.py`) | M |
| 11 | No visual moment signal | Scene-change / kill-feed detection would catch action chat under-reacts to | M |
| 12 | No auto-publish | Biggest distribution win, but needs OAuth per platform | L |
| 13 | No editor | AutoClip/Opus let you nudge in/out and re-render; we only have delete | L |

Rule of thumb from the two repos: **clip count drives retention more than clip quality**
(OpenShorts measured it), and **sentence-snapped boundaries** are the cheapest visible
quality jump (AutoClip built a whole module for it). Both are now in this pipeline.

## Not borrowed, on purpose

- **LLM moment picking.** It's better on quiet content, but it adds a key, a bill, and a
  multi-second-per-minute latency floor that breaks the live path. A transcript keyword
  score (#5) gets most of the win for free.
- **Docker + Python ML stack.** whisper.cpp (Metal) + Vision + ffmpeg covers transcription,
  face detection and rendering as three native binaries and ~1.5 GB of disk.
- **Cloud auto-posting.** Real value, but it's OAuth plumbing per platform, not clipping.
