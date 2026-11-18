import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSlug, platformUrl } from '../src/platforms.js';

test('normalizes a pasted Twitch URL to the channel handle', () => {
  assert.equal(normalizeSlug('twitch', 'https://www.twitch.tv/shanks_ttv'), 'shanks_ttv');
  assert.equal(normalizeSlug('twitch', 'https://www.twitch.tv/Shanks_TTV/videos?filter=all'), 'shanks_ttv');
  assert.equal(normalizeSlug('twitch', 'twitch.tv/xqc/'), 'xqc');
  assert.equal(normalizeSlug('twitch', '@xqc'), 'xqc');
  assert.equal(normalizeSlug('twitch', '  XQC  '), 'xqc');
});

test('normalizes a pasted Kick URL', () => {
  assert.equal(normalizeSlug('kick', 'https://kick.com/xqc'), 'xqc');
  assert.equal(normalizeSlug('kick', 'kick.com/xQc/chat'), 'xqc');
});

test('keeps YouTube URLs intact and prefixes bare handles', () => {
  assert.equal(
    normalizeSlug('youtube', 'https://www.youtube.com/@SomeChannel/live'),
    'https://www.youtube.com/@SomeChannel/live',
  );
  assert.equal(normalizeSlug('youtube', '@SomeChannel'), '@SomeChannel');
  assert.equal(normalizeSlug('youtube', 'UC1234567890abcdefghij'), 'UC1234567890abcdefghij');
  assert.equal(normalizeSlug('youtube', 'SomeChannel'), '@SomeChannel');
});

test('never doubles the host into the probe URL', () => {
  assert.equal(platformUrl('twitch', 'https://www.twitch.tv/shanks_ttv'), 'https://www.twitch.tv/shanks_ttv');
  assert.equal(platformUrl('kick', 'https://kick.com/xqc'), 'https://kick.com/xqc');
});

test('rejects a URL that has no channel in it', () => {
  assert.equal(normalizeSlug('twitch', 'https://twitch.tv/'), '');
  assert.throws(() => platformUrl('twitch', 'https://twitch.tv/'), /not a Twitch channel/);
});
