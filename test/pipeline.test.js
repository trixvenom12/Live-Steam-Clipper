import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/pipeline.js';
import { evaluateClipQuality } from '../src/qa.js';

test('concurrent kick callers wait for the same queue drain', async () => {
  const queue = Object.create(Queue.prototype);
  const jobs = [{ status: 'queued' }];
  queue.busy = false;
  queue.currentId = null;
  queue.running = null;
  queue.list = () => jobs;
  queue.process = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    jobs.shift();
  };

  const first = queue.kick();
  const second = queue.kick();
  assert.equal(first, second);
  await second;
  assert.equal(jobs.length, 0);
  assert.equal(queue.busy, false);
});

test('editorial QA rejects low speech ratio, head silence, and weak context', () => {
  const result = evaluateClipQuality({
    duration: 10,
    words: [{ start: 1, end: 2 }, { start: 5, end: 6 }],
    zeroContextScore: 4,
  });
  assert.equal(result.passed, false);
  assert.equal(result.failures.length, 3);
});
