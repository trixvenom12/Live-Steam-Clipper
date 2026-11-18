import { ffmpegBin } from './util.js';

const BAND_W = 960;
const BAND_H = 192;
const SAMPLES = 8;
const BRIGHT = 200;
const DARK = 80;
const REACH = 2;
const MIN_TEXT_FRACTION = 0.0012;
const MIN_FRAMES_WITH_TEXT = 0.6;
const MAX_MEDIAN_OVERLAP = 0.5;
const EDGE = 0.15;

function textMask(pixels) {
  const mask = new Set();
  const left = Math.floor(BAND_W * EDGE);
  const right = Math.floor(BAND_W * (1 - EDGE));
  for (let y = 0; y < BAND_H; y++) {
    const rowStart = y * BAND_W;
    for (let x = 0; x < BAND_W; x++) {
      if (x < left || x >= right) continue;
      const v = pixels[rowStart + x];
      if (v < BRIGHT) continue;
      let minNeighbor = 255;
      const lo = Math.max(0, x - REACH);
      const hi = Math.min(BAND_W, x + REACH + 1);
      for (let nx = lo; nx < hi; nx++) {
        const nv = pixels[rowStart + nx];
        if (nv < minNeighbor) minNeighbor = nv;
      }
      if (minNeighbor < DARK) mask.add(y * BAND_W + x);
    }
  }
  return mask;
}

// Spawn-based binary capture (ffmpeg rawvideo).
import { spawn } from 'node:child_process';

function bandBinary(file, t) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBin(), [
      '-v', 'error', '-ss', String(t.toFixed(2)), '-i', file, '-frames:v', '1',
      '-vf', `crop=iw:ih*0.35:0:ih*0.65,scale=${BAND_W}:${BAND_H},format=gray`,
      '-f', 'rawvideo', '-',
    ]);
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code === 0 && buf.length === BAND_W * BAND_H) resolve(buf);
      else resolve(null);
    });
    child.on('error', () => resolve(null));
  });
}

export async function detectBurnedSubtitles(file, duration) {
  if (!duration || duration <= 0) return { hasBurned: false, band: null };
  const start = duration * 0.05;
  const span = duration * 0.9;
  const times = Array.from({ length: SAMPLES }, (_, i) => start + span * (i + 0.5) / SAMPLES);
  const masks = [];
  for (const t of times) {
    const buf = await bandBinary(file, t);
    if (buf) masks.push(textMask(buf));
  }
  if (!masks.length) return { hasBurned: false, band: null };

  const threshold = MIN_TEXT_FRACTION * BAND_W * BAND_H;
  const texty = masks.filter((m) => m.size >= threshold);
  if (texty.length < MIN_FRAMES_WITH_TEXT * masks.length || texty.length < 3) {
    return { hasBurned: false, band: null };
  }
  // median overlap
  const overlaps = [];
  for (let i = 0; i < texty.length - 1; i++) {
    const a = texty[i], b = texty[i + 1];
    const inter = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    overlaps.push(inter / Math.max(1, union));
  }
  overlaps.sort((x, y) => x - y);
  const median = overlaps[Math.floor(overlaps.length / 2)];
  if (median >= MAX_MEDIAN_OVERLAP) return { hasBurned: false, band: null };

  // caption band: rows from glyph pixels of texty frames
  const rows = [];
  for (const m of texty) for (const idx of m) rows.push(Math.floor(idx / BAND_W));
  rows.sort((a, b) => a - b);
  if (!rows.length) return { hasBurned: true, band: null };
  const low = rows[Math.floor(rows.length * 0.03)];
  const high = rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.97))];
  const top = 0.65 + 0.35 * low / BAND_H - 0.02;
  const bottom = 0.65 + 0.35 * (high + 1) / BAND_H + 0.02;
  return { hasBurned: true, band: { top: Math.max(0.6, top), bottom: Math.min(1.0, bottom) } };
}