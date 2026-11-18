import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, CLIPS, readJson, ensureDir } from './util.js';

const TOKEN_FILE = path.join(DATA, 'youtube-token.json');
const STATE_FILE = path.join(DATA, 'youtube-oauth-state');
const SCOPE = 'https://www.googleapis.com/auth/youtube.upload';

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

export function buildYoutubeMetadata(clip, overrides = {}) {
  const channel = clip.channel || 'Streamer';
  const platform = (clip.platform || 'stream').toUpperCase();
  const url = platformUrl(clip.platform, clip.channel);
  const hook = String(overrides.title || clip.hook || clip.title || 'GTA 6 Hype Moment').trim();

  // YouTube TOS Title: Tag creator, max 100 characters
  const tagSuffix = ` ft. @${channel} #Shorts #GTA6`;
  const maxHookLen = Math.max(10, 100 - tagSuffix.length);
  const cleanHook = hook.length > maxHookLen ? hook.slice(0, maxHookLen - 1) + '…' : hook;
  const title = (overrides.title || `${cleanHook}${tagSuffix}`).slice(0, 100);

  // YouTube TOS Description: Attribution, source broadcast link, fair use & DMCA disclaimer
  const defaultDesc = [
    cleanHook,
    '',
    '💬 What would you do in this situation? Drop your thoughts below! 👇',
    '',
    `🎮 Original Creator: @${channel} (${platform})`,
    url ? `🔴 Original Broadcast: ${url}` : '',
    '',
    'Support the original streamer by checking out their channel!',
    '',
    '⚖️ Fair Use & Copyright Notice:',
    `This video is a transformative highlight created for commentary, criticism, and entertainment under Section 107 of the US Copyright Act. All rights and credits belong to @${channel} and the respective content owners.`,
    '',
    '📬 Content Removal / Takedown Request:',
    'If you are the copyright owner and would like this video removed or credited differently, please contact us or leave a comment, and it will be taken down immediately.',
    '',
    `#GTA6 #GrandTheftAuto6 #Shorts #Gaming #${channel.replace(/[^\w]/g, '')} #${clip.platform || 'stream'}`,
  ].filter(Boolean).join('\n');

  const description = (overrides.description || defaultDesc).slice(0, 5000);

  const defaultTags = [
    channel,
    `${channel} gta 6`,
    `${channel} stream`,
    `${channel} clips`,
    'GTA 6',
    'Grand Theft Auto VI',
    'GTA 6 gameplay',
    'gaming',
    'stream clips',
    'youtube shorts',
  ].join(', ');

  const tags = overrides.tags || defaultTags;

  return { title, description, tags, privacyStatus: overrides.privacyStatus || 'private' };
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
  const privacyStatus = ['private', 'unlisted', 'public'].includes(formatted.privacyStatus) ? formatted.privacyStatus : 'private';
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
  return { id: video.id, url: `https://youtu.be/${video.id}` };
}
