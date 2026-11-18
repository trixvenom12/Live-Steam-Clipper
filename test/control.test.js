import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '../src/config.js';
import { applySettings, settingsSnapshot, SETTINGS } from '../src/control.js';

const fresh = () => structuredClone(DEFAULTS);

test('clamps a setting above its maximum', () => {
  const config = fresh();
  applySettings(config, { 'detect.minScore': 99 });
  assert.equal(config.detect.minScore, SETTINGS['detect.minScore'].max);
});

test('clamps below the minimum and rounds whole-number steps', () => {
  const config = fresh();
  applySettings(config, { 'clip.lengthSeconds': 2.4 });
  assert.equal(config.clip.lengthSeconds, SETTINGS['clip.lengthSeconds'].min);

  applySettings(config, { 'clip.lengthSeconds': 24.6 });
  assert.equal(config.clip.lengthSeconds, 25);
});

test('keeps fractional precision for sub-unit steps', () => {
  const config = fresh();
  applySettings(config, { 'detect.minScore': 2.34 });
  assert.equal(config.detect.minScore, 2.34);
});

test('ignores unknown keys and non-numeric values', () => {
  const config = fresh();
  const before = structuredClone(config);
  const changed = applySettings(config, { 'nope.key': 1, 'clip.lengthSeconds': 'abc' });
  assert.deepEqual(changed, []);
  assert.deepEqual(config, before);
});

test('accepts only known layouts', () => {
  const config = fresh();
  assert.deepEqual(applySettings(config, { 'clip.layout': 'crop' }), ['clip.layout']);
  assert.equal(config.clip.layout, 'crop');

  assert.deepEqual(applySettings(config, { 'clip.layout': 'diagonal' }), []);
  assert.equal(config.clip.layout, 'crop');
});

test('coerces the uppercase toggle from common values', () => {
  const config = fresh();
  applySettings(config, { 'captions.uppercase': false });
  assert.equal(config.captions.uppercase, false);

  applySettings(config, { 'captions.uppercase': 'false' });
  assert.equal(config.captions.uppercase, false);

  applySettings(config, { 'captions.uppercase': 'on' });
  assert.equal(config.captions.uppercase, true);
});

test('snapshot exposes every editable key plus layout and uppercase', () => {
  const config = fresh();
  const snapshot = settingsSnapshot(config);
  for (const key of Object.keys(SETTINGS)) {
    assert.ok(key in snapshot, `missing ${key}`);
  }
  assert.equal(snapshot['clip.layout'], config.clip.layout);
  assert.equal(snapshot['captions.uppercase'], config.captions.uppercase);
});
