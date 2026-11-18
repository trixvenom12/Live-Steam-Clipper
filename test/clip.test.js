import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToSpeech, sourceOffset, keepSegments, remapWords } from '../src/render.js';
import { insetFromFaces } from '../src/vision.js';
import { makeHook, hookDensity } from '../src/hook.js';
import { makeEditPlan } from '../src/hook.js';
import { assembleTimeline } from '../src/editor.js';

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

test('builds a valid climax cold-open and removes long internal silence', () => {
  const plan = makeEditPlan({ setup_start: 0, climax_start: 7, climax_end: 9, hard_cut_end: 10 });
  assert.equal(plan[0].role, 'cold-open');
  const timeline = assembleTimeline([{ start: 0, end: 4, role: 'body' }], [
    word('one', 0, 0.3), word('two', 2, 2.3),
  ]);
  assert.equal(timeline.length, 2);
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

test('keepSegments preserves short 0.7s hype reaction between setup and payoff', () => {
  const words = [
    word('he', 0.1, 0.5), word('cornered', 0.5, 1.2), word('them', 1.2, 2.5),
    word('NO', 4.0, 4.3), word('WAY', 4.3, 4.7),
    word('that', 6.5, 7.0), word('worked', 7.0, 8.5),
  ];
  const segs = keepSegments(words, { gap: 0.65, minSegment: 0.2, pad: 0.08 });
  assert.equal(segs.length, 3);
  assert.ok(segs.some((s) => s.start <= 4.0 && s.end >= 4.7), 'reaction segment must be kept');
});

test('snapToSpeech snaps to sentence start boundary rather than starting mid-sentence', () => {
  const words = [
    word('random', 0.2, 0.6), word('noise.', 0.6, 1.0),
    word('He', 2.0, 2.3), word('just', 2.3, 2.7), word('escaped', 2.7, 3.2), word('them!', 3.2, 3.8),
  ];
  const out = snapToSpeech({
    paddedStart: 10, paddedEnd: 30, transcript: { words }, minLength: 1, maxLength: 30, preRoll: 3.0,
  });
  // Must snap to "He" (start 2.0, offset 1.8 from paddedStart), not "random"
  assert.ok(out.start >= 11.7 && out.start <= 11.9, `start was ${out.start}`);
  assert.equal(out.words[0].text, 'He');
});

test('hookDensity parses numbers, claims, and stories correctly without regex bugs', () => {
  const res = hookDensity('I just won 500 dollars because he showed up');
  assert.ok(res.words > 1, `words count should be > 1, got ${res.words}`);
  assert.equal(res.numbers, 1); // 500
  assert.ok(res.claims >= 1); // because
  assert.ok(res.stories >= 2); // I, he
});
