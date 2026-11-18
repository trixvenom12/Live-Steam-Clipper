import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupWords, buildAss, assTime } from '../src/captions.js';
import { isHallucination, parseWhisperJson } from '../src/transcribe.js';

const word = (text, start, end) => ({ text, start, end });

test('groups words into short caption lines', () => {
  const words = [
    word('this', 0, 0.3), word('is', 0.3, 0.5), word('insane', 0.5, 0.9),
    word('chat', 0.9, 1.2), word('look', 1.2, 1.5), word('at', 1.5, 1.6),
  ];
  const groups = groupWords(words, { wordsPerLine: 3 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length, 3);
});

test('breaks a group on a long pause', () => {
  const groups = groupWords([word('hello', 0, 0.4), word('again', 3, 3.4)], {});
  assert.equal(groups.length, 2);
});

test('ass timestamps are centisecond accurate', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(62.345), '0:01:02.34');
  assert.equal(assTime(3725.5), '1:02:05.50');
});

test('builds one highlight event per word and escapes braces', () => {
  const ass = buildAss(
    [word('what', 0, 0.3), word('{hack}', 0.3, 0.8)],
    { highlight: '&H0033D6FF', uppercase: true, wordsPerLine: 3 },
    3,
  );
  assert.match(ass, /^\[Script Info\]/);
  assert.match(ass, /Style: Cap,Arial Black/);
  assert.match(ass, /\\c&H0033D6FF&/);
  assert.match(ass, /WHAT/);
  assert.match(ass, /\\\{HACK\\\}/);
  const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
  assert.equal(events.length, 2);
});

test('builds header banner and attribution events when specified', () => {
  const ass = buildAss(
    [word('crazy', 0, 0.4)],
    { header: 'Wait for it...', attribution: '@xqc (Twitch)' },
    2,
  );
  assert.match(ass, /Style: Header/);
  assert.match(ass, /Style: Credit/);
  assert.match(ass, /WAIT FOR IT\.\.\./);
  assert.match(ass, /🔴 Stream: @xqc \(Twitch\)/);
});

test('detects whisper repetition hallucination loops', () => {
  const loop = [
    word('thank', 0, 0.3), word('you', 0.3, 0.6),
    word('thank', 0.6, 0.9), word('you', 0.9, 1.2),
    word('thank', 1.2, 1.5), word('you', 1.5, 1.8),
    word('thank', 1.8, 2.1), word('you', 2.1, 2.4),
  ];
  assert.equal(isHallucination(loop), true);

  const realSpeech = [
    word('oh', 0, 0.3), word('my', 0.3, 0.5), word('god', 0.5, 0.8),
    word('did', 0.8, 1.0), word('you', 1.0, 1.2), word('see', 1.2, 1.4),
    word('that', 1.4, 1.7), word('car', 1.7, 2.0), word('flip', 2.0, 2.3),
  ];
  assert.equal(isHallucination(realSpeech), false);
});
