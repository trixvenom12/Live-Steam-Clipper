#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ROOT, DATA, CLIPS, ensureDir, run, findBin, readJson, writeJson,
  projectPath, parseTime, clock, slugify, ffmpegBin,
} from './util.js';
import { loadConfig, saveConfig, addChannel, modelPath } from './config.js';
import { Queue, jobId, clips, sessions } from './pipeline.js';
import { Recorder } from './record.js';
import { clipVod } from './vod.js';
import { Control } from './control.js';
import { startUi } from './server.js';

const args = process.argv.slice(2);
const command = args[0] || 'help';
const { flags, positional } = parseArgs(args.slice(1));

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);

function usage() {
  console.log(`
  GTA CLIPPER — automated stream clips with word-synced captions

  SETUP
    setup                          install yt-dlp, whisper.cpp + model (idempotent)
    doctor                         check every binary and path

  CHANNELS
    add <twitch|kick|youtube> <slug> [--label name]
    remove <twitch|kick|youtube> <slug>
    list

  RUN
    watch [--ui] [--once]          watch channels, record live, clip hot moments
    ui [--port 4321]       dashboard; start monitoring from its Watching switch
    record <platform> <slug>       record one channel now (Ctrl+C to stop)
    vod <url> [--top 8]            download a finished stream and clip it
    clip <file> --at 12:30 [--len 30] [--channel name]
    upload <clip-id>               upload a rendered clip to YouTube Shorts
    prune [--hours 24] [--min-views 100]  delete underperforming YouTube uploads

  EXAMPLES
    node src/cli.js add twitch xqc
    node src/cli.js ui                 # open the dashboard; turn Watching on when ready
    node src/cli.js watch --ui
    node src/cli.js vod https://www.youtube.com/watch?v=... --top 10

  Options: --segment 120   segment length for live recording (seconds)
           --layout auto|split|blur|crop   auto = detect the webcam inset (default)
           --cam 0.72,0.62,0.28,0.36     manual webcam rect, normalized x,y,w,h
           --pre 12 --len 30   clip pre-roll and length (seconds)
           --open              LAN dashboard without the access token (trusted network)
           --host 0.0.0.0      address the dashboard binds to
`);
}

