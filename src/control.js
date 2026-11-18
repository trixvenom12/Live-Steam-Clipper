import fs from 'node:fs';
import path from 'node:path';
import { CLIPS, readJson, writeJson } from './util.js';
import { loadConfig, saveConfig, addChannel } from './config.js';
import { PLATFORMS } from './platforms.js';
import { Queue, clips, sessions } from './pipeline.js';
import { Monitor } from './monitor.js';
import { clipVod, clipLocalVideo } from './vod.js';
import { renderClip } from './render.js';
import { trimClip as trimRenderedClip, undoClipTrim, deleteClipBackup } from './editor.js';

/** Editable settings, clamped server-side so a phone typo can't break a stream. */
export const SETTINGS = {
  'record.segmentSeconds': { min: 60, max: 600, step: 30, label: 'Segment length', unit: 's' },
  'detect.minScore': { min: 1, max: 5, step: 0.1, label: 'Hype threshold', unit: 'σ' },
  'detect.ignoreStartSeconds': { min: 0, max: 900, step: 30, label: 'Ignore stream opening', unit: 's' },
  'detect.minGapSeconds': { min: 30, max: 600, step: 15, label: 'Min gap between clips', unit: 's' },
  'detect.maxClipsPerHour': { min: 1, max: 30, step: 1, label: 'Max clips per hour', unit: '' },
  'clip.preRollSeconds': { min: 0, max: 30, step: 1, label: 'Pre-roll', unit: 's' },
  'clip.lengthSeconds': { min: 10, max: 60, step: 1, label: 'Clip length', unit: 's' },
  'captions.wordsPerLine': { min: 1, max: 5, step: 1, label: 'Words per caption line', unit: '' },
  'captions.fontSize': { min: 40, max: 120, step: 2, label: 'Caption size', unit: 'px' },
};

const ENUMS = {
  'clip.layout': ['auto', 'split', 'blur', 'crop'],
  'captions.preset': ['default', 'karaoke', 'one-word', 'highlight'],
};

function toBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return !/^(?:false|0|off|no)$/i.test(value.trim());
  return Boolean(value);
}

export function applySettings(config, patch) {
  const changed = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'clip.layout') {
      if (ENUMS[key].includes(value)) {
        config.clip.layout = value;
        changed.push(key);
      }
      continue;
    }
    if (key === 'captions.uppercase') {
      config.captions.uppercase = toBool(value);
      changed.push(key);
      continue;
    }
    if (key === 'captions.preset') {
      if (ENUMS[key].includes(value)) {
        config.captions.preset = value;
        changed.push(key);
      }
      continue;
    }
    if (key === 'captions.kinetic') {
      config.captions.kinetic = toBool(value);
      changed.push(key);
      continue;
    }
    const spec = SETTINGS[key];
    if (!spec) continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const clamped = Math.min(spec.max, Math.max(spec.min, n));
    const [section, field] = key.split('.');
    config[section][field] = spec.step >= 1 ? Math.round(clamped) : clamped;
    changed.push(key);
  }
  return changed;
}

export function settingsSnapshot(config) {
  const out = { 'clip.layout': config.clip.layout, 'captions.uppercase': config.captions.uppercase, 'captions.preset': config.captions.preset || 'default', 'captions.kinetic': config.captions.kinetic !== false };
  for (const key of Object.keys(SETTINGS)) out[key] = config[key.split('.')[0]][key.split('.')[1]];
  return out;
}

export class Control {
  constructor(config = loadConfig()) {
    this.config = config;
    this.logs = [];
    this.queue = new Queue(this.config, {
      onLog: (m) => this.log(m),
      onClip: (c) => this.log(`clip ready: ${c.channel} — ${c.hook || c.transcript.slice(0, 50)}`),
    });
    this.monitor = new Monitor(this.config, this.queue, { onLog: (m) => this.log(m) });
    this.log('control center ready');
  }

  log(message) {
    const entry = { t: new Date().toISOString(), message: String(message) };
    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
  }

  state() {
    const recent = this.queue.list().slice(-14).reverse().map((j) => ({
      id: j.id, status: j.status, channel: j.channel, platform: j.platform,
      reason: j.reason, error: j.error || null, createdAt: j.createdAt,
    }));
    return {
      clips: clips(),
      sessions: sessions(),
      live: this.monitor.sessions(),
      watching: this.monitor.running,
      channels: this.config.channels,
      settings: settingsSnapshot(this.config),
      settingSpecs: SETTINGS,
      queue: {
        queued: recent.filter((j) => j.status === 'queued').length,
        running: recent.filter((j) => ['transcribing', 'rendering'].includes(j.status)).length,
        failed: recent.filter((j) => j.status === 'failed').length,
        recent,
      },
      logs: this.logs.slice(-40).reverse(),
    };
  }

