import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, DATA, ensureDir, readJson, writeJson, slugify, clock,
  spawnStream, probeDuration, ffmpegBin, findBin,
} from './util.js';
import { startChat } from './platforms.js';
import { findPeaks, extractLoudness } from './analyze.js';
import { jobId } from './pipeline.js';

const SESSIONS = path.join(DATA, 'sessions');

/**
 * Live session: yt-dlp -> ffmpeg segment muxer, chat captured alongside.
 * Every completed segment is scored; hot segments become clip jobs.
 */
export class Recorder {
  constructor({ platform, slug, url, info, config, queue, onLog = () => {}, onStop = () => {} }) {
    this.platform = platform;
    this.slug = slug;
    this.url = url;
    this.info = info || {};
    this.config = config;
    this.queue = queue;
    this.onLog = onLog;
    this.onStop = onStop;
    this.chat = [];
    this.index = [];
    this.totalMs = 0;
    this.analyzed = new Set();
    this.lastClipAt = -Infinity;
    this.stopping = false;
    this.analysis = Promise.resolve();
    this.id = `${platform}-${slugify(slug)}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
    this.dir = path.join(SESSIONS, this.id);
    this.segDir = path.join(this.dir, 'segments');
  }

  meta(patch = {}) {
    const base = readJson(path.join(this.dir, 'meta.json'), {});
    const next = {
      ...base,
      id: this.id,
      platform: this.platform,
      channel: this.slug,
      title: this.info.title || '',
      url: this.url,
      startedAt: base.startedAt || new Date().toISOString(),
      status: 'recording',
      segmentSeconds: this.config.record.segmentSeconds,
      segments: this.index.length,
      totalSeconds: Math.round(this.totalMs / 1000),
      ...patch,
    };
    writeJson(path.join(this.dir, 'meta.json'), next);
    return next;
  }

  async start() {
    ensureDir(this.segDir);
    this.meta({ status: 'recording' });
    this.startedAt = Date.now();

    const ytdlp = findBin('yt-dlp');
    if (!ytdlp) throw new Error('yt-dlp not found. Run: npm run setup');
    const ffmpeg = ffmpegBin();
    const maxH = this.config.record.maxHeight || 1080;

    const fragDir = ensureDir(path.join(this.dir, 'fragments'));
    const ytdlpArgs = [
      '--no-warnings', '--no-playlist',
      ...(this.platform === 'twitch' ? ['--live-from-start'] : []),
      '-P', `temp:${fragDir}`,
      '-P', `home:${fragDir}`,
      '-f', `bv*[height<=${maxH}]+ba/b[height<=${maxH}]/b`,
      '-o', '-', this.url,
    ];
    this.downloader = spawnStream(ytdlp, ytdlpArgs, { cwd: fragDir });
    this.downloader.stderr.on('data', () => {});
    this.downloader.stdout.on('error', () => {});
    this.downloader.on('error', (err) => this.onLog(`yt-dlp error: ${err.message}`));

    this.encoder = spawnStream(ffmpeg, [
      '-hide_banner', '-loglevel', 'error',
      '-err_detect', 'ignore_err',
      '-fflags', '+genpts+discardcorrupt',
      '-i', 'pipe:0',
      '-map', '0:v?',
      '-map', '0:a?',
      '-c', 'copy',
      '-f', 'segment',
      '-segment_format', 'mpegts',
      '-segment_time', String(this.config.record.segmentSeconds),
      '-reset_timestamps', '1',
      path.join(this.segDir, '%05d.ts'),
    ]);
    this.encoder.stderr.on('data', (d) => this.onLog(`ffmpeg: ${String(d).trim().split('\n').pop()}`));
    this.encoder.stdin.on('error', () => {});
    this.encoder.on('error', (err) => this.onLog(`ffmpeg error: ${err.message}`));
    this.downloader.stdout.pipe(this.encoder.stdin);

    const chatFile = fs.createWriteStream(path.join(this.dir, 'chat.jsonl'), { flags: 'a' });
    this.stopChat = startChat({
      platform: this.platform,
      slug: this.slug,
      url: this.url,
      onMessage: (m) => {
        this.chat.push(m);
        chatFile.write(`${JSON.stringify(m)}\n`);
      },
      onError: (err) => this.onLog(`chat: ${err.message}`),
    });

    this.encoder.on('exit', (code) => {
      if (!this.stopping) {
        this.onLog(`ffmpeg exited (${code ?? 0})`);
        this.stop('ffmpeg exited');
      }
    });

    this.downloader.on('exit', (code) => {
      if (!this.stopping) {
        this.onLog(`stream ended (yt-dlp ${code ?? 0})`);
        this.stop('stream ended');
      }
    });

    this.timer = setInterval(() => {
      this.scan().catch((err) => this.onLog(`scan: ${err.message}`));
    }, 5000);

    this.onLog(`recording ${this.platform}/${this.slug} -> data/sessions/${this.id}`);
    this.scan().catch(() => {});
  }

  /** Promote finished segment files into the index, then score them. */
  async scan(final = false) {
    if (!fs.existsSync(this.segDir)) return;
    const files = fs.readdirSync(this.segDir).filter((f) => f.endsWith('.ts')).sort();
    const complete = final ? files : files.slice(0, -1);

    for (const name of complete) {
      const file = path.join(this.segDir, name);
      if (this.index.some((s) => s.file === file)) continue;
      const duration = await probeDuration(file);
      if (!(duration > 0.2)) continue;
      this.index.push({
        file,
        startMs: Math.round(this.totalMs),
        durationMs: Math.round(duration * 1000),
      });
      this.totalMs += duration * 1000;
    }
    this.meta();

    // Score segment N only once N+1 exists: a clip may run past the boundary.
    for (let i = 0; i < this.index.length; i++) {
      const entry = this.index[i];
      if (this.analyzed.has(entry.file)) continue;
      if (i === this.index.length - 1 && !final) continue;
      this.analyzed.add(entry.file);
      this.analysis = this.analysis
        .then(() => this.scoreSegment(entry))
        .catch((err) => this.onLog(`score: ${err.message}`));
    }
  }

  async scoreSegment(entry) {
    const duration = entry.durationMs / 1000;
    const startMs = entry.startMs;
    const chatTimes = this.chat
      .filter((m) => m.t >= startMs && m.t < startMs + entry.durationMs)
      .map((m) => (m.t - startMs) / 1000);

    const loudness = await extractLoudness(entry.file);
    const ignoreStartSeconds = Math.max(
      0,
      (this.config.detect.ignoreStartSeconds || 0) - startMs / 1000,
    );
    const peaks = findPeaks({
      chatTimes,
      loudness,
      duration,
      detect: { ...this.config.detect, ignoreStartSeconds },
    });
    if (!peaks.length) return;

    for (const peak of peaks) {
      const atSeconds = startMs / 1000 + peak.at;
      if (atSeconds - this.lastClipAt < this.config.detect.minGapSeconds) continue;
      const { preRollSeconds, lengthSeconds, minLengthSeconds, maxLengthSeconds } = this.config.clip;
      let start = Math.max(0, atSeconds - preRollSeconds);
      let end = Math.min(this.totalMs / 1000, start + lengthSeconds);
      if (end - start < minLengthSeconds) {
        start = Math.max(0, end - minLengthSeconds);
      }
      if (end - start > maxLengthSeconds) end = start + maxLengthSeconds;
      if (end - start < 5) continue;

      this.lastClipAt = atSeconds;
      this.queue.enqueue({
        id: jobId(this.platform, this.slug),
        platform: this.platform,
        channel: this.slug,
        title: this.info.title || '',
        sessionId: this.id,
        source: { kind: 'segments', id: this.id, segments: this.segmentsFor(start - 3, end + 2) },
        start,
        end,
        score: peak.score,
        reason: `chat +${peak.chatZ}σ, audio +${peak.audioZ}σ at ${clock(atSeconds)}`,
        virality: {
          score: peak.score,
          chatZ: peak.chatZ,
          audioZ: peak.audioZ,
          visualZ: peak.visualZ,
          components: peak.components || null,
          rationale: peak.rationale || '',
        },
      });
    }
  }

  segmentsFor(startSeconds, endSeconds) {
    const from = startSeconds * 1000;
    const to = endSeconds * 1000;
    return this.index.filter(
      (s) => s.startMs + s.durationMs > from && s.startMs < to,
    );
  }

  async stop(reason = 'stopped') {
    if (this.stopping) return;
    this.stopping = true;
    clearInterval(this.timer);
    this.onLog(`stopping recording (${reason})`);

    try { this.stopChat?.(); } catch {}
    try { this.downloader?.stdin?.destroy(); } catch {}
    try { this.downloader?.kill('SIGINT'); } catch {}
    try { this.encoder?.kill('SIGINT'); } catch {}

    await Promise.race([
      new Promise((resolve) => this.encoder?.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 15000)),
    ]);
    try { this.encoder?.kill('SIGKILL'); } catch {}
    try { this.downloader?.kill('SIGKILL'); } catch {}

    await this.scan(true);
    await this.analysis;
    this.meta({ status: 'done', endedAt: new Date().toISOString(), totalSeconds: Math.round(this.totalMs / 1000) });
    this.onLog(`session ${this.id} closed: ${this.index.length} segments, ${clock(this.totalMs / 1000)}`);
    this.onStop(this);
  }
}