async function setup() {
  ensureDir(DATA); ensureDir(CLIPS);
  ensureDir(path.join(ROOT, '.tools/bin'));
  ensureDir(path.join(ROOT, 'models'));

  if (!findBin('ffmpeg')) {
    console.error('✗ ffmpeg is required. Install it (brew install ffmpeg) and rerun setup.');
    process.exitCode = 1;
  } else console.log('✓ ffmpeg');

  if (!findBin('yt-dlp')) {
    console.log('→ downloading yt-dlp…');
    await run('curl', ['-L', '--fail', '-o', path.join(ROOT, '.tools/bin/yt-dlp'),
      'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'], { echo: true });
    fs.chmodSync(path.join(ROOT, '.tools/bin/yt-dlp'), 0o755);
  }
  console.log('✓ yt-dlp');

  if (!findBin('whisper-cli') && !findBin('main')) {
    const src = path.join(ROOT, '.tools/src/whisper.cpp');
    const cmake = findBin('cmake') ||
      path.join(ROOT, '.tools/cmake/CMake.app/Contents/bin/cmake');

    if (!fs.existsSync(cmake)) {
      console.log('→ downloading cmake…');
      await run('curl', ['-L', '--fail', '-o', path.join(ROOT, '.tools/cmake.tar.gz'),
        'https://github.com/Kitware/CMake/releases/download/v4.5.0/cmake-4.5.0-macos-universal.tar.gz'], { echo: true });
      await run('tar', ['xzf', path.join(ROOT, '.tools/cmake.tar.gz'), '-C', path.join(ROOT, '.tools')]);
      fs.renameSync(path.join(ROOT, '.tools/cmake-4.5.0-macos-universal'), path.join(ROOT, '.tools/cmake'));
      fs.rmSync(path.join(ROOT, '.tools/cmake.tar.gz'), { force: true });
    }

    if (!fs.existsSync(src)) {
      console.log('→ cloning whisper.cpp…');
      ensureDir(path.dirname(src));
      await run('git', ['clone', '--depth', '1', '--branch', 'v1.9.5',
        'https://github.com/ggml-org/whisper.cpp.git', src], { echo: true });
    }
    console.log('→ building whisper.cpp (Metal)…');
    await run(cmake, ['-B', path.join(src, 'build'), '-DCMAKE_BUILD_TYPE=Release', '-DWHISPER_METAL=ON'], { cwd: src, echo: true });
    await run(cmake, ['--build', path.join(src, 'build'), '--config', 'Release', '-j',
      String(Math.max(2, Math.min(8, (await import('node:os')).cpus().length)))], { cwd: src, echo: true });
  }
  console.log('✓ whisper-cli');

  const config = loadConfig();
  const model = modelPath(config);
  if (!fs.existsSync(model)) {
    console.log('→ downloading whisper model…');
    ensureDir(path.dirname(model));
    await run('curl', ['-L', '--fail', '-o', model,
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin'], { echo: true });
  }
  console.log(`✓ model ${(fs.statSync(model).size / 1e6).toFixed(0)} MB`);

  if (findBin('swiftc') && fs.existsSync(path.join(ROOT, 'scripts/face-scan.swift'))) {
    console.log('→ building face detector…');
    await run('swiftc', ['-O', path.join(ROOT, 'scripts/face-scan.swift'), '-o', path.join(ROOT, '.tools/bin/face-scan')], { allowFail: true });
    console.log('✓ face-scan');
  }

  saveConfig(config);
  console.log('\nReady. Next: node src/cli.js add twitch <channel> && node src/cli.js watch --ui');
}

async function doctor() {
  const rows = [];
  const version = async (bin, vArgs) => {
    if (!bin) return ['missing', null];
    const r = await run(bin, vArgs, { allowFail: true });
    return [r.stdout.trim().split('\n')[0] || 'ok', bin];
  };
  const [ffv, ffp] = await version(findBin('ffmpeg'), ['-version']);
  const [ytv, ytp] = await version(findBin('yt-dlp'), ['--version']);
  const wc = findBin('whisper-cli') || findBin('main');
  const model = modelPath(loadConfig());

  rows.push(['node', process.version]);
  rows.push(['ffmpeg', ffp ? `${ffv} — ${ffp}` : 'MISSING']);
  rows.push(['yt-dlp', ytp ? `${ytv} — ${ytp}` : 'MISSING']);
  rows.push(['whisper', wc || 'MISSING']);
  rows.push(['face-scan', findBin('face-scan') || (findBin('swiftc') ? 'not built (built on first clip)' : 'unavailable')]);
  rows.push(['model', fs.existsSync(model) ? `${model} (${(fs.statSync(model).size / 1e6).toFixed(0)} MB)` : `MISSING ${model}`]);
  rows.push(['fonts', fs.existsSync('/System/Library/Fonts/Supplemental') ? 'ok' : 'missing']);
  const config = loadConfig();
  rows.push(['channels', config.channels.map((c) => `${c.platform}/${c.slug}`).join(', ') || 'none']);
  rows.push(['clips', String(clips().length)]);

  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`  ${k.padEnd(width)}  ${v}`);
}

function applyFlags(config) {
  if (flags.segment) config.record.segmentSeconds = Number(flags.segment);
  if (flags.layout) config.clip.layout = String(flags.layout);
  if (flags.pre) config.clip.preRollSeconds = Number(flags.pre);
  if (flags.len) config.clip.lengthSeconds = Number(flags.len);
  if (flags.port) config.ui.port = Number(flags.port);
  if (flags.cam) {
    const [x, y, w, h] = String(flags.cam).split(',').map(Number);
    if ([x, y, w, h].every((n) => Number.isFinite(n))) config.clip.camRect = { x, y, w, h, corner: 'manual' };
  }
  return config;
}

async function runWatch(config) {
  const control = new Control(config);
  const port = Number(flags.port || config.ui.port);

  if (flags.ui) {
    startUi(port, control, { open: Boolean(flags.open), host: String(flags.host || '0.0.0.0') });
  }

  if (flags.once) {
    await control.monitor.tick();
    log('one pass done');
    return;
  }

  control.startWatch();
  const stop = async () => {
    log('shutting down…');
    await control.stopWatch();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function runRecord(config) {
  const [platform, slug] = positional;
  if (!platform || !slug) return usage();
  const { probe } = await import('./platforms.js');
  const info = await probe(platform, slug);
  if (!info.live) {
    console.error(`✗ ${platform}/${slug} is not live.`);
    process.exitCode = 1;
    return;
  }
  const queue = new Queue(config, { onLog: log });
  const recorder = new Recorder({
    platform, slug, url: info.url, info, config, queue, onLog: log,
  });
  await recorder.start();
  process.on('SIGINT', async () => {
    await recorder.stop('user stop');
    await queue.kick();
    process.exit(0);
  });
}

async function runVod(config) {
  const url = positional[0];
  if (!url) return usage();
  const queue = new Queue(config, { onLog: log, onClip: (c) => log(`  → clips/${c.file}`) });
  const onSignal = () => log('stop requested; waiting for VOD cleanup…');
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    await clipVod(url, config, queue, { top: Number(flags.top || 8), onLog: log });
    log('done. open the gallery: node src/cli.js ui');
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

async function runClip(config) {
  const file = positional[0];
  if (!file || !flags.at) return usage();
  const queue = new Queue(config, { onLog: log });
  const at = parseTime(flags.at);
  const len = Number(flags.len || config.clip.lengthSeconds);
  queue.enqueue({
    id: jobId('manual', flags.channel || 'local'),
    platform: 'manual',
    channel: flags.channel || 'local',
    title: path.basename(file),
    source: { kind: 'file', file: path.resolve(file) },
    start: Math.max(0, at - Number(flags.pre ?? config.clip.preRollSeconds)),
    end: Math.max(0, at - Number(flags.pre ?? config.clip.preRollSeconds)) + len,
    reason: `manual @ ${clock(at)}`,
  });
  await queue.kick();
}

async function runUi(config) {
  const control = new Control(config);
  startUi(Number(flags.port || config.ui.port), control, {
    open: Boolean(flags.open),
    host: String(flags.host || '0.0.0.0'),
  });

  const stop = async () => {
    log('shutting down…');
    await control.stopWatch();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const config = applyFlags(loadConfig());
  switch (command) {
    case 'setup': return setup();
    case 'doctor': return doctor();
    case 'add': {
      const [platform, slug] = positional;
      if (!platform || !slug) return usage();
      addChannel(config, platform, slug, flags.label ? { label: String(flags.label) } : {});
      saveConfig(config);
      return log(`added ${platform}/${slug}`);
    }
    case 'remove': {
      const [platform, slug] = positional;
      config.channels = config.channels.filter((c) => !(c.platform === platform && c.slug === slug));
      saveConfig(config);
      return log(`removed ${platform}/${slug}`);
    }
    case 'list': {
      if (!config.channels.length) return log('no channels — add with: node src/cli.js add twitch <slug>');
      for (const c of config.channels) log(`${c.platform}/${c.slug}`);
      const live = sessions().filter((s) => s.status === 'recording');
      if (live.length) log(`recording: ${live.map((s) => s.id).join(', ')}`);
      return;
    }
    case 'watch': return runWatch(config);
    case 'record': return runRecord(config);
    case 'vod': return runVod(config);
    case 'clip': return runClip(config);
    case 'upload': {
      const id = positional[0];
      if (!id) {
        console.error('Usage: node src/cli.js upload <clip-id> [--title "..."] [--privacy public|unlisted|private]');
        process.exitCode = 1;
        return;
      }
      const { uploadYoutubeClip } = await import('./youtube.js');
      const privacyStatus = flags.privacy || 'public';
      const meta = { privacyStatus };
      if (flags.title) meta.title = flags.title;
      if (flags.description) meta.description = flags.description;
      if (flags.tags) meta.tags = flags.tags;
      console.log(`Uploading ${id} to YouTube (${privacyStatus})...`);
      const res = await uploadYoutubeClip(id, meta);
      return log(`✓ Upload complete: ${res.url}`);
    }
    case 'upload-all': {
      const { uploadYoutubeClip, youtubeConnected } = await import('./youtube.js');
      if (!youtubeConnected()) {
        console.error('YouTube is not connected. Connect your account in the UI or set up OAuth first.');
        process.exitCode = 1;
        return;
      }
      const { clips } = await import('./pipeline.js');
      const all = clips().filter((c) => !c.youtube?.id && fs.existsSync(path.join(CLIPS, path.basename(c.file))));
      const limit = Number(flags.limit) || 10;
      const privacyStatus = flags.privacy || 'public';
      console.log(`Found ${all.length} unuploaded clips. Uploading top ${Math.min(limit, all.length)} to YouTube (${privacyStatus})...`);
      for (const clip of all.slice(0, limit)) {
        try {
          console.log(`\nUploading ${clip.id} (Score: ${clip.score}, Creator: ${clip.channel})...`);
          const res = await uploadYoutubeClip(clip.id, { privacyStatus });
          console.log(`✓ Upload complete: ${res.url}`);
        } catch (err) {
          console.error(`✗ Failed to upload ${clip.id}: ${err.message}`);
          if (err.message.includes('quotaExceeded')) {
            console.error('YouTube API quota reached for today.');
            break;
          }
        }
      }
      return;
    }
    case 'prune': {
      const { pruneLowViewVideos, youtubeConnected } = await import('./youtube.js');
      if (!youtubeConnected()) {
        console.error('YouTube is not connected. Connect your account in the UI or set up OAuth first.');
        process.exitCode = 1;
        return;
      }
      const maxAgeHours = Number(flags.hours || flags['max-age'] || config.youtube?.pruneMaxAgeHours || 24);
      const minViews = Number(flags.views || flags['min-views'] || config.youtube?.pruneMinViews || 100);
      console.log(`Checking YouTube uploads older than ${maxAgeHours}h with fewer than ${minViews} views...`);
      const results = await pruneLowViewVideos({ maxAgeHours, minViews, onLog: (m) => console.log(m) });
      console.log(`\nPrune summary:`);
      console.log(`  Checked: ${results.checked}`);
      console.log(`  Deleted: ${results.deleted.length}`);
      console.log(`  Kept:    ${results.kept.length}`);
      console.log(`  Flagged: ${results.flagged.length}`);
      console.log(`  Skipped (<${maxAgeHours}h): ${results.skipped}`);
      return;
    }
    case 'perf': {
      const id = positional[0];
      if (!id) return usage();
      const control = new Control(config);
      const clip = control.recordPerformance(id, {
        views: flags.views, likes: flags.likes, comments: flags.comments,
        shares: flags.shares, saves: flags.saves, retention: flags.retention, notes: flags.notes,
      });
      if (!clip) { console.error('clip not found'); process.exitCode = 1; return; }
      return log(`recorded performance for ${clip.id}`);
    }
    case 'ui':
    case 'serve': return runUi(config);
    default: return usage();
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message || err}`);
  process.exit(1);
});
