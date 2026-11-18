import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPeaks, buildChatTimeline, normalizeMomentAnalysis, scoreTranscript } from '../src/analyze.js';

function chatBurst(from, to, rate) {
  const times = [];
  for (let t = from; t < to; t += 1 / rate) times.push(t);
  return times;
}

function flatChat(duration, rate) {
  return chatBurst(0, duration, rate);
}

function flatLoudness(duration, db = -40) {
  return Array.from({ length: duration }, (_, t) => ({ t, db }));
}

test('chat timeline buckets by second', () => {
  const counts = buildChatTimeline([0.1, 0.9, 1.2, 2.9], 4);
  assert.deepEqual([...counts], [2, 1, 1, 0]);
});

test('normalizes model timestamps and computes a conservative local transcript score', () => {
  const words = Array.from({ length: 10 }, (_, i) => ({ text: i ? 'because' : 'I', start: i, end: i + 0.4 }));
  assert.equal(scoreTranscript(words).zeroContextScore, 7);
  assert.deepEqual(normalizeMomentAnalysis({ setup_start: 1, climax_start: 7, climax_end: 9, hard_cut_end: 10 }, { words }), {
    setup_start: 1, climax_start: 7, climax_end: 9, hard_cut_end: 10, zeroContextScore: null, source: 'model',
  });
});

test('finds a chat spike and ignores a flat stream', () => {
  const duration = 300;
  const chat = [...flatChat(duration, 0.1), ...chatBurst(60, 66, 15)];
  const loudness = flatLoudness(duration);
  for (const s of loudness.slice(60, 66)) s.db = -12;

  const peaks = findPeaks({ chatTimes: chat, loudness, duration, detect: { minMessages: 20 } });
  assert.equal(peaks.length, 1);
  assert.ok(peaks[0].at >= 55 && peaks[0].at <= 70, `peak at ${peaks[0].at}`);
  assert.ok(peaks[0].score > 2);
});

test('no peaks on a quiet uniform stream', () => {
  const duration = 300;
  const peaks = findPeaks({
    chatTimes: flatChat(duration, 0.1),
    loudness: flatLoudness(duration),
    duration,
    detect: { minMessages: 5 },
  });
  assert.equal(peaks.length, 0);
});

test('respects the minimum gap between clips', () => {
  const duration = 900;
  const chat = [...flatChat(duration, 0.1), ...chatBurst(120, 126, 20), ...chatBurst(140, 146, 20)];
  const peaks = findPeaks({
    chatTimes: chat,
    loudness: flatLoudness(duration),
    duration,
    detect: { minMessages: 20, minGapSeconds: 75 },
  });
  assert.ok(peaks.length <= 2);
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i].at - peaks[i - 1].at >= 75);
  }
});

test('audio alone can nominate a moment when chat is missing', () => {
  const duration = 240;
  const loudness = flatLoudness(duration);
  for (const s of loudness.slice(100, 110)) s.db = -8;
  const peaks = findPeaks({
    chatTimes: [],
    loudness,
    duration,
    detect: { minMessages: 0, minScore: 1.5 },
  });
  assert.equal(peaks.length, 1);
  assert.ok(Math.abs(peaks[0].at - 105) <= 12);
});

test('motion and scene changes can nominate a moment without chat', () => {
  const duration = 240;
  const visualActivity = Array.from({ length: duration }, (_, t) => ({ t, motion: t >= 100 && t < 110 ? 30 : 0, scene: t === 105 ? 60 : 0 }));
  const peaks = findPeaks({
    chatTimes: [],
    loudness: flatLoudness(duration),
    visualActivity,
    duration,
    detect: { minMessages: 0, minScore: 1.5 },
  });
  assert.equal(peaks.length, 1);
  assert.ok(Math.abs(peaks[0].at - 105) <= 12);
});

test('a modest spike on a quiet channel still clips with default settings', () => {
  // Regression: the score used to be smoothed over 9s on top of an already
  // averaged chat rate, flattening real spikes below the default threshold.
  const duration = 600;
  const chat = [...flatChat(duration, 0.9), ...chatBurst(300, 312, 3.2)];
  const peaks = findPeaks({ chatTimes: chat, loudness: flatLoudness(duration), duration, detect: {} });
  assert.ok(peaks.length >= 1, 'expected a clip from a 3.5x chat spike');
  assert.ok(peaks[0].at >= 290 && peaks[0].at <= 320, `peak at ${peaks[0].at}`);
});
