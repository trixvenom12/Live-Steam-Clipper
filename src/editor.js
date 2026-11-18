import fs from 'node:fs';
import path from 'node:path';
import { CLIPS, ffmpegBin, assertMedia, readJson, writeJson, run } from './util.js';

export function assembleTimeline(ranges, words = [], { silenceGap = 0.35 } = {}) {
  const timeline = [];
  for (const range of ranges || []) {
    const inside = words.filter((w) => w.start >= range.start && w.start < range.end);
    let cursor = range.start;
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end;
      if (gap > silenceGap) {
        const cut = Math.min(0.06, gap / 2);
        if (inside[i - 1].end - cursor > 0.05) timeline.push({ start: cursor, end: inside[i - 1].end + cut, role: range.role });
        cursor = Math.max(cursor, inside[i].start - cut);
      }
    }
    if (range.end - cursor > 0.05) timeline.push({ start: cursor, end: range.end, role: range.role });
  }
  return timeline;
}

function clipFiles(id) {
  const safeId = path.basename(String(id));
  if (!safeId || safeId !== id) throw new Error('Invalid clip id.');
  const metaFile = path.join(CLIPS, `${safeId}.json`);
  const clip = readJson(metaFile, null);
  if (!clip?.file) throw new Error('Clip not found.');
  const video = path.join(CLIPS, path.basename(clip.file));
  assertMedia(video);
  return { clip, metaFile, video, backup: path.join(CLIPS, `${safeId}.original.mp4`) };
}

async function makeThumbnail(file, clip) {
  if (!clip.thumb) return;
  await run(ffmpegBin(), [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', file,
    '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', path.join(CLIPS, path.basename(clip.thumb)),
  ], { allowFail: true });
}

export async function trimClip(id, start, end) {
  const files = clipFiles(id);
  const from = Number(start);
  const to = Number(end);
  const duration = Number(files.clip.duration);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > duration || to - from < 1.5) {
    throw new Error('Choose a trim range of at least 1.5 seconds inside the clip.');
  }

  const temp = path.join(CLIPS, `${path.basename(files.video, '.mp4')}.edit.mp4`);
  try {
    await run(ffmpegBin(), [
      '-y', '-hide_banner', '-loglevel', 'error', '-ss', String(from), '-i', files.video,
      '-t', String(to - from), '-map', '0:v:0', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temp,
    ]);
    assertMedia(temp);
    if (!fs.existsSync(files.backup)) fs.copyFileSync(files.video, files.backup);
    fs.renameSync(temp, files.video);
    files.clip.originalDuration ??= duration;
    files.clip.duration = Math.round((to - from) * 10) / 10;
    files.clip.canUndo = true;
    files.clip.editedAt = new Date().toISOString();
    writeJson(files.metaFile, files.clip);
    await makeThumbnail(files.video, files.clip);
    return files.clip;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export async function undoClipTrim(id) {
  const files = clipFiles(id);
  if (!fs.existsSync(files.backup) || !Number.isFinite(Number(files.clip.originalDuration))) {
    throw new Error('There is no trim to undo.');
  }
  fs.copyFileSync(files.backup, files.video);
  fs.rmSync(files.backup, { force: true });
  files.clip.duration = Number(files.clip.originalDuration);
  delete files.clip.originalDuration;
  delete files.clip.editedAt;
  delete files.clip.canUndo;
  writeJson(files.metaFile, files.clip);
  await makeThumbnail(files.video, files.clip);
  return files.clip;
}

export function deleteClipBackup(id) {
  const safeId = path.basename(String(id));
  fs.rmSync(path.join(CLIPS, `${safeId}.original.mp4`), { force: true });
}
