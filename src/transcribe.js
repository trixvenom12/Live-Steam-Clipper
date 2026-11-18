import fs from 'node:fs/promises';
import { run, findBin, assertMedia, projectPath } from './util.js';

/** Word-level transcript from a media file via whisper.cpp. */
export async function transcribe(file, config) {
  assertMedia(file);
  const bin = findBin('whisper-cli') || findBin('main');
  if (!bin) throw new Error('whisper-cli not found. Run: npm run setup');

  const model = projectPath(config.whisper.model);

  const outBase = file.replace(/\.[^.]+$/, '') + '.whisper';
  await run(bin, [
    '-m', model,
    '-f', file,
    '-l', config.whisper.language || 'en',
    '-t', String(config.whisper.threads || 6),
    '-ojf',
    '-of', outBase,
    '-np',
  ]);

  const json = JSON.parse(await fs.readFile(`${outBase}.json`, 'utf8'));
  return parseWhisperJson(json);
}

export function isHallucination(words) {
  if (!words || words.length < 8) return false;
  const lower = words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const unique = new Set(lower);
  if (unique.size / lower.length < 0.28) return true; // Heavy repetition loop
  for (let n = 2; n <= 4; n++) {
    let streak = 1;
    let maxStreak = 1;
    for (let i = n; i < lower.length; i += n) {
      const prev = lower.slice(i - n, i).join(' ');
      const curr = lower.slice(i, i + n).join(' ');
      if (prev && prev === curr) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 1;
      }
    }
    if (maxStreak >= 4) return true; // Repeated phrase 4+ times consecutively
  }
  return false;
}

/** Merge sub-word tokens into words with start/end offsets in seconds. */
export function parseWhisperJson(json) {
  const words = [];
  let text = '';
  for (const segment of json.transcription || []) {
    for (const token of segment.tokens || []) {
      const raw = token.text ?? '';
      if (!raw || /^\s*\[_|\s*\[BLANK|\s*\[MUSIC|\s*\[APPLAUSE/i.test(raw)) continue;
      const from = (token.offsets?.from ?? 0) / 1000;
      let to = (token.offsets?.to ?? token.offsets?.from ?? 0) / 1000;
      const piece = raw.replace(/\n/g, ' ');
      const startsWord = /^\s/.test(piece) || words.length === 0;
      const clean = piece.trim();
      if (!clean) continue;
      // Clamp single token duration: spoken words are rarely > 1.0s; avoids stretching into silence
      const maxTokenDur = Math.min(1.0, Math.max(0.35, clean.length * 0.12));
      if (to - from > maxTokenDur) {
        to = from + maxTokenDur;
      }
      if (startsWord || !words.length) {
        words.push({ text: clean, start: from, end: to });
      } else {
        const last = words[words.length - 1];
        last.text += clean;
        last.end = Math.max(last.end, to);
      }
      if (!/^\[.*\]$/.test(clean)) {
        text += piece;
      }
    }
  }
  // Drop punctuation-only tokens and bracketed noise tags that whisper emits alone.
  const filtered = words.filter((w) => /[\p{L}\p{N}]/u.test(w.text) && !/^\[.*\]$/.test(w.text));
  if (isHallucination(filtered)) {
    return { text: '', words: [] };
  }
  return { text: text.replace(/\s+/g, ' ').trim(), words: filtered };
}
