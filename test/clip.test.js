import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToSpeech, sourceOffset, keepSegments, remapWords } from '../src/render.js';
import { insetFromFaces } from '../src/vision.js';
import { makeHook } from '../src/hook.js';

const word = (text, start, end) => ({ text, start, end });

test('trims silent head and tail, rebasing words', () => {
  const transcript = { words: [word('hello', 2.0, 2.4), word('world', 2.4, 3.0)] };
  const out = snapToSpeech({
    paddedStart: 10, paddedEnd: 40, transcript, minLength: 1, maxLength: 45,
  });
  assert.ok(Math.abs(out.start - 11.8) < 0.01, `start ${out.start}`);
  assert.ok(Math.abs(out.end - 13.45) < 0.01, `end ${out.end}`);
  assert.ok(Math.abs(out.words[0].start - 0.2) < 0.001);
});

test('keeps the window when there is no speech', () => {
  const out = snapToSpeech({ paddedStart: 10, paddedEnd: 30, transcript: { words: [] }, minLength: 15, maxLength: 45 });
  assert.equal(out.start, 10);
  assert.equal(out.end, 30);
});

test('never exceeds the max length', () => {
  const words = Array.from({ length: 40 }, (_, i) => word('w', i * 0.5, i * 0.5 + 0.4));
  const out = snapToSpeech({ paddedStart: 0, paddedEnd: 60, transcript: { words }, minLength: 18, maxLength: 30 });
  assert.ok(out.end - out.start <= 30.001);
});

test('detects a stable corner webcam and rejects a centred face', () => {
  const frames = Array.from({ length: 8 }, () => [[0.78, 0.2, 0.08, 0.1]]);
  const inset = insetFromFaces(frames);
  assert.ok(inset, 'expected an inset');
  assert.equal(inset.corner, 'top-right');
  assert.ok(inset.x + inset.w <= 1.001);

  const centred = Array.from({ length: 8 }, () => [[0.45, 0.4, 0.1, 0.12]]);
  assert.equal(insetFromFaces(centred), null);
});

test('rejects a wandering face (game character, not a webcam)', () => {
  const frames = Array.from({ length: 8 }, (_, i) => [[0.1 + i * 0.05, 0.7, 0.06, 0.08]]);
  assert.equal(insetFromFaces(frames), null);
});

test('hook picks the hyped sentence and stays short', () => {
  const hook = makeHook('So anyway I walked in. NO WAY, did you see that clutch?! It was fine.');
  assert.match(hook, /NO WAY/i);
  assert.ok(hook.length <= 61);
});

test('keepSegments splits on long silence and drops tiny gaps', () => {
  const words = [
    word('hello', 0, 0.4), word('world', 0.4, 0.8),
    word('again', 2.0, 2.4), word('here', 2.4, 2.8),
  ];
  const segs = keepSegments(words, { gap: 0.5, minSegment: 0.1 });
  assert.equal(segs.length, 2);
  assert.ok(Math.abs(segs[0].start - 0) < 1e-9);
  assert.ok(Math.abs(segs[1].start - 2.0) < 1e-9);
});

test('keepSegments returns null when nothing is removed', () => {
  const words = [word('a', 0, 0.4), word('b', 0.5, 0.9)];
  assert.equal(keepSegments(words, { gap: 0.5 }), null);
});

test('remapWords rebases onto the stitched timeline', () => {
  const words = [word('a', 0, 0.4), word('b', 2.0, 2.4)];
  const segs = [{ start: 0, end: 0.4 }, { start: 2.0, end: 2.4 }];
  const out = remapWords(words, segs);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].start - 0) < 1e-9);
  assert.ok(Math.abs(out[1].start - 0.4) < 1e-9);
});
