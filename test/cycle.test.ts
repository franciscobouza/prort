import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import type { ChangeReport, StartupReport } from '../src/notify.js';
import { createPollCycle } from '../src/poll.js';
import { TournamentStore } from '../src/store.js';
import { RateLimitState } from '../src/upstream.js';
import { fakeUpstream } from './fake-upstream.js';
import { fixture } from './fixtures.js';

const MINUTE = 60_000;
const silent = { info: () => {}, warn: () => {} };
const config = loadConfig({ UPSTREAM_BASE_URL: 'http://upstream.test' });
type Json = Record<string, any>;

/** A result posted upstream: Jornada 2's Babacar FC 1-9 Universidad ORT Uruguay corrected to 1-10. */
const correctedFixture = () => {
  const payload = structuredClone(fixture('games')) as Json;
  payload.data.find((game: Json) => game.id === 30258).visiting_team_result = 10;
  return payload;
};

function cycleHarness(store = new TournamentStore(549), startedAt = Date.parse('2026-09-17T12:00:00.000Z')) {
  const upstream = fakeUpstream();
  const startups: StartupReport[] = [];
  const reports: ChangeReport[] = [];
  const invalidated: number[] = [];
  const saves: string[] = [];
  let clock = startedAt;

  const run = createPollCycle({
    config,
    store,
    fetchJson: upstream.fetchJson,
    rateLimit: new RateLimitState(),
    log: silent,
    startedAt,
    gapMs: 0,
    now: () => clock,
    notifier: {
      notifyStartup: async (report) => {
        startups.push(report);
      },
      notifyChanges: async (report) => {
        if (report.results.length > 0 || report.standings.length > 0) reports.push(report);
      },
    },
    details: { invalidate: (gameId) => invalidated.push(gameId) },
    snapshotPath: '/unused/snapshot.json',
    save: async (saved) => {
      saves.push(saved.feed('fixture').fetchedAt ?? 'none');
    },
  });

  return {
    run,
    store,
    upstream,
    startups,
    reports,
    invalidated,
    saves,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('a cold start sends exactly one startup message and no change message', async () => {
  const h = cycleHarness();
  await h.run();
  h.advance(5 * MINUTE);
  await h.run();

  assert.equal(h.startups.length, 1);
  assert.equal(h.startups[0]!.tournamentName, 'Serie 4 / Divisional B / Clausura 2026');
  assert.equal(h.startups[0]!.groups?.[0]?.rows.length, 15);
  assert.equal(h.reports.length, 0, 'no full-table diff on a cold start');
  assert.equal(h.saves.length, 2, 'the baseline is saved after every successful poll');
});

test('a later change is reported, the startup message is not repeated, and a correction invalidates details', async () => {
  const h = cycleHarness();
  await h.run();

  h.upstream.overrides.set('games', correctedFixture);
  h.advance(5 * MINUTE);
  const outcome = await h.run();

  assert.equal(h.startups.length, 1);
  assert.equal(h.reports.length, 1);
  assert.deepEqual(
    h.reports[0]!.results.map((change) => [change.kind, change.game.id]),
    [['corrected', 30258]],
  );
  assert.equal(h.reports[0]!.jornadaOf(30258)?.name, 'Jornada 2');
  assert.deepEqual(h.invalidated, [30258]);
  assert.deepEqual(outcome, { backoffMs: 0 });
});

test('a restart with an identical snapshot sends the startup message and no change message', async () => {
  const first = cycleHarness();
  await first.run();
  const snapshot = first.store.toSnapshot('2026-09-17T12:00:05.000Z');

  const restored = new TournamentStore(549);
  assert.equal(restored.restore(snapshot), 'restored');
  const h = cycleHarness(restored, Date.parse('2026-09-17T13:00:00.000Z'));
  await h.run();

  assert.equal(h.startups.length, 1);
  assert.equal(h.reports.length, 0);
});

test('a restart after upstream moved sends both the startup message and a change message', async () => {
  const first = cycleHarness();
  await first.run();
  const snapshot = first.store.toSnapshot('2026-09-17T12:00:05.000Z');

  const restored = new TournamentStore(549);
  restored.restore(snapshot);
  const h = cycleHarness(restored, Date.parse('2026-09-17T13:00:00.000Z'));
  h.upstream.overrides.set('games', correctedFixture);
  await h.run();

  assert.equal(h.startups.length, 1);
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0]!.results[0]!.game.id, 30258);
});

test('a snapshot from another tournament is never used as a baseline', async () => {
  const other = cycleHarness(new TournamentStore(548));
  await other.run();
  const snapshot = other.store.toSnapshot('2026-09-17T12:00:05.000Z');

  const store = new TournamentStore(549);
  assert.equal(store.restore(snapshot), 'other-tournament');
  const h = cycleHarness(store, Date.parse('2026-09-17T13:00:00.000Z'));
  h.upstream.overrides.set('games', correctedFixture);
  await h.run();

  assert.equal(h.startups.length, 1);
  assert.equal(h.reports.length, 0, 'no change message comparing two tournaments');
});
