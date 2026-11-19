import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, DATA, CLIPS, readJson, writeJson, ensureDir, findBin, run } from './util.js';

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

export async function accessToken() {
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

export function getCreatorDisplayName(cleanChannel, short = false) {
  const ch = String(cleanChannel || '').toLowerCase().replace(/^@+/, '').trim();
  if (ch.includes('speed') || ch.includes('ishowspeed')) return short ? 'Speed' : 'IShowSpeed';
  if (ch.includes('ohne') || ch.includes('ohnepixel')) return short ? 'ohne' : 'ohnePixel';
  if (ch.includes('n3on')) return 'N3on';
  if (ch.includes('adin') || ch.includes('adinross')) return short ? 'Adin' : 'Adin Ross';
  if (!ch) return 'Streamer';
  return ch.charAt(0).toUpperCase() + ch.slice(1);
}

export function generateViralShortsTitle(clip, cleanChannel, rawHook = '') {
  const text = `${clip.transcript || ''} ${clip.hook || ''} ${clip.title || ''} ${rawHook}`.toLowerCase();
  const name = getCreatorDisplayName(cleanChannel, false);
  const shortName = getCreatorDisplayName(cleanChannel, true);
  const lowerCh = cleanChannel.toLowerCase();
  const candidates = [];

  const cleanSpeech = String(clip.transcript || rawHook || '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim();
  const speechWords = cleanSpeech.split(/\s+/).filter(Boolean);

  // Short punchy quotes directly from speech
  if (speechWords.length >= 2 && speechWords.length <= 6) {
    const quote = speechWords.slice(0, 5).join(' ');
    const formattedQuote = quote.charAt(0).toUpperCase() + quote.slice(1);
    candidates.push(
      `"${formattedQuote}" - ${name} In GTA 6 😭`,
      `${name}: "${formattedQuote}" 💀`,
      `${shortName} SCREAMED At This In GTA 6 😭`
    );
  }

  // 1. Police / Chase / Cops / SWAT / 5-Star
  if (/\b(police|cops?|wanted|busted|sirens?|chase|stars?|5-star|five\s*star|arrest|swat)\b/i.test(text)) {
    if (lowerCh.includes('speed')) {
      candidates.push(
        `Speed BARKING AT GTA 6 COPS 🚨💀`,
        `IShowSpeed vs 5-STAR WANTED LEVEL IN GTA 6 😭`,
        `Speed TRIED TO ESCAPE THE GTA 6 SWAT 🚨`,
        `THE GTA 6 POLICE ARE UNHINGED (Speed) 🚨💀`
      );
    } else if (lowerCh.includes('ohne')) {
      candidates.push(
        `ohnePixel CANNOT ESCAPE THE GTA 6 COPS 🚨`,
        `ohnePixel vs The Most INSANE GTA 6 Police Chase 😭`,
        `The GTA 6 Police Are Too Aggressive (ohnePixel) 🚨`,
        `ohnePixel Got A 5-Star Wanted Level in GTA 6 💀`
      );
    } else if (lowerCh.includes('n3on')) {
      candidates.push(
        `N3on GOT PRESSED BY GTA 6 POLICE 🚨💀`,
        `N3on ESCAPING 5-STAR WANTED LEVEL IN GTA 6 😭`,
        `N3on BEGGING GTA 6 COPS FOR HIS LIFE 💀`,
        `N3on vs THE ENTIRE GTA 6 POLICE DEPARTMENT 🚨`
      );
    } else if (lowerCh.includes('adin')) {
      candidates.push(
        `Adin Ross vs THE MOST AGGRESSIVE GTA 6 COPS 😭`,
        `Adin Ross GOT A 5-STAR WANTED LEVEL IN GTA 6 🚨`,
        `Adin Ross COULD NOT ESCAPE THE GTA 6 SWAT 💀`,
        `Adin Ross GETS ARRESTED IN GTA 6 😭`
      );
    } else {
      candidates.push(
        `${name} vs 5-STAR WANTED LEVEL IN GTA 6 🚨`,
        `${name} TRIED TO ESCAPE THE GTA 6 SWAT 😭`,
        `THE GTA 6 POLICE ARE UNHINGED (${name}) 🚨`,
        `${name} Got Arrested In The Wildest GTA 6 Chase 💀`
      );
    }
  }

  // 2. NPCs / AI behavior / Glitches / Weird encounters
  if (/\b(npc|pedestrian|guy|person|walk|glitch|bug|ai|traffic|talking|crazy)\b/i.test(text)) {
    candidates.push(
      `THIS GTA 6 NPC HAD REAL BEEF WITH ${name} 💀`,
      `${name} FOUND THE WEIRDEST NPC IN GTA 6 😭`,
      `GTA 6 NPCS ARE ACTUALLY TOO REAL (${name}) 💀`,
      `ROCKSTAR COOKED WITH THIS GTA 6 NPC 🤯 ft. ${name}`,
      `${name} CANNOT BELIEVE THIS GTA 6 NPC REACTION 😭`,
      `This GTA 6 AI Interaction Broke ${shortName} 💀`
    );
  }

  // 3. Car crash / physics / driving / stunts
  if (/\b(crash|car|drive|driving|physics|flying|flip|speed|drift|supercar|vehicle)\b/i.test(text)) {
    candidates.push(
      `${name} DID NOT SEE THAT GTA 6 CRASH COMING 💀`,
      `GTA 6 CRASH PHYSICS BROKE ${name} 🤯`,
      `${shortName} ACCIDENTALLY FLEW A CAR IN VICE CITY 😭`,
      `${name} TRYING TO DRIVE IN GTA 6 VICE CITY 😭`,
      `THE VEHICLE DAMAGE IN GTA 6 IS INSANE (${name}) 🤯`,
      `${shortName} Did NOT Expect GTA 6 Car Physics 💀`
    );
  }

  // 4. Combat / deaths / explosions / fail / wasted
  if (/\b(die|dead|died|kill|killed|shot|shoot|explosion|explode|gun|wasted|fail)\b/i.test(text)) {
    candidates.push(
      `INSTANT REGRET FOR ${name} IN GTA 6 💀`,
      `${name} DIED IN THE DUMBEST WAY POSSIBLE 😭`,
      `${name} COULD NOT SURVIVE 10 SECONDS IN GTA 6 💀`,
      `THIS ESCALATED WAY TOO FAST FOR ${name} 😭`,
      `${name}'s FUNNIEST DEATH IN GTA 6 💀`
    );
  }

  // 5. Creator-specific signature viral hooks
  if (lowerCh.includes('speed')) {
    candidates.push(
      `Speed BARKING AT GTA 6 COPS 🚨💀`,
      `IShowSpeed ALMOST BROKE HIS SETUP IN GTA 6 😭`,
      `Speed LOST HIS ABSOLUTE MIND IN GTA 6 💀`,
      `Speed CAUGHT IN 4K IN GTA 6 😭`,
      `IShowSpeed CANNOT BELIEVE GTA 6 GRAPHICS 🤯`,
      `Speed's CRAZIEST GTA 6 REACTION EVER 😭`
    );
  } else if (lowerCh.includes('ohne')) {
    candidates.push(
      `ohnePixel LOST HIS MIND AT THIS GTA 6 DETAIL 🤯`,
      `ohnePixel CANNOT BELIEVE WHAT ROCKSTAR DID 💀`,
      `ohnePixel FOUND THE RAREST NPC IN GTA 6 😭`,
      `THIS GTA 6 MOMENT BROKE ohnePixel 💀`,
      `ohnePixel's HONEST REACTION TO VICE CITY 🤯`,
      `ohnePixel SPOTTED SOMETHING CRAZY IN GTA 6 💀`
    );
  } else if (lowerCh.includes('n3on')) {
    candidates.push(
      `N3on GOT PRESSED BY GTA 6 POLICE 🚨💀`,
      `N3on TRIED TO FLEX IN GTA 6 AND FAILED 😭`,
      `N3on WAS NOT READY FOR GTA 6 REALISM 💀`,
      `N3on ESCAPING 5-STAR WANTED LEVEL IN GTA 6 😭`,
      `N3on BEGGING FOR HIS LIFE IN GTA 6 💀`,
      `N3on's MOST EMBARRASSING GTA 6 MOMENT 😭`
    );
  } else if (lowerCh.includes('adin')) {
    candidates.push(
      `Adin Ross BROKE HIS SETUP IN GTA 6 😭`,
      `Adin Ross COULD NOT SURVIVE 5 MINUTES 💀`,
      `Adin Ross WITNESSED THE CRAZIEST GTA 6 MOMENT 🤯`,
      `Adin Ross CANNOT BELIEVE THIS GTA 6 GRAPHICS 💀`,
      `Adin Ross ACCIDENTALLY DID THIS IN GTA 6 😭`,
      `Adin Ross vs THE HARDEST GTA 6 MISSION 💀`
    );
  } else {
    candidates.push(
      `POV: ${name} Playing GTA 6 For The First Time 😭`,
      `${name} LOST HIS MIND AT THIS GTA 6 MOMENT 😭`,
      `Average Day In GTA 6 Vice City For ${name} 💀`,
      `Rockstar Cooked With This Detail (${name}) 🤯`,
      `${name} WAS NOT READY FOR GTA 6 REALISM 💀`,
      `${name} Reacts To Insane GTA 6 Chaos 🤯`
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

export async function deleteYoutubeVideo(videoId) {
  const safeId = String(videoId || '').trim();
  if (!safeId) throw new Error('Video ID is required for deletion.');
  const token = await accessToken();
  const url = `https://www.googleapis.com/youtube/v3/videos?id=${encodeURIComponent(safeId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });

  if (res.status === 204 || res.status === 200) {
    return { success: true, deleted: true, videoId: safeId };
  }
  if (res.status === 404) {
    return { success: true, deleted: true, alreadyDeleted: true, videoId: safeId };
  }

  const errData = await res.json().catch(() => ({}));
  const errMsg = errData.error?.message || `HTTP ${res.status}`;
  if (res.status === 403 && (errMsg.includes('insufficient') || errMsg.includes('scope') || errMsg.includes('forbidden'))) {
    const error = new Error(`Cannot delete video ${safeId}: Insufficient OAuth scopes. Please reconnect YouTube in the dashboard at http://localhost:4399 to grant delete permissions.`);
    error.code = 'INSUFFICIENT_SCOPE';
    throw error;
  }
  throw new Error(`Failed to delete YouTube video ${safeId}: ${errMsg}`);
}

export async function fetchVideoViews(videoId) {
  const safeId = String(videoId || '').trim();
  if (!safeId) return null;

  // 1. Try yt-dlp first (zero API quota consumption, fast public endpoint)
  const ytdlp = findBin('yt-dlp');
  if (ytdlp) {
    try {
      const { stdout } = await run(ytdlp, [
        '--no-warnings',
        '--skip-download',
        '--print', '%(view_count)s',
        `https://www.youtube.com/shorts/${safeId}`,
      ], { allowFail: true });
      const raw = (stdout || '').trim();
      if (raw && raw !== 'NA' && raw !== 'None') {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) return parsed;
      }
    } catch {}
  }

  // 2. Fallback to YouTube Data API (costs 1 quota unit)
  try {
    const token = await accessToken();
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(safeId)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      const item = data.items?.[0];
      if (item && item.statistics?.viewCount !== undefined) {
        return parseInt(item.statistics.viewCount, 10) || 0;
      }
    }
  } catch {}

  return null;
}

export async function pruneLowViewVideos({ maxAgeHours = 24, minViews = 100, onLog = console.log } = {}) {
  ensureDir(CLIPS);
  const files = fs.readdirSync(CLIPS).filter((f) => f.endsWith('.json') && !f.endsWith('.whisper.json'));
  const results = {
    checked: 0,
    deleted: [],
    kept: [],
    flagged: [],
    skipped: 0,
  };

  const now = Date.now();

  for (const f of files) {
    const filePath = path.join(CLIPS, f);
    const clip = readJson(filePath, null);
    if (!clip?.youtube?.id) continue;
    if (clip.youtube.deleted) continue;

    const rawUploadDate = clip.youtube.uploadedAt || clip.finishedAt || clip.createdAt;
    const uploadedAt = rawUploadDate ? new Date(rawUploadDate).getTime() : null;
    if (!uploadedAt) continue;

    const ageHours = (now - uploadedAt) / (1000 * 60 * 60);
    if (ageHours < maxAgeHours) {
      results.skipped++;
      continue;
    }

    results.checked++;
    onLog(`[prune] Checking ${clip.id} (YouTube: ${clip.youtube.id}, age: ${ageHours.toFixed(1)}h)...`);

    let views = null;
    try {
      views = await fetchVideoViews(clip.youtube.id);
    } catch (err) {
      onLog(`[prune] Could not fetch views for ${clip.youtube.id}: ${err.message || err}`);
    }

    if (views === null) {
      onLog(`[prune] Unable to determine views for ${clip.youtube.id}; skipping for now.`);
      continue;
    }

    clip.youtube.views = views;
    clip.youtube.viewsCheckedAt = new Date().toISOString();

    if (views < minViews) {
      onLog(`[prune] Video ${clip.youtube.id} has only ${views} views after ${ageHours.toFixed(1)}h (< ${minViews}). Deleting from YouTube...`);
      try {
        await deleteYoutubeVideo(clip.youtube.id);
        clip.youtube.deleted = true;
        clip.youtube.deletedAt = new Date().toISOString();
        clip.youtube.deleteReason = `Only ${views} views after ${ageHours.toFixed(1)}h (threshold: ${minViews})`;
        writeJson(filePath, clip);
        results.deleted.push({ id: clip.id, youtubeId: clip.youtube.id, views, ageHours });
        onLog(`[prune] ✓ Successfully deleted ${clip.youtube.id} from YouTube!`);
      } catch (err) {
        if (err.code === 'INSUFFICIENT_SCOPE') {
          clip.youtube.flaggedForDeletion = true;
          clip.youtube.flagReason = `Only ${views} views after ${ageHours.toFixed(1)}h; needs delete scope`;
          writeJson(filePath, clip);
          results.flagged.push({ id: clip.id, youtubeId: clip.youtube.id, views, ageHours, reason: err.message });
          onLog(`[prune] ⚠ Flagged ${clip.youtube.id} for deletion (re-authenticate in UI to grant delete permission)`);
        } else {
          onLog(`[prune] ✗ Failed to delete ${clip.youtube.id}: ${err.message || err}`);
        }
      }
    } else {
      onLog(`[prune] ✓ Video ${clip.youtube.id} has ${views} views after ${ageHours.toFixed(1)}h (>= ${minViews}). Keeping!`);
      writeJson(filePath, clip);
      results.kept.push({ id: clip.id, youtubeId: clip.youtube.id, views, ageHours });
    }
  }

  return results;
}
