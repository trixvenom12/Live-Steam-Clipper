import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = path.join(ROOT, 'data');
export const CLIPS = path.join(ROOT, 'clips');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Local vendored binaries first, then PATH. */
export function findBin(name) {
  const candidates = [
    path.join(ROOT, '.tools/bin', name),
    path.join(ROOT, '.tools/src/whisper.cpp/build/bin', name),
    path.join(ROOT, '.tools/src/whisper.cpp', name),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  for (const dir of (process.env.PATH || '').split(':')) {
    const c = path.join(dir, name);
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export function requireBin(name, hint) {
  const bin = findBin(name);
  if (!bin) throw new Error(`Missing "${name}". ${hint || 'Run: npm run setup'}`);
  return bin;
}

/** Resolve a path relative to the project root. */
export function projectPath(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
      opts.onStdout?.(d);
      if (opts.echo) process.stdout.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      opts.onStderr?.(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || opts.allowFail) resolve({ code, stdout, stderr, child });
      else reject(new Error(`${path.basename(cmd)} exited ${code}\n${stderr.slice(-3000)}`));
    });
  });
}

/** Spawn without waiting; returns the child so callers can kill it. */
export function spawnStream(cmd, args, opts = {}) {
  return spawn(cmd, args, {
    cwd: opts.cwd || ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** "12:30" / "1:02:03" / "750" -> seconds */
export function parseTime(value) {
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Bad time: ${value}`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function ffmpegBin() {
  return requireBin('ffmpeg', 'Install ffmpeg (brew install ffmpeg) or put it on PATH.');
}

export async function probeDuration(file) {
  const ffprobe = findBin('ffprobe');
  if (!ffprobe) return 0;
  const { stdout } = await run(ffprobe, [
    '-hide_banner', '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ], { allowFail: true });
  const n = Number(stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Videos/audio only: fail loudly instead of producing silent clips. */
export function assertMedia(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing media: ${file}`);
  const size = fs.statSync(file).size;
  if (size < 1024) throw new Error(`Media is empty or truncated: ${file}`);
}
