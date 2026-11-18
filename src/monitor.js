import { probe } from './platforms.js';
import { Recorder } from './record.js';

/**
 * Poll channels, record while live, stop when the stream ends.
 * Start/stop-able so the dashboard (or the CLI) can control it.
 */
export class Monitor {
  constructor(config, queue, { onLog = () => {} } = {}) {
    this.config = config;
    this.queue = queue;
    this.onLog = onLog;
    this.active = new Map();
    this.timer = null;
    this.ticking = false;
  }

  get running() {
    return Boolean(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const channel of this.config.channels) {
        const key = `${channel.platform}:${channel.slug}`;
        if (this.active.has(key)) continue;
        try {
          const info = await probe(channel.platform, channel.slug);
          if (!info.live) continue;
          this.onLog(`LIVE ${channel.platform}/${channel.slug}: ${info.title}`);
          const recorder = new Recorder({
            platform: channel.platform,
            slug: channel.slug,
            url: info.url,
            info,
            config: this.config,
            queue: this.queue,
            onLog: this.onLog,
            onStop: () => this.active.delete(key),
          });
          this.active.set(key, recorder);
          try {
            await recorder.start();
          } catch (err) {
            this.active.delete(key);
            this.onLog(`${key}: recorder failed: ${String(err.message || err).split('\n')[0]}`);
          }
        } catch (err) {
          this.onLog(`${key}: ${String(err.message || err).split('\n')[0]}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  start() {
    if (this.timer) return;
    this.onLog(`watching ${this.config.channels.length} channel(s) every 60s`);
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
  }

  async stop(reason = 'stopped watching') {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const recorders = [...this.active.values()];
    await Promise.all(recorders.map((r) => r.stop(reason)));
    this.active.clear();
  }

  async stopSession(id) {
    for (const recorder of this.active.values()) {
      if (recorder.id === id) {
        await recorder.stop('stopped from dashboard');
        return true;
      }
    }
    return false;
  }

  sessions() {
    return [...this.active.values()].map((r) => ({
      id: r.id,
      platform: r.platform,
      channel: r.slug,
      startedAt: new Date(r.startedAt || Date.now()).toISOString(),
      segments: r.index.length,
      totalSeconds: Math.round(r.totalMs / 1000),
    }));
  }
}
