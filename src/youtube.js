import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, CLIPS, readJson, ensureDir } from './util.js';

const TOKEN_FILE = path.join(DATA, 'youtube-token.json');
const STATE_FILE = path.join(DATA, 'youtube-oauth-state');
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl';

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch {}
}

function credentials() {
  loadEnvFile();
  const { YOUTUBE_CLIENT_ID: clientId, YOUTUBE_CLIENT_SECRET: clientSecret } = process.env;
  if (!clientId || !clientSecret) throw new Error('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env before connecting.');
  return { clientId, clientSecret };
}

export function youtubeRedirectUri(port = 4321) {
  return `http://localhost:${port}/api/youtube/callback`;
}

export function youtubeAuthUrl(port) {
  const { clientId } = credentials();
  ensureDir(DATA);
  const state = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(STATE_FILE, state, { mode: 0o600 });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: youtubeRedirectUri(port),
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPE,
    state,
  });
  return url.href;
}

export async function youtubeCallback(params, port) {
  const expected = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8') : '';
  fs.rmSync(STATE_FILE, { force: true });
  const actual = Buffer.from(String(params.state || ''));
  const stored = Buffer.from(expected);
  if (!expected || actual.length !== stored.length || !crypto.timingSafeEqual(stored, actual)) {
    throw new Error('YouTube sign-in state did not match. Start Connect again.');
  }
  if (params.error) throw new Error(`Google sign-in failed: ${params.error}`);
  if (!params.code) throw new Error('Google did not return an authorization code.');

  const { clientId, clientSecret } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: youtubeRedirectUri(port),
      grant_type: 'authorization_code',
    }),
  });
  const token = await response.json();
  if (!response.ok || !token.refresh_token) throw new Error(token.error_description || token.error || 'Google did not return a refresh token. Revoke app access and connect again.');
  ensureDir(DATA);
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({
    refresh_token: token.refresh_token,
    access_token: token.access_token,
    expires_at: Date.now() + token.expires_in * 1000,
  }, null, 2), { mode: 0o600 });
}

export function youtubeConnected() {
  return Boolean(readJson(TOKEN_FILE, null)?.refresh_token);
}

async function accessToken() {
  const saved = readJson(TOKEN_FILE, null);
  if (!saved?.refresh_token) throw new Error('Connect a YouTube account first.');
  if (saved.access_token && saved.expires_at > Date.now() + 60_000) return saved.access_token;

  const { clientId, clientSecret } = credentials();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      refresh_token: saved.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const token = await response.json();
  if (!response.ok) throw new Error(token.error_description || token.error || 'Could not refresh YouTube sign-in.');
  saved.access_token = token.access_token;
  saved.expires_at = Date.now() + token.expires_in * 1000;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return saved.access_token;
}

export function platformUrl(platform, channel) {
  const c = String(channel || '').trim();
  if (platform === 'twitch') return `https://www.twitch.tv/${c}`;
  if (platform === 'kick') return `https://kick.com/${c}`;
  if (platform === 'youtube') return `https://www.youtube.com/${c.startsWith('@') ? c : '@' + c}`;
  return '';
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash << 5) - hash + str.charCodeAt(i);
  return hash;
}

export const MANDATORY_HASHTAGS = '#shorts #gtavi #gta6';

