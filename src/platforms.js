import { spawnStream, findBin, run } from './util.js';
import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HOSTS = { twitch: 'twitch.tv', kick: 'kick.com' };

/**
 * People paste whatever the browser gave them: a full URL, a URL with a
 * trailing slash or /videos, or a bare handle. Store and probe one shape.
 */
export function normalizeSlug(platform, input) {
  let value = String(input ?? '').trim();
  if (!value) return '';

  if (platform === 'youtube') {
    // yt-dlp resolves every YouTube URL shape itself, so keep URLs intact.
    if (/^https?:\/\//i.test(value)) return value.replace(/[?#].*$/, '');
    if (/^@/.test(value) || /^UC[\w-]{20,}$/.test(value)) return value;
    return `@${value}`;
  }

  const host = HOSTS[platform];
  if (!host) return value;

  // https://www.twitch.tv/name/videos?x=1  ->  name
  const url = value.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, '');
  if (url.toLowerCase().startsWith(`${host}/`)) {
    value = url.slice(host.length + 1).split(/[/?#]/)[0];
  } else if (url.toLowerCase() === host) {
    return '';
  }
  return value.replace(/^[@#]/, '').trim().toLowerCase();
}

export const PLATFORMS = {
  twitch: { label: 'Twitch', url: (slug) => `https://www.twitch.tv/${slug}` },
  kick: { label: 'Kick', url: (slug) => `https://kick.com/${slug}` },
  youtube: {
    label: 'YouTube',
    // Accept a full URL, an @handle, a channel id, or a plain handle.
    url: (slug) => {
      if (/^https?:\/\//.test(slug)) return slug;
      if (/^@/.test(slug)) return `https://www.youtube.com/${slug}/live`;
      if (/^UC[\w-]{20,}$/.test(slug)) return `https://www.youtube.com/channel/${slug}/live`;
      return `https://www.youtube.com/@${slug}/live`;
    },
  },
};

export function platformUrl(platform, slug) {
  const p = PLATFORMS[platform];
  if (!p) throw new Error(`Unknown platform "${platform}". Use: ${Object.keys(PLATFORMS).join(', ')}`);
  const clean = normalizeSlug(platform, slug);
  if (!clean) throw new Error(`"${slug}" is not a ${p.label} channel.`);
  return p.url(clean);
}

function ytdlp() {
  const bin = findBin('yt-dlp');
  if (!bin) throw new Error('yt-dlp not found. Run: npm run setup');
  return bin;
}

/** One source of truth for "is this channel live?" across all three sites. */
export async function probe(platform, slug) {
  const url = platformUrl(platform, slug);
  const { stdout } = await run(
    ytdlp(),
    ['--no-warnings', '--skip-download', '--no-playlist', '-J', url],
    { allowFail: true },
  );
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    return { live: false, url, error: 'could not read stream info (offline or age/region blocked)' };
  }
  // yt-dlp prints a bare `null` for a channel that isn't streaming.
  if (!info || typeof info !== 'object') {
    return { live: false, url, error: null };
  }
  return {
    live: info.is_live === true,
    url,
    title: info.title || '',
    description: info.description || '',
    game: info.game || '',
    tags: info.tags || [],
    categories: info.categories || [],
    id: info.id,
    startTime: info.release_timestamp ? info.release_timestamp * 1000 : null,
    viewers: info.concurrent_view_count ?? null,
  };
}

/**
 * Chat adapters append {t, u, m} to an async callback.
 * Return value is a stop() function; all adapters fail soft so clips still render.
 */
export function startChat({ platform, slug, url, onMessage, onError = () => {} }) {
  const clean = normalizeSlug(platform, slug);
  if (platform === 'twitch') return twitchChat(clean, onMessage, onError);
  if (platform === 'kick') return kickChat(clean, onMessage, onError);
  if (platform === 'youtube') return youtubeChat(url, onMessage, onError);
  return () => {};
}

// ---- Twitch: anonymous IRC, no token needed -------------------------------

function twitchChat(slug, onMessage, onError) {
  const startedAt = Date.now();
  let ws;
  let closed = false;
  let retry = 0;

  const connect = () => {
    if (closed) return;
    const sock = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws = sock;
    sock.onopen = () => {
      sock.send('PASS SCHMOOPIIE');
      sock.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}`);
      sock.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      sock.send(`JOIN #${slug.toLowerCase()}`);
      retry = 0;
    };
    sock.onmessage = (event) => {
      for (const line of String(event.data).split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          sock.send('PONG :tmi.twitch.tv');
          continue;
        }
        const match = /PRIVMSG #\S+ :(.*)$/.exec(line);
        if (match) {
          // Lines start with the IRC tags block, so the nick is not at index 0.
          const user = /:([\w]+)!/u.exec(line)?.[1] || '';
          onMessage({ t: Date.now() - startedAt, u: user, m: match[1] });
        }
      }
    };
    sock.onerror = () => onError(new Error('twitch chat socket error'));
    sock.onclose = () => {
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, retry * 2000);
    };
  };

  connect();
  return () => {
    closed = true;
    try { ws?.close(); } catch {}
  };
}

// ---- Kick: public pusher channel -----------------------------------------

async function kickChat(slug, onMessage, onError) {
  const startedAt = Date.now();
  let ws;
  let closed = false;

  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`kick api ${res.status}`);
    const channel = await res.json();
    const chatroomId = channel.chatroom?.id;
    if (!chatroomId) throw new Error('kick chatroom id missing');

    ws = new WebSocket(
      'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=9.0.0&flash=false',
    );
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.event === 'pusher:connection_established') {
        ws.send(JSON.stringify({
          event: 'pusher:subscribe',
          data: { auth: '', channel: `chatrooms.${chatroomId}.v2` },
        }));
        return;
      }
      if (msg.event !== 'App\\Events\\ChatMessageEvent') return;
      try {
        const payload = JSON.parse(msg.data);
        onMessage({ t: Date.now() - startedAt, u: payload.sender?.username || '', m: payload.content || '' });
      } catch {}
    };
    ws.onerror = () => onError(new Error('kick chat socket error'));
  } catch (err) {
    onError(err);
  }

  return () => {
    closed = true;
    try { ws?.close(); } catch {}
  };
}

