import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, findBin, ffmpegBin, ROOT, ensureDir } from './util.js';

/**
 * Webcam-inset detection for screen recordings (the OBS / stream VOD case).
 * Samples a few frames, asks macOS Vision where the faces are, and treats a
 * small, stable, corner-anchored face as a webcam overlay.
 */

const SAMPLE_FPS = 0.25;
const MAX_FRAMES = 12;

let cachedBin;

/** Compile the Vision helper once, next to the other vendored binaries. */
async function buildOnce() {
  if (cachedBin !== undefined) return cachedBin;
  const existing = findBin('face-scan');
  if (existing) return (cachedBin = existing);
  const script = path.join(ROOT, 'scripts/face-scan.swift');
  if (!fs.existsSync(script)) return (cachedBin = null);
  const out = path.join(ensureDir(path.join(ROOT, '.tools/bin')), 'face-scan');
  const { code } = await run('swiftc', ['-O', script, '-o', out], { allowFail: true });
  cachedBin = code === 0 ? out : null;
  return cachedBin;
}

export async function scanFaces(inputArgs, duration) {
  const bin = await buildOnce();
  if (!bin) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faces-'));
  try {
    const frames = Math.max(3, Math.min(MAX_FRAMES, Math.round(duration * SAMPLE_FPS)));
    await run(ffmpegBin(), [
      '-y', '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-vf', `fps=${frames / Math.max(1, duration)},scale=640:-2`,
      '-frames:v', String(frames),
      path.join(dir, '%03d.jpg'),
    ], { allowFail: true });
    const images = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort()
      .map((f) => path.join(dir, f));
    if (!images.length) return null;
    const { stdout } = await run(bin, images, { allowFail: true });
    const results = [];
    for (const line of stdout.split('\n')) {
      const [file, boxes] = line.split('\t');
      if (!file || !boxes?.trim()) continue;
      results.push(boxes.split(';').map((b) => b.split(',').map(Number)));
    }
    return results;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

/**
 * @returns {{x:number,y:number,w:number,h:number,corner:string}|null} normalized inset rect
 */
export function insetFromFaces(frames) {
  const boxes = frames.flat();
  if (!boxes.length) return null;

  const centersX = boxes.map((b) => b[0] + b[2] / 2);
  const centersY = boxes.map((b) => b[1] + b[3] / 2);
  const cx = median(centersX);
  const cy = median(centersY);

  // A webcam is pinned in place; a game character wanders.
  const stable = boxes.filter((b) => {
    const x = b[0] + b[2] / 2;
    const y = b[1] + b[3] / 2;
    return Math.abs(x - cx) < 0.06 && Math.abs(y - cy) < 0.06;
  }).length / boxes.length;
  if (stable < 0.6) return null;

  const faceW = median(boxes.map((b) => b[2]));
  const faceH = median(boxes.map((b) => b[3]));
  if (faceW < 0.025 || faceW > 0.2) return null;

  // Must sit near an edge: a centred face is the shot itself, not an overlay.
  const nearX = cx < 0.34 || cx > 0.66;
  const nearY = cy < 0.34 || cy > 0.66;
  if (!nearX && !nearY) return null;

  // A webcam frames head and shoulders: roughly 3 face-widths by 3 face-heights.
  const right = cx > 0.5;
  const bottom = cy > 0.5;
  const w = Math.min(0.46, Math.max(0.16, faceW * 3.2));
  const h = Math.min(0.52, Math.max(0.14, faceH * 3.0));
  const x = right ? 1 - w : 0;
  const y = bottom ? 1 - h : 0;

  const inside = cx > x + 0.01 && cx < x + w - 0.01 && cy > y + 0.01 && cy < y + h - 0.01;
  if (!inside) return null;

  return {
    x: Number(x.toFixed(4)),
    y: Number(y.toFixed(4)),
    w: Number(w.toFixed(4)),
    h: Number(h.toFixed(4)),
    corner: `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}`,
  };
}

export async function detectInset(inputArgs, duration) {
  if (process.platform !== 'darwin') return null;
  const frames = await scanFaces(inputArgs, duration);
  if (!frames) return null;
  return insetFromFaces(frames);
}

/** Median face centre (normalized) across sampled frames, for face-centred cropping. */
export async function detectFaceCenter(inputArgs, duration) {
  if (process.platform !== 'darwin') return null;
  const frames = await scanFaces(inputArgs, duration);
  if (!frames) return null;
  const boxes = frames.flat();
  if (!boxes.length) return null;
  const xs = boxes.map((b) => b[0] + b[2] / 2);
  const ys = boxes.map((b) => b[1] + b[3] / 2);
  const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
  return { cx: Number(cx.toFixed(4)), cy: Number(cy.toFixed(4)) };
}
