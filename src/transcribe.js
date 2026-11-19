import fs from 'node:fs/promises';
import exists from 'node:fs';
import path from 'node:path';
import { run, findBin, assertMedia, projectPath, ROOT } from './util.js';

const PYTHON_BIN = path.join(ROOT, '.venv', 'bin', 'python');
const FASTER_WHISPER_SCRIPT = path.join(ROOT, 'scripts', 'transcribe_faster_whisper.py');

/**
 * Check if the faster-whisper environment is installed and available.
 */
export function isFasterWhisperAvailable() {
  return exists.existsSync(PYTHON_BIN) && exists.existsSync(FASTER_WHISPER_SCRIPT);
}

/**
 * Word-level transcript from a media file via faster-whisper (Silero VAD + MPS/CPU).
 */
export async function transcribeFasterWhisper(file, config = {}) {
  assertMedia(file);
  if (!isFasterWhisperAvailable()) {
    throw new Error('faster-whisper environment not found in .venv');
  }

  const modelSize = config?.whisper?.modelSize || 'small.en';
  const { stdout } = await run(PYTHON_BIN, [FASTER_WHISPER_SCRIPT, file, modelSize], { allowFail: true });
  
  // Extract JSON from output
  const jsonMatch = stdout.trim().match(/\{[\s\S]*\}$/);
  if (!jsonMatch) {
    throw new Error('faster-whisper returned non-JSON output');
  }

  const parsed = JSON.parse(jsonMatch[0]);
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const words = Array.isArray(parsed.words) ? parsed.words : [];
  if (isHallucination(words)) {
    return { text: '', words: [] };
  }

  return {
    text: String(parsed.text || '').trim(),
    words,
  };
}

/** Word-level transcript from a media file via whisper.cpp. */
export async function transcribeWhisperCpp(file, config) {
  assertMedia(file);
  const bin = findBin('whisper-cli') || findBin('main');
  if (!bin) throw new Error('whisper-cli not found. Run: npm run setup');

  const model = projectPath(config.whisper.model);

  const outBase = file.replace(/\.[^.]+$/, '') + '.whisper';
  const args = [
    '-m', model,
    '-f', file,
    '-l', config?.whisper?.language || 'en',
    '-t', String(config?.whisper?.threads || 6),
    '-ojf',
    '-of', outBase,
    '-np',
  ];
  if (config?.whisper?.prompt) {
    args.push('--prompt', config.whisper.prompt);
  }
  await run(bin, args);

  const json = JSON.parse(await fs.readFile(`${outBase}.json`, 'utf8'));
  return parseWhisperJson(json);
}

/**
 * Primary transcribe entrypoint: supports faster-whisper or whisper.cpp based on config.
 */
export async function transcribe(file, config = {}) {
  const engine = config?.whisper?.engine || 'whisper.cpp';

  if (engine === 'faster-whisper') {
    try {
      return await transcribeFasterWhisper(file, config);
    } catch (err) {
      console.warn(`  ! faster-whisper failed (${err.message.split('\n')[0]}), falling back to whisper.cpp`);
    }
  }

  return await transcribeWhisperCpp(file, config);
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
