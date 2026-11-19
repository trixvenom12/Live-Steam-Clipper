import fs from 'node:fs';
import path from 'node:path';
import { DATA, CLIPS, ensureDir, readJson, writeJson, slugify } from './util.js';
import { renderClip } from './render.js';

const JOBS = path.join(DATA, 'jobs');

export function jobId(platform, channel) {
  return `${platform}-${slugify(channel)}-${Date.now().toString(36)}`;
}

/**
 * One-job-at-a-time file queue. ffmpeg + whisper already use every core,
 * and jobs survive a restart because the disk is the queue.
 */
export class Queue {
  constructor(config, { onLog = () => {}, onClip = () => {} } = {}) {
    this.config = config;
    this.onLog = onLog;
    this.onClip = onClip;
    this.busy = false;
    this.currentId = null;
    this.running = null;
    ensureDir(JOBS);
    ensureDir(CLIPS);
  }

  jobFile(id) {
    return path.join(JOBS, `${id}.json`);
  }

  list() {
    return fs.readdirSync(JOBS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(JOBS, f), null))
      .filter(Boolean)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  get(id) {
    return readJson(this.jobFile(id), null);
  }

  update(id, patch) {
    const job = this.get(id);
    if (!job) return null;
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    writeJson(this.jobFile(id), next);
    return next;
  }

  enqueue(job) {
    const full = {
      status: 'queued',
      createdAt: new Date().toISOString(),
      ...job,
    };
    writeJson(this.jobFile(full.id), full);
    this.onLog(`queued ${full.id} (${(full.end - full.start).toFixed(0)}s)`);
    this.kick();
    return full;
  }

  kick() {
    if (this.running) return this.running;
    this.busy = true;
    this.running = Promise.resolve().then(async () => {
      try {
        for (;;) {
          const next = this.list().find((j) => j.status === 'queued');
          if (!next) break;
          await this.process(next);
        }
      } finally {
        this.busy = false;
        this.currentId = null;
        this.running = null;
      }
    });
    return this.running;
  }

  async process(job) {
    this.currentId = job.id;
    this.update(job.id, { status: 'transcribing', startedAt: new Date().toISOString() });
    this.onLog(`rendering ${job.id}`);
    try {
      const result = await renderClip(job, this.config, CLIPS);
        let qa = result.quality || null;
      try {
        const { technicalFloor } = await import('./qa.js');
          const technical = await technicalFloor(result.file);
          qa = { ...qa, technical };
          if (technical?.warnings?.length) this.onLog(`qa: ${job.id} ${technical.warnings.join('; ')}`);
      } catch {}
      const meta = {
        id: job.id,
        platform: job.platform,
        channel: job.channel,
        title: job.title || '',
        hook: result.hook || '',
        editPlan: result.editPlan || [],
        zeroContextScore: result.zeroContextScore ?? null,
        sessionId: job.sessionId || null,
        source: job.source || null,
        score: job.score ?? null,
        reason: job.reason || '',
        virality: job.virality || null,
        performance: null,
        start: result.start ?? job.start,
        end: result.end ?? job.end,
        duration: Math.round(result.duration * 10) / 10,
        inset: result.inset || null,
        burnedSubtitles: result.burnedSubtitles || false,
        qa: qa,
        file: path.basename(result.file),
        thumb: path.basename(result.thumb),
        transcript: result.transcript.text,
        words: result.transcript.words,
        createdAt: job.createdAt,
        finishedAt: new Date().toISOString(),
      };
      writeJson(path.join(CLIPS, `${job.id}.json`), meta);
      this.update(job.id, { status: 'done', clipId: job.id });
      this.onLog(`clip ready clips/${job.id}.mp4`);
      this.onClip(meta);

      if (this.config.youtube?.autoUpload || this.config.autoUpload) {
        try {
          const { youtubeConnected, uploadYoutubeClip } = await import('./youtube.js');
          if (youtubeConnected()) {
            const minGapMinutes = Number(this.config.youtube?.minUploadGapMinutes ?? 45);
            const uploadTrackerFile = path.join(DATA, 'last-youtube-upload.json');
            const lastUploadMeta = readJson(uploadTrackerFile, { lastUploadedAt: 0 });
            const elapsedMinutes = (Date.now() - new Date(lastUploadMeta.lastUploadedAt || 0).getTime()) / 60000;

            if (elapsedMinutes < minGapMinutes) {
              const waitMins = Math.round(minGapMinutes - elapsedMinutes);
              this.onLog(`auto-upload paced: ${job.id} queued (waiting ${waitMins}m to avoid YouTube spam flag)`);
            } else {
              const privacy = this.config.youtube?.privacyStatus || 'public';
              this.onLog(`auto-uploading ${job.id} to YouTube (${privacy})...`);
              const yt = await uploadYoutubeClip(job.id, { privacyStatus: privacy });
              writeJson(uploadTrackerFile, { lastUploadedAt: new Date().toISOString(), clipId: job.id, url: yt.url });
              this.onLog(`UPLOADED ${job.id} to YouTube: ${yt.url}`);
            }
          }
        } catch (uploadErr) {
          this.onLog(`auto-upload failed for ${job.id}: ${uploadErr.message || uploadErr}`);
        }
      }
    } catch (err) {
      this.update(job.id, { status: 'failed', error: String(err.message || err).slice(0, 2000) });
      this.onLog(`FAILED ${job.id}: ${String(err.message || err).split('\n')[0]}`);
    }
  }
}

export function clips() {
  ensureDir(CLIPS);
  return fs.readdirSync(CLIPS)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.whisper.json'))
    .map((f) => readJson(path.join(CLIPS, f), null))
    .filter(Boolean)
    .map((clip) => ({ ...clip, canUndo: fs.existsSync(path.join(CLIPS, `${path.basename(clip.id)}.original.mp4`)) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function sessions() {
  const dir = path.join(DATA, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => readJson(path.join(dir, name, 'meta.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}
