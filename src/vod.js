import fs from 'node:fs';
import path from 'node:path';
import { run, ensureDir, readJson, writeJson, slugify, clock, findBin, probeDuration, DATA } from './util.js';
import { findPeaks, extractLoudness, extractVisualActivity } from './analyze.js';
import { fetchVodChat, parseChatFile } from './platforms.js';
import { jobId } from './pipeline.js';

export function platformOf(url) {
  if (/twitch\.tv/i.test(url)) return 'twitch';
  if (/kick\.com/i.test(url)) return 'kick';
  if (/(youtube\.com|youtu\.be)/i.test(url)) return 'youtube';
  return 'unknown';
}

function removeSourceFiles(dir, onLog) {
  for (const file of fs.readdirSync(dir).filter((name) => name.startsWith('source.'))) {
    try {
      fs.rmSync(path.join(dir, file), { force: true });
    } catch (err) {
      onLog(`could not remove temporary VOD file ${file}: ${err.message}`);
    }
  }
}

async function analyzeAndQueue({ sourceFile, id, platform, channel, title, chat = [], config, queue, top, onLog }) {
  const duration = await probeDuration(sourceFile);
  if (!(duration > 0)) throw new Error('Could not read the video duration.');

  onLog('analyzing sound…');
  const loudness = await extractLoudness(sourceFile);
  onLog('analyzing motion and scene changes…');
  const visualActivity = await extractVisualActivity(sourceFile);
  const peaks = findPeaks({
    chatTimes: chat.map((message) => message.t),
    loudness,
    visualActivity,
    duration,
    detect: {
      ...config.detect,
      minMessages: chat.length ? config.detect.minMessages : 0,
      maxClipsPerHour: Math.ceil((top * 3600) / Math.max(60, duration)),
    },
  });

  let queued = 0;
  for (const peak of peaks.slice(0, top)) {
    let start = Math.max(0, peak.at - config.clip.preRollSeconds);
    let end = Math.min(duration, start + config.clip.lengthSeconds);
    if (end - start < config.clip.minLengthSeconds) start = Math.max(0, end - config.clip.minLengthSeconds);
    if (end - start > config.clip.maxLengthSeconds) end = start + config.clip.maxLengthSeconds;
    if (end - start < 5) continue;
    queue.enqueue({
      id: jobId(platform, channel),
      platform,
      channel,
      title,
      sessionId: id,
      source: { kind: 'file', file: sourceFile },
      start,
      end,
      score: peak.score,
      reason: chat.length
        ? `chat +${peak.chatZ}σ, audio +${peak.audioZ}σ at ${clock(peak.at)}`
        : `audio +${peak.audioZ}σ, visual +${peak.visualZ}σ at ${clock(peak.at)}`,
        virality: {
          score: peak.score,
          chatZ: peak.chatZ,
          audioZ: peak.audioZ,
          visualZ: peak.visualZ,
          components: peak.components || null,
          rationale: peak.rationale || '',
        },
    });
    queued++;
  }
  onLog(`${queued} clip${queued === 1 ? '' : 's'} queued`);
  await queue.kick();
  return { id, peaks: peaks.length, queued, sourceFile };
}

/** Download a finished stream, score it, queue the best moments, then remove its full source. */
export async function clipVod(url, config, queue, { top = 8, onLog = () => {} } = {}) {
  const ytdlp = findBin('yt-dlp');
  if (!ytdlp) throw new Error('yt-dlp not found. Run: npm run setup');
  const platform = platformOf(url);
  const info = JSON.parse((await run(ytdlp, ['--no-warnings', '--skip-download', '-J', url])).stdout);
  if (info.is_live) throw new Error('That stream is live — use "watch" or "record" instead.');

  const id = `${platform}-${slugify(info.uploader || info.channel || 'vod')}-${String(info.id).slice(-8)}`;
  const dir = ensureDir(path.join(DATA, 'vod', id));
  writeJson(path.join(dir, 'meta.json'), {
    id, platform, url, title: info.title, uploader: info.uploader, duration: Number(info.duration) || 0, downloadedAt: new Date().toISOString(),
  });
  onLog(`${info.title || info.id} — ${clock(Number(info.duration) || 0)}`);

  try {
    let source = fs.readdirSync(dir).find((file) => file.startsWith('source.'));
    if (!source) {
      onLog('downloading video…');
      await run(ytdlp, [
        '--no-warnings', '--no-playlist', '--no-part',
        '-f', `bv*[height<=${config.record.maxHeight || 1080}]+ba/b`,
        '-o', path.join(dir, 'source.%(ext)s'), url,
      ], { echo: true });
      source = fs.readdirSync(dir).find((file) => file.startsWith('source.'));
    }
    const sourceFile = path.join(dir, source);
    onLog(`source ready (${(fs.statSync(sourceFile).size / 1e9).toFixed(2)} GB)`);

    let chat = [];
    try {
      if (platform === 'youtube') {
        onLog('downloading chat replay…');
        await run(ytdlp, [
          '--no-warnings', '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
          '-o', path.join(dir, 'chat'), url,
        ], { allowFail: true });
        const chatFile = path.join(dir, 'chat.live_chat.json');
        if (fs.existsSync(chatFile)) chat = parseChatFile(fs.readFileSync(chatFile, 'utf8'));
      } else {
        chat = await fetchVodChat(platform, url, info);
      }
    } catch (err) {
      onLog(`chat replay unavailable (${err.message.split('\n')[0]}) — using audio and video`);
    }
    onLog(`${chat.length} chat messages`);
    return await analyzeAndQueue({
      sourceFile, id, platform, channel: info.uploader || info.channel || 'vod',
      title: info.title || '', chat, config, queue, top, onLog,
    });
  } finally {
    removeSourceFiles(dir, onLog);
    onLog('temporary VOD source removed');
  }
}

/** Analyze an uploaded local video and remove its temporary copy after rendering. */
export async function clipLocalVideo(sourceFile, title, config, queue, { top = 8, onLog = () => {} } = {}) {
  const id = path.basename(path.dirname(sourceFile));
  const dir = path.dirname(sourceFile);
  const duration = await probeDuration(sourceFile);
  writeJson(path.join(dir, 'meta.json'), {
    id, platform: 'local', title, duration, downloadedAt: new Date().toISOString(),
  });
  onLog(`${title} — ${clock(duration)}`);
  try {
    if (!(duration > 0)) throw new Error('Could not read the video duration.');
    onLog(`source ready (${(fs.statSync(sourceFile).size / 1e9).toFixed(2)} GB)`);
    return await analyzeAndQueue({
      sourceFile, id, platform: 'local', channel: 'Local video', title,
      config, queue, top, onLog,
    });
  } finally {
    removeSourceFiles(dir, onLog);
    onLog('temporary video source removed');
  }
}

export function vodMeta(id) {
  return readJson(path.join(DATA, 'vod', id, 'meta.json'), null);
}
