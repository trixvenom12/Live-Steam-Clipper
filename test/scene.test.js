import test from 'node:test';
import assert from 'node:assert/strict';
import { snapToNearestSceneCut, isSceneDetectAvailable } from '../src/scene.js';
import { isFasterWhisperAvailable } from '../src/transcribe.js';

test('snapToNearestSceneCut snaps within tolerance and ignores distant cuts', () => {
  const cuts = [4.15, 8.50, 15.20];

  // Within default 0.75s tolerance -> snaps
  assert.equal(snapToNearestSceneCut(4.30, cuts, 0.75), 4.15);
  assert.equal(snapToNearestSceneCut(3.90, cuts, 0.75), 4.15);
  assert.equal(snapToNearestSceneCut(15.40, cuts, 0.75), 15.20);

  // Outside tolerance -> keeps original time
  assert.equal(snapToNearestSceneCut(6.00, cuts, 0.75), 6.00);
  assert.equal(snapToNearestSceneCut(12.00, cuts, 0.75), 12.00);

  // Handles empty or null cuts gracefully
  assert.equal(snapToNearestSceneCut(5.00, []), 5.00);
  assert.equal(snapToNearestSceneCut(5.00, null), 5.00);
});

test('detects availability of PySceneDetect and faster-whisper', () => {
  assert.equal(isSceneDetectAvailable(), true);
  assert.equal(isFasterWhisperAvailable(), true);
});