  addChannel(platform, slug) {
    if (!PLATFORMS[platform]) throw new Error('Pick Twitch, Kick or YouTube.');
    const raw = String(slug || '').trim();
    if (!raw || raw.length > 200) throw new Error('Enter a channel name or URL.');

    const channel = addChannel(this.config, platform, raw);
    saveConfig(this.config);
    this.log(`added ${platform}/${channel.slug}`);
    if (this.monitor.running) this.monitor.tick();
    return this.config.channels;
  }

  removeChannel(platform, slug) {
    this.config.channels = this.config.channels.filter(
      (c) => !(c.platform === platform && c.slug === slug),
    );
    saveConfig(this.config);
    this.log(`removed ${platform}/${slug}`);
    return this.config.channels;
  }

  updateSettings(patch) {
    const changed = applySettings(this.config, patch);
    saveConfig(this.config);
    if (changed.length) this.log(`settings updated: ${changed.join(', ')}`);
    return settingsSnapshot(this.config);
  }

  startWatch() {
    this.monitor.start();
    return this.monitor.running;
  }

  async stopWatch() {
    await this.monitor.stop('stopped from dashboard');
    return this.monitor.running;
  }

  async stopSession(id) {
    const stopped = await this.monitor.stopSession(id);
    if (stopped) this.log(`stopped session ${id}`);
    return stopped;
  }

  async queueVod(url, top = 8) {
    if (!/^https?:\/\//.test(String(url || ''))) throw new Error('Paste a full http(s) video link.');
    this.log(`VOD queued: ${url}`);
    clipVod(url, this.config, this.queue, { top: Number(top) || 8, onLog: (m) => this.log(m) })
      .catch((err) => this.log(`VOD failed: ${String(err.message || err).split('\n')[0]}`));
    return { started: true };
  }

  queueLocalVideo(file, title, top = 8) {
    this.log(`local video queued: ${title}`);
    clipLocalVideo(file, title, this.config, this.queue, {
      top: Number(top) || 8,
      onLog: (message) => this.log(message),
    }).catch((err) => this.log(`local video failed: ${String(err.message || err).split('\n')[0]}`));
    return { started: true };
  }

  deleteClip(id) {
    const clip = readJson(path.join(CLIPS, `${path.basename(id)}.json`), null);
    if (!clip) return false;
    for (const f of [clip.file, clip.thumb, `${clip.id}.json`]) {
      if (f) fs.rmSync(path.join(CLIPS, path.basename(f)), { force: true });
    }
    deleteClipBackup(clip.id);
    this.log(`deleted clip ${clip.id}`);
    return true;
  }

  async trimClip(id, start, end) {
    const clip = await trimRenderedClip(id, start, end);
    this.log(`clip trimmed: ${clip.id}`);
    return clip;
  }

  async undoClipTrim(id) {
    const clip = await undoClipTrim(id);
    this.log(`clip trim undone: ${clip.id}`);
    return clip;
  }

  async recutClip(id, start, end) {
    const file = path.join(CLIPS, `${path.basename(id)}.json`);
    const clip = readJson(file, null);
    if (!clip?.source) throw new Error('This clip has no source to re-cut from.');
    const video = path.join(CLIPS, path.basename(clip.file));
    const backup = path.join(CLIPS, `${path.basename(id)}.original.mp4`);
    if (!fs.existsSync(backup)) fs.copyFileSync(video, backup);
    const job = { id: clip.id, source: clip.source, start: Number(start), end: Number(end) };
    const result = await renderClip(job, this.config, CLIPS);
    clip.duration = result.duration;
    clip.start = result.start;
    clip.end = result.end;
    clip.transcript = result.transcript.text;
    clip.words = result.transcript.words;
    clip.hook = result.hook;
    clip.inset = result.inset;
    clip.burnedSubtitles = result.burnedSubtitles || false;
    clip.canUndo = true;
    clip.originalDuration ??= Number(clip.originalDuration || clip.duration);
    clip.editedAt = new Date().toISOString();
    writeJson(file, clip);
    this.log(`clip recut: ${clip.id}`);
    return clip;
  }

  recordPerformance(id, data = {}) {
    const file = path.join(CLIPS, `${path.basename(id)}.json`);
    const clip = readJson(file, null);
    if (!clip) return null;
    const perf = {
      views: Number(data.views) || 0,
      likes: Number(data.likes) || 0,
      comments: Number(data.comments) || 0,
      shares: Number(data.shares) || 0,
      saves: Number(data.saves) || 0,
      retention: Number.isFinite(Number(data.retention)) ? Number(data.retention) : null,
      notes: String(data.notes || '').slice(0, 500),
      recordedAt: new Date().toISOString(),
    };
    clip.performance = perf;
    writeJson(file, clip);
    this.log(`performance recorded for ${clip.id}: ${perf.views} views`);
    return clip;
  }
}