export function enforceShortsTitleRules(title) {
  const cleanTitle = String(title || '')
    .replace(/#\w+/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  const maxBaseLen = 100 - MANDATORY_HASHTAGS.length - 1;
  const base = cleanTitle.length > maxBaseLen ? cleanTitle.slice(0, maxBaseLen).trim() : cleanTitle;
  return `${base} ${MANDATORY_HASHTAGS}`;
}

export function generateViralShortsTitle(clip, cleanChannel, rawHook = '') {
  const text = `${clip.transcript || ''} ${clip.hook || ''} ${clip.title || ''} ${rawHook}`.toLowerCase();
  const creator = `@${cleanChannel}`;
  const candidates = [];

  const cleanSpeech = String(clip.transcript || rawHook || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim();
  const speechWords = cleanSpeech.split(/\s+/).filter(Boolean);

  // Short quote option if punchy
  if (speechWords.length >= 2 && speechWords.length <= 7) {
    const quote = speechWords.slice(0, 6).join(' ');
    candidates.push(`${creator}: "${quote.charAt(0).toUpperCase() + quote.slice(1)}" 😭`);
    candidates.push(`${creator} Screamed At This GTA 6 Moment 😭`);
  }

  // 1. Police / Chase / Cops
  if (/\b(police|cops?|wanted|busted|sirens?|chase|stars?|5-star|five\s*star|arrest)\b/i.test(text)) {
    candidates.push(
      `${creator} vs The Most INSANE GTA 6 Police Chase 😭`,
      `${creator} Trying To Escape The GTA 6 Cops 💀`,
      `The GTA 6 Police Are Too Aggressive (${creator}) 🚨`,
      `${creator} Got A 5-Star Wanted Level in GTA 6 😭`,
    );
  }
  // 2. NPCs / AI behavior
  else if (/\b(npc|pedestrian|guy|person|walk|glitch|bug|ai|traffic)\b/i.test(text)) {
    candidates.push(
      `${creator} Found The Funniest GTA 6 NPC 😭`,
      `This GTA 6 NPC Had Beef With ${creator} 💀`,
      `GTA 6 NPCs Are Actually Terrifying (${creator}) 💀`,
      `${creator} Witnessed The Wildest GTA 6 AI Moment 😭`,
    );
  }
  // 3. Car crash / physics / driving
  else if (/\b(crash|car|drive|driving|physics|flying|flip|speed|drift|supercar)\b/i.test(text)) {
    candidates.push(
      `${creator} Did NOT See That GTA 6 Crash Coming 💀`,
      `GTA 6 Car Physics Caught ${creator} Off Guard 🤯`,
      `${creator} Trying To Drive in GTA 6 Vice City 😭`,
      `The Vehicle Damage In GTA 6 Broke ${creator} 🤯`,
    );
  }
  // 4. Combat / deaths / explosions / fail
  else if (/\b(die|dead|died|kill|killed|shot|shoot|explosion|explode|gun|wasted|fail)\b/i.test(text)) {
    candidates.push(
      `Instant Regret in GTA 6 For ${creator} 💀`,
      `This Escalated WAY Too Fast for ${creator} 😭`,
      `${creator} Did NOT Expect That In GTA 6 🤯`,
      `${creator}'s Funniest Death in GTA 6 😭`,
    );
  }
  // 5. General relatable streamer reactions
  else {
    candidates.push(
      `POV: ${creator} Playing GTA 6 For The First Time 😭`,
      `${creator} Lost His Mind At This GTA 6 Moment 😭`,
      `Average Day In GTA 6 Vice City For ${creator} 💀`,
      `Rockstar Cooked With This Detail (${creator}) 🤯`,
      `${creator} Was NOT Ready For GTA 6 Realism 💀`,
      `${creator} Reacts To Insane GTA 6 Chaos 🤯`,
    );
  }

  const chosen = candidates[Math.abs(hashString(text)) % candidates.length];
  return enforceShortsTitleRules(chosen);
}

export function buildYoutubeMetadata(clip, overrides = {}) {
  const channel = clip.channel || 'Streamer';
  const cleanChannel = String(channel).replace(/^@+/, '').trim();
  const platform = (clip.platform || 'stream').toUpperCase();
  const url = platformUrl(clip.platform, cleanChannel);
  let rawHook = String(overrides.title || clip.hook || clip.title || 'GTA 6 Moment').trim();
  rawHook = rawHook.replace(/<\|endoftext\|>/g, '').trim();

  // Generate high-CTR viral title tailored for YouTube Shorts
  let title = overrides.title ? enforceShortsTitleRules(overrides.title) : generateViralShortsTitle(clip, cleanChannel, rawHook);
  title = title.slice(0, 100);

  // YouTube Description optimized for Algorithm Engagement, Creator Credit & SEO
  const defaultDesc = [
    `🔥 ${title.replace(/\s*#\w+/g, '')}`,
    '',
    '💬 What would you do in this situation? Drop your thoughts below! 👇',
    '🔔 Subscribe for daily GTA 6 clips, leaks, and top streamer highlights!',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `🎮 Streamer: @${cleanChannel} (${platform})`,
    url ? `🔴 Watch original broadcast: ${url}` : '',
    `⭐ Game: Grand Theft Auto VI (Rockstar Games)`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    '',
    '⚖️ Fair Use & DMCA Copyright Notice:',
    `This video is a transformative highlight created under Section 107 of the US Copyright Act (Fair Use) for news, commentary, and entertainment purposes. All original broadcast rights belong to @${cleanChannel} and Rockstar Games.`,
    '',
    '📬 Content Removal / Takedown Request:',
    'If you are the copyright owner and want this clip removed or modified, please contact us or comment, and it will be taken down within 24 hours.',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `#GTA6 #GrandTheftAutoVI #Shorts #Gaming #GTA6Gameplay #RockstarGames #ViceCity #GTAClips #${cleanChannel.replace(/[^\w]/g, '')}`,
  ].filter(Boolean).join('\n');

  const description = (overrides.description || defaultDesc).slice(0, 5000);

  // High-traffic GTA 6 + Streamer Tags (stay safely under YouTube 500-char limit)
  const defaultTagList = [
    'GTA 6',
    'GTA VI',
    'Grand Theft Auto 6',
    'Grand Theft Auto VI',
    'GTA 6 gameplay',
    'GTA 6 clips',
    'GTA 6 leak',
    'GTA 6 trailer',
    'GTA 6 funny moments',
    'Vice City',
    'Rockstar Games',
    cleanChannel,
    `${cleanChannel} gta 6`,
    `${cleanChannel} clips`,
    'youtube shorts',
    'gaming shorts',
    'stream highlights',
  ];

  // Keep joined tags under 420 chars
  let safeTags = [];
  let charCount = 0;
  for (const tag of defaultTagList) {
    if (charCount + tag.length + 2 < 420) {
      safeTags.push(tag);
      charCount += tag.length + 2;
    }
  }

  const tags = overrides.tags || safeTags.join(', ');
  const privacyStatus = overrides.privacyStatus || 'public';

  return { title, description, tags, privacyStatus };
}

export async function uploadYoutubeClip(id, metadata = {}) {
  const safeId = path.basename(String(id));
  if (!safeId || safeId !== id) throw new Error('Invalid clip id.');
  const clip = readJson(path.join(CLIPS, `${safeId}.json`), null);
  if (!clip?.file) throw new Error('Clip not found.');
  const file = path.join(CLIPS, path.basename(clip.file));
  const stat = fs.statSync(file);

  const formatted = buildYoutubeMetadata(clip, metadata);
  const title = String(formatted.title).trim();
  const description = String(formatted.description).trim();
  const tags = [...new Set(String(formatted.tags).split(',').map((tag) => tag.trim()).filter(Boolean))];

  if (!title || title.length > 100) throw new Error('Title is required and must be 100 characters or fewer.');
  if (description.length > 5000) throw new Error('Description must be 5,000 characters or fewer.');
  if (tags.join('').length > 500 || tags.length > 500) throw new Error('Tags exceed YouTube’s 500-character limit.');
  const privacyStatus = ['private', 'unlisted', 'public'].includes(formatted.privacyStatus) ? formatted.privacyStatus : 'public';
  const token = await accessToken();
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(stat.size),
    },
    body: JSON.stringify({
      snippet: { title, description, tags, categoryId: '20' },
      status: { privacyStatus, selfDeclaredMadeForKids: false },
    }),
  });
  if (!init.ok) {
    const error = await init.json().catch(() => ({}));
    throw new Error(error.error?.message || `YouTube upload could not start (HTTP ${init.status}).`);
  }
  const uploadUrl = init.headers.get('location');
  if (!uploadUrl) throw new Error('YouTube did not provide an upload URL.');
  const result = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4', 'content-length': String(stat.size) },
    body: fs.createReadStream(file),
    duplex: 'half',
  });
  const video = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(video.error?.message || `YouTube upload failed (HTTP ${result.status}).`);

  // Persist upload info on clip metadata
  try {
    clip.youtube = {
      id: video.id,
      url: `https://youtu.be/${video.id}`,
      uploadedAt: new Date().toISOString(),
      privacyStatus,
      title,
    };
    fs.writeFileSync(path.join(CLIPS, `${safeId}.json`), JSON.stringify(clip, null, 2));
  } catch {}

  return { id: video.id, url: `https://youtu.be/${video.id}` };
}
