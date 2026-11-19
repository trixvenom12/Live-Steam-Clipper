import { DATA, ensureDir, readJson, writeJson, projectPath } from './util.js';
import { PLATFORMS, normalizeSlug } from './platforms.js';
import path from 'node:path';

const CONFIG_PATH = path.join(DATA, 'config.json');

export const DEFAULTS = {
  channels: [],
  record: { segmentSeconds: 120, maxHeight: 1080 },
  detect: {
    minScore: 2.4,
    minMessages: 15,
    ignoreStartSeconds: 360,
    minGapSeconds: 90,
    maxClipsPerHour: 6,
    lookbackSeconds: 12,
  },
  clip: {
    preRollSeconds: 10,
    lengthSeconds: 24,
    minLengthSeconds: 15,
    maxLengthSeconds: 30,
    layout: 'auto',
    ratio: '9:16',
    smartTrim: true,
    headerBanner: true,
    bgmFile: null,
    bgmMode: 'ducking',
    bgmVolume: 0.25,
    trimSilenceGap: 0.65,
    hookV2: false,
  },
  captions: {
    playResX: 1080,
    playResY: 1920,
    font: 'Arial Black',
    fontSize: 72,
    wordsPerLine: 3,
    uppercase: true,
    highlight: '&H0000E5FF',
    emphasis: '&H0000FF55',
    marginV: 360,
  },
  whisper: { model: 'models/ggml-small.en-q5_1.bin', threads: 6, language: 'en' },
  youtube: {
    autoUpload: false,
    privacyStatus: 'public',
    minUploadGapMinutes: 10,
    pruneMaxAgeHours: 24,
    pruneMinViews: 100,
  },
  ui: { port: 4321 },
};

function merge(base, override) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  ensureDir(DATA);
  const config = merge(DEFAULTS, readJson(CONFIG_PATH, {}));

  // Self-heal channels saved before URLs were normalised (e.g. a pasted
  // https://www.twitch.tv/name), and drop duplicates.
  const seen = new Set();
  config.channels = (config.channels || [])
    .filter((c) => c && PLATFORMS[c.platform])
    .map((c) => ({ ...c, slug: normalizeSlug(c.platform, c.slug) }))
    .filter((c) => {
      if (!c.slug) return false;
      const key = `${c.platform}:${c.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return config;
}

export function saveConfig(config) {
  writeJson(CONFIG_PATH, config);
  return config;
}

/** Model path may be relative to the project root. */
export function modelPath(config) {
  return projectPath(config.whisper.model);
}

export function addChannel(config, platform, slug, extra = {}) {
  if (!PLATFORMS[platform]) {
    throw new Error(`Unknown platform "${platform}". Use: ${Object.keys(PLATFORMS).join(', ')}`);
  }
  const clean = normalizeSlug(platform, slug);
  if (!clean) throw new Error(`"${slug}" is not a ${PLATFORMS[platform].label} channel.`);

  const channel = { platform, slug: clean, ...extra };
  const key = `${platform}:${clean}`;
  config.channels = config.channels.filter((c) => c.platform !== platform || c.slug !== clean);
  config.channels.push(channel);
  return channel;
}
