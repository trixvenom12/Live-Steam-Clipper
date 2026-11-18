import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, CLIPS, DATA, readJson, ensureDir } from './util.js';
import { youtubeAuthUrl, youtubeCallback, youtubeConnected, uploadYoutubeClip } from './youtube.js';

const PUBLIC = path.join(ROOT, 'public');
const TOKEN_FILE = path.join(DATA, 'ui-token');
const MAX_VIDEO_BYTES = 20 * 1024 ** 3;
const MIN_FREE_BYTES = 1024 ** 3;
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);

const MIME = {
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function accessToken() {
  ensureDir(DATA);
  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  const token = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]),
  );
}

function sameSecret(a = '', b = '') {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendFile(req, res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end('not found');
  }
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    let start = match?.[1] ? Number(match[1]) : 0;
    let end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, {
      'content-type': type,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'cache-control': 'public, max-age=600',
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function receiveVideoUpload(req, file) {
  const stats = fs.statfsSync(DATA);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const limit = Math.min(MAX_VIDEO_BYTES, freeBytes - MIN_FREE_BYTES);
  const declared = Number(req.headers['content-length']);
  if (limit <= 0 || (Number.isFinite(declared) && declared > limit)) {
    const error = new Error('Not enough free disk space for this video (1 GB is reserved).');
    error.statusCode = 413;
    throw error;
  }

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit) {
        const error = new Error('Video exceeds the upload limit or available disk space.');
        error.statusCode = 413;
        callback(error);
      } else callback(null, chunk);
    },
  });
  await pipeline(req, limiter, fs.createWriteStream(file, { flags: 'wx' }));
  if (!bytes) throw new Error('The selected video is empty.');
  return bytes;
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function lanUrl(port) {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

export function createServer(control, { open = false, port = 4321 } = {}) {
  const token = open ? null : accessToken();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    try {
      // Phone gets one link from the terminal; the cookie keeps it signed in.
      if (token && !isLoopback(req)) {
        const cookie = parseCookies(req.headers.cookie).k;
        const queryKey = url.searchParams.get('k');
        if (sameSecret(cookie, token) || sameSecret(queryKey, token)) {
          if (queryKey) {
            res.setHeader('set-cookie', `k=${token}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
            url.searchParams.delete('k');
            res.writeHead(302, { location: `${pathname}${url.search || ''}` });
            return res.end();
          }
        } else {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="background:#0F0F23;color:#E2E8F0;font:16px/1.5 system-ui;padding:40px 24px;max-width:520px;margin:0 auto">
<h1 style="font-size:20px">Dashboard locked</h1>
<p>Open the link printed in the terminal — it ends with <code style="color:#F43F5E">?k=…</code>.
That signs this phone in for a year.</p></body>`);
        }
      }

      if (pathname === '/api/youtube/callback' && req.method === 'GET') {
        try {
          await youtubeCallback(Object.fromEntries(url.searchParams), port);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube connected</title><body style="font:16px system-ui;max-width:520px;margin:12vh auto;padding:24px;color:#26332B"><h1>YouTube connected</h1><p>You can close this page and return to GTA Clipper.</p></body>');
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end(err.message);
        }
      }
      if (pathname === '/api/youtube/auth' && req.method === 'GET') {
        return sendJson(res, { url: youtubeAuthUrl(port) });
      }
      if (pathname === '/api/youtube/status' && req.method === 'GET') {
        return sendJson(res, { connected: youtubeConnected() });
      }

      if (pathname === '/api/vod/file' && req.method === 'POST') {
        const name = path.basename(String(url.searchParams.get('name') || '').replace(/\\/g, '/'));
        const extension = path.extname(name).toLowerCase();
        if (!name || !VIDEO_EXTENSIONS.has(extension)) {
          return sendJson(res, { error: 'Choose an MP4, MOV, M4V, MKV, WebM, or AVI video.' }, 400);
        }
        const id = `local-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
        const dir = ensureDir(path.join(DATA, 'vod', id));
        const file = path.join(dir, `source${extension}`);
        try {
          const bytes = await receiveVideoUpload(req, file);
          const result = control.queueLocalVideo(file, name, Number(url.searchParams.get('top')) || 8);
          return sendJson(res, { ...result, bytes }, 202);
        } catch (err) {
          fs.rmSync(dir, { recursive: true, force: true });
          return sendJson(res, { error: err.message || 'Video upload failed.' }, err.statusCode || 400);
        }
      }

      if (pathname === '/api/state' && req.method === 'GET') {
        return sendJson(res, control.state());
      }

      if (pathname.startsWith('/api/') && req.method === 'POST') {
        if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) {
          return sendJson(res, { error: 'expected application/json' }, 415);
        }
        const body = await readBody(req);

        const ytUpload = /^\/api\/clips\/([\w.-]+)\/youtube$/.exec(pathname);
        if (ytUpload) return sendJson(res, await uploadYoutubeClip(ytUpload[1], body));
        if (pathname === '/api/channels') {
          return sendJson(res, { channels: control.addChannel(body.platform, body.slug) });
        }
        if (pathname === '/api/channels/remove') {
          return sendJson(res, { channels: control.removeChannel(body.platform, body.slug) });
        }
        if (pathname === '/api/settings') {
          return sendJson(res, { settings: control.updateSettings(body.patch || {}) });
        }
        if (pathname === '/api/watch') {
          const on = body.on === true;
          if (on) control.startWatch();
          else await control.stopWatch();
          return sendJson(res, { watching: control.monitor.running });
        }
        if (pathname === '/api/vod') {
          return sendJson(res, await control.queueVod(body.url, body.top));
        }
        const trim = /^\/api\/clips\/([\w.-]+)\/trim$/.exec(pathname);
        if (trim) return sendJson(res, await control.trimClip(trim[1], body.start, body.end));
        const undo = /^\/api\/clips\/([\w.-]+)\/undo$/.exec(pathname);
        if (undo) return sendJson(res, await control.undoClipTrim(undo[1]));
        const recut = /^\/api\/clips\/([\w.-]+)\/recut$/.exec(pathname);
        if (recut) return sendJson(res, await control.recutClip(recut[1], body.start, body.end));
        const stop = /^\/api\/sessions\/([\w.-]+)\/stop$/.exec(pathname);
        if (stop) return sendJson(res, { stopped: await control.stopSession(stop[1]) });

        const perf = /^\/api\/clips\/([\w.-]+)\/performance$/.exec(pathname);
        if (perf) return sendJson(res, { clip: control.recordPerformance(perf[1], body) });

        const del = /^\/api\/clips\/([\w.-]+)\/delete$/.exec(pathname);
        if (del) return sendJson(res, { ok: control.deleteClip(del[1]) });

        return sendJson(res, { error: 'unknown endpoint' }, 404);
      }

      const clipFile = /^\/clips\/([\w.-]+)$/.exec(pathname);
      if (clipFile) return sendFile(req, res, path.join(CLIPS, path.basename(clipFile[1])));

      if (pathname === '/') return sendFile(req, res, path.join(PUBLIC, 'index.html'));
      if (pathname === '/manifest.webmanifest') {
        return sendFile(req, res, path.join(PUBLIC, 'manifest.webmanifest'));
      }
      if (pathname === '/icon.svg') return sendFile(req, res, path.join(PUBLIC, 'icon.svg'));

      return sendFile(req, res, path.join(PUBLIC, path.basename(pathname)));
    } catch (err) {
      const message = String(err.message || err);
      if (message === 'invalid JSON' || message === 'body too large') {
        return sendJson(res, { error: message }, 400);
      }
      return sendJson(res, { error: message }, 400);
    }
  });
}

export function startUi(port, control, opts = {}) {
  const server = createServer(control, { ...opts, port });
  const host = opts.host || '0.0.0.0';

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`✗ dashboard: port ${port} is busy — try --port ${port + 1}`);
    } else {
      console.error(`✗ dashboard: ${err.message}`);
    }
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    console.log(`dashboard  http://localhost:${port}`);
    if (host === '0.0.0.0') {
      const token = opts.open ? '' : `?k=${fs.readFileSync(TOKEN_FILE, 'utf8').trim()}`;
      console.log(`phone      ${lanUrl(port)}/${token}`);
    }
  });
  return server;
}

export function clipMeta(id) {
  return readJson(path.join(CLIPS, `${path.basename(id)}.json`), null);
}
