import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nextDelay, Scheduler } from '../src/scheduler.js';

const MINUTE = 60_000;

test('zero jitter yields exactly the base interval', () => {
  assert.equal(nextDelay(5 * MINUTE, 0, () => 0.5), 5 * MINUTE);
  assert.equal(nextDelay(5 * MINUTE, 0, () => 0), 5 * MINUTE);
});

test('jitter stays within the configured bounds', () => {
  const interval = 5 * MINUTE;
  const jitter = 30_000;

  assert.equal(nextDelay(interval, jitter, () => 0), interval - jitter);
  assert.equal(nextDelay(interval, jitter, () => 1), interval + jitter);
  assert.equal(nextDelay(interval, jitter, () => 0.5), interval);

  for (let i = 0; i < 500; i += 1) {
    const delay = nextDelay(interval, jitter, Math.random);
    assert.ok(delay >= interval - jitter && delay <= interval + jitter, `delay ${delay} out of bounds`);
  }
});

test('jitter larger than the interval cannot cross the following run', () => {
  const interval = 60_000;
  const jitter = 10 * interval;

  assert.ok(nextDelay(interval, jitter, () => 1) <= 2 * interval);
  assert.ok(nextDelay(interval, jitter, () => 0) > 0);
});

test('a backoff returned by a run stretches the next delay, and never shortens it', () => {
  const scheduler = new Scheduler({
    intervalMs: 5 * MINUTE,
    jitterMs: 30_000,
    random: () => 1,
    onError: () => {},
    run: async () => {},
  });

  assert.equal(scheduler.delayAfter(undefined), 5 * MINUTE + 30_000);
  assert.equal(scheduler.delayAfter({ backoffMs: 20 * MINUTE }), 20 * MINUTE);
  assert.equal(scheduler.delayAfter({ backoffMs: 1_000 }), 5 * MINUTE + 30_000);
});

test('the next run time is exposed while scheduled and cleared on stop', async () => {
  const now = Date.parse('2026-09-17T12:00:00.000Z');
  const scheduler = new Scheduler({
    intervalMs: 5 * MINUTE,
    jitterMs: 0,
    now: () => now,
    onError: () => {},
    run: async () => ({ backoffMs: 10 * MINUTE }),
  });

  await scheduler.start();
  assert.equal(scheduler.nextRunAt, '2026-09-17T12:10:00.000Z');
  scheduler.stop();
  assert.equal(scheduler.nextRunAt, null);
});

test('a due run is skipped while a poll is still in flight', async () => {
  let running = 0;
  let peak = 0;
  let release: (() => void) | null = null;

  const scheduler = new Scheduler({
    intervalMs: 5,
    jitterMs: 0,
    onError: () => {},
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      running -= 1;
    },
  });

  const started = scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(peak, 1, 'two polls must never overlap');

  release?.();
  await started;
  scheduler.stop();
});

test('an error inside a poll is reported without breaking the chain', async () => {
  const errors: unknown[] = [];
  let runs = 0;

  const scheduler = new Scheduler({
    intervalMs: 5,
    jitterMs: 0,
    onError: (error) => errors.push(error),
    run: async () => {
      runs += 1;
      throw new Error('upstream exploded');
    },
  });

  await scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  scheduler.stop();

  assert.ok(runs > 1, 'the chain must keep running after a failure');
  assert.match((errors[0] as Error).message, /upstream exploded/);
});

test('start runs a poll immediately', async () => {
  let runs = 0;
  const scheduler = new Scheduler({
    intervalMs: 10 * MINUTE,
    jitterMs: 0,
    onError: () => {},
    run: async () => {
      runs += 1;
    },
  });

  await scheduler.start();
  scheduler.stop();
  assert.equal(runs, 1);
});