// ---- YouTube: let yt-dlp write live_chat, tail the file -------------------

function youtubeChat(url, onMessage, onError) {
  let closed = false;
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ytchat-'));
  const outBase = path.join(dir, 'chat');
  const startedAt = Date.now();
  let child;
  let offset = 0;
  let partial = '';

  try {
    child = spawnStream(ytdlp(), [
      '--no-warnings', '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
      '-o', outBase, url,
    ]);
  } catch (err) {
    onError(err);
    return () => {};
  }
  child.on('error', onError);
  child.stderr.on('data', () => {});

  const extractText = (renderer) =>
    (renderer?.message?.runs || []).map((r) => r.text).join('') ||
    renderer?.message?.simpleText || '';

  const handleLine = (line) => {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) return;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return; }
    const item =
      obj.replayChatItemAction?.actions?.find((a) => a.addChatItemAction)?.addChatItemAction?.item ||
      obj.addChatItemAction?.item ||
      obj;
    const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!renderer) return;
    const text = extractText(renderer);
    if (!text) return;
    const ms = Number(obj.videoOffsetTimeMsec ?? obj.replayChatItemAction?.videoOffsetTimeMsec);
    onMessage({
      t: Number.isFinite(ms) && ms > 0 ? ms : Date.now() - startedAt,
      u: renderer.authorName?.simpleText || '',
      m: text,
    });
  };

  let activeFile = null;
  const tail = () => {
    if (closed) return;
    const candidates = [
      `${outBase}.live_chat.json`,
      `${outBase}.live_chat.json.part`,
      path.join(dir, 'chat.live_chat.json'),
      path.join(dir, 'chat.live_chat.json.part'),
    ];
    let file = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        file = c;
        break;
      }
    }
    if (!file) return;
    if (activeFile && activeFile !== file && !file.endsWith('.part')) {
      if (!fs.existsSync(activeFile)) {
        activeFile = file;
      }
    } else {
      activeFile = file;
    }
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    fs.closeSync(fd);
    offset = size;
    partial += buffer.toString('utf8');
    const lines = partial.split('\n');
    partial = lines.pop() || '';
    for (const line of lines) handleLine(line);
  };

  const timer = setInterval(tail, 3000);

  return () => {
    closed = true;
    clearInterval(timer);
    try { child?.kill('SIGTERM'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  };
}

/**
 * Chat replay for finished videos. Returns [{t (seconds), u, m}].
 * YouTube chat is handled in vod.js via yt-dlp's live_chat file.
 */
export async function fetchVodChat(platform, url, info) {
  const messages = [];
  if (platform === 'twitch' && info?.id) {
    try {
      const body = {
        operationName: 'VideoCommentsByOffsetOrCursor',
        variables: { videoID: String(info.id) },
        query:
          'query VideoCommentsByOffsetOrCursor($videoID: ID!) { video(id: $videoID) { comments(first: 100) { edges { node { id createdAt contentOffsetSeconds commenter { displayName } } } } } }',
      };
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'client-id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      for (const edge of json?.data?.video?.comments?.edges || []) {
        const n = edge.node;
        messages.push({ t: n.contentOffsetSeconds, u: n.commenter?.displayName || '', m: n.content || '' });
      }
    } catch {
      // audio-only detection still works
    }
  }
  return messages;
}

export function parseChatFile(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const item =
      obj.replayChatItemAction?.actions?.find((a) => a.addChatItemAction)?.addChatItemAction?.item ||
      obj.addChatItemAction?.item ||
      obj;
    const renderer = item.liveChatTextMessageRenderer || item.liveChatPaidMessageRenderer;
    if (!renderer) continue;
    const text2 = (renderer.message?.runs || []).map((r) => r.text).join('');
    const ms = Number(obj.replayChatItemAction?.videoOffsetTimeMsec ?? obj.videoOffsetTimeMsec);
    if (!text2 || !Number.isFinite(ms)) continue;
    out.push({ t: ms / 1000, u: renderer.authorName?.simpleText || '', m: text2 });
  }
  return out;
}
