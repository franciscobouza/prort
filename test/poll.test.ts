import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { runPoll, type PollDeps, type PollResult } from '../src/poll.js';
import { TournamentStore } from '../src/store.js';
import { RateLimitedError, RateLimitState, UpstreamError } from '../src/upstream.js';
import { fakeUpstream } from './fake-upstream.js';
import { fixture, jornadaIds } from './fixtures.js';

const MINUTE = 60_000;
const silent = { info: () => {}, warn: () => {} };
const config = loadConfig({ UPSTREAM_BASE_URL: 'http://upstream.test' });

type Json = Record<string, any>;

/** A poller over one store with a controllable clock; sleeps are recorded, never waited. */
function harness() {
  const upstream = fakeUpstream();
  const store = new TournamentStore(549);
  const rateLimit = new RateLimitState();
  const sleeps: number[] = [];
  let clock = Date.parse('2026-09-17T12:00:00.000Z');

  const deps: PollDeps = {
    config,
    store,
    fetchJson: upstream.fetchJson,
    rateLimit,
    log: silent,
    startedAt: clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock,
  };

  return {
    upstream,
    store,
    rateLimit,
    sleeps,
    advance: (ms: number) => {
      clock += ms;
    },
    poll: async (): Promise<PollResult> => {
      upstream.calls.length = 0;
      sleeps.length = 0;
      return runPoll(deps);
    },
  };
}

const JORNADA_ROUTES = jornadaIds.map((id) => `jornada:${id}`);
const withExtraGame = (id: number) => () => {
  const payload = structuredClone(fixture('games')) as Json;
  payload.data.push({ ...payload.data[0], id, local_team_result: null, visiting_team_result: null });
  return payload;
};

test('a cold first poll stores every feed, refreshes jornadas, paces requests and reports nothing', async () => {
  const h = harness();
  const result = await h.poll();

  assert.deepEqual(h.upstream.calls, ['positions', 'games', 'tournament', 'groupweeks', ...JORNADA_ROUTES]);
  assert.equal(h.upstream.peak(), 1, 'no two requests of a poll may be in flight together');
  assert.deepEqual(h.sleeps, Array(18).fill(250), 'a 250 ms gap between consecutive requests');

  assert.equal(result.wasCold, true);
  assert.equal(result.anySuccess, true);
  assert.equal(result.refreshedJornadas, true);
  assert.deepEqual([result.standingsChanges, result.resultChanges], [[], []]);
  assert.equal(result.backoffMs, 0);

  assert.equal(h.store.isCold, false);
  assert.equal(h.store.standings()?.[0]?.rows.length, 15);
  assert.equal(h.store.fixture()?.length, 105);
  assert.equal(h.store.tournament()?.name, 'Serie 4 / Divisional B / Clausura 2026');
  assert.equal(h.store.jornadas()?.assignment['30337'], 5391, 'the game dated 28/11 belongs to Jornada 3');
  assert.equal(h.store.jornadas()?.fixtureIds.length, 105);
});

test('a poll soon after asks only for standings and fixture', async () => {
  const h = harness();
  await h.poll();
  h.advance(5 * MINUTE);

  const result = await h.poll();
  assert.deepEqual(h.upstream.calls, ['positions', 'games']);
  assert.equal(result.refreshedJornadas, false);
});

test('the jornada refresh runs again once the refresh interval elapses', async () => {
  const h = harness();
  await h.poll();
  h.advance(59 * MINUTE);
  await h.poll();
  assert.equal(h.upstream.calls.length, 2);

  h.advance(1 * MINUTE);
  const result = await h.poll();
  assert.equal(result.refreshedJornadas, true);
  assert.equal(h.upstream.calls.length, 19);
});

test('a restart refreshes jornadas even when the restored assignment is recent', async () => {
  const h = harness();
  await h.poll();

  const restarted = new TournamentStore(549);
  restarted.restore(h.store.toSnapshot('2026-09-17T12:01:00.000Z'));
  const upstream = fakeUpstream();
  await runPoll({
    config,
    store: restarted,
    fetchJson: upstream.fetchJson,
    rateLimit: new RateLimitState(),
    log: silent,
    startedAt: Date.parse('2026-09-17T12:02:00.000Z'),
    now: () => Date.parse('2026-09-17T12:02:00.000Z'),
    gapMs: 0,
  });
  assert.equal(upstream.calls.length, 19);
});

test('a game new to the fixture triggers a refresh in that poll, and a game in no jornada only once', async () => {
  const h = harness();
  await h.poll();

  h.upstream.overrides.set('games', withExtraGame(99_001));
  h.advance(5 * MINUTE);
  const first = await h.poll();
  assert.equal(first.refreshedJornadas, true, 'new game id → refresh during this poll');
  assert.equal(h.store.jornadas()?.assignment['99001'], undefined, 'upstream lists it under no jornada');

  h.advance(5 * MINUTE);
  const second = await h.poll();
  assert.equal(second.refreshedJornadas, false, 'the unassigned game must not trigger a refresh every poll');
  assert.deepEqual(h.upstream.calls, ['positions', 'games']);
});

test('one failing per-jornada request keeps the previous assignment and is retried next poll', async () => {
  const h = harness();
  await h.poll();
  const before = structuredClone(h.store.jornadas());

  h.advance(60 * MINUTE);
  h.upstream.overrides.set('jornada:5395', () => {
    throw new UpstreamError('unexpected status 502');
  });
  const failed = await h.poll();

  assert.equal(failed.refreshedJornadas, false);
  assert.deepEqual(h.store.jornadas(), before, 'assignment kept in full');
  assert.equal(h.store.feed('jornadas').lastAttemptFailed, true);
  assert.equal(h.upstream.calls.at(-1), 'jornada:5395', 'stops asking once a jornada fails');

  h.upstream.overrides.delete('jornada:5395');
  h.advance(5 * MINUTE);
  const retried = await h.poll();
  assert.equal(retried.refreshedJornadas, true);
  assert.equal(h.store.feed('jornadas').lastAttemptFailed, false);
});

test('fixture and standings fail independently', async () => {
  const h = harness();
  await h.poll();
  const storedFixture = h.store.fixture();
  const fixtureAt = h.store.feed('fixture').fetchedAt;

  h.advance(5 * MINUTE);
  h.upstream.overrides.set('games', () => {
    throw new UpstreamError('request failed: timeout');
  });
  await h.poll();
  assert.equal(h.store.feed('standings').lastAttemptFailed, false);
  assert.notEqual(h.store.feed('standings').fetchedAt, fixtureAt, 'standings updated');
  assert.equal(h.store.fixture(), storedFixture, 'fixture kept');
  assert.equal(h.store.feed('fixture').fetchedAt, fixtureAt);
  assert.equal(h.store.feed('fixture').lastAttemptFailed, true);

  h.upstream.overrides.clear();
  h.upstream.overrides.set('positions', () => ({ data: 'broken' }));
  h.advance(5 * MINUTE);
  await h.poll();
  assert.equal(h.store.feed('standings').lastAttemptFailed, true);
  assert.equal(h.store.feed('fixture').lastAttemptFailed, false);
  assert.equal(h.store.standings()?.[0]?.rows.length, 15, 'previous standings kept');
});

test('an empty fixture is rejected while a non-empty one is stored', async () => {
  const h = harness();
  await h.poll();
  h.upstream.overrides.set('games', () => ({ data: [] }));
  h.advance(5 * MINUTE);

  const result = await h.poll();
  assert.equal(h.store.fixture()?.length, 105);
  assert.equal(h.store.feed('fixture').lastAttemptFailed, true);
  assert.deepEqual(result.resultChanges, [], 'no mass "cleared" report');
});

test('a 429 mid-poll stops the poll and backs off 10, 20, 40 then 60 minutes; a clean poll resets', async () => {
  const h = harness();
  await h.poll();
  h.upstream.overrides.set('games', () => {
    throw new RateLimitedError(null);
  });

  const backoffs: number[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    h.advance(backoffs.at(-1) ?? 5 * MINUTE);
    const result = await h.poll();
    assert.equal(result.rateLimited, true);
    assert.deepEqual(h.upstream.calls, ['positions', 'games'], 'nothing is requested after the 429');
    backoffs.push(result.backoffMs);
  }
  assert.deepEqual(backoffs.map((ms) => ms / MINUTE), [10, 20, 40, 60]);
  assert.equal(h.store.feed('standings').lastAttemptFailed, false, 'data from before the 429 is kept');
  assert.equal(h.store.feed('fixture').lastAttemptFailed, true);

  h.upstream.overrides.clear();
  h.advance(60 * MINUTE);
  const clean = await h.poll();
  assert.equal(clean.rateLimited, false);
  assert.equal(clean.backoffMs, 0);
  assert.equal(h.rateLimit.isActive(Date.now()), false);
});

test('Retry-After is honored and later polls are skipped until it passes', async () => {
  const h = harness();
  await h.poll();
  h.upstream.overrides.set('positions', () => {
    throw new RateLimitedError(900);
  });
  h.advance(5 * MINUTE);
  const limited = await h.poll();
  assert.equal(limited.backoffMs, 15 * MINUTE);
  assert.deepEqual(h.upstream.calls, ['positions']);

  h.upstream.overrides.clear();
  h.advance(5 * MINUTE);
  const early = await h.poll();
  assert.equal(early.skipped, true, 'still inside the Retry-After window');
  assert.equal(early.backoffMs, 10 * MINUTE);
  assert.deepEqual(h.upstream.calls, []);

  h.advance(10 * MINUTE);
  const resumed = await h.poll();
  assert.equal(resumed.skipped, false);
  assert.deepEqual(resumed.backoffMs, 0);
});

test('a warm poll reports a newly posted result and the table movement behind it', async () => {
  const h = harness();
  await h.poll();

  // Jornada 5: Real Rejunte 2-1 Babacar FC, with the standings recomputed.
  h.upstream.overrides.set('games', () => {
    const payload = structuredClone(fixture('games')) as Json;
    const game = payload.data.find((entry: Json) => entry.id === 30265);
    Object.assign(game, { local_team_result: 2, visiting_team_result: 1 });
    return payload;
  });
  h.upstream.overrides.set('positions', () => {
    const payload = structuredClone(fixture('positions')) as Json;
    const rows = payload.data[0].positions as Json[];
    const rejunte = rows.find((row) => row.id === 211)!;
    Object.assign(rejunte, { games: 5, games_won: 4, points: 13, goals_for: 14, goals_against: 9, goals_difference: 5 });
    const babacar = rows.find((row) => row.id === 893)!;
    Object.assign(babacar, { games: 4, games_lost: 4, goals_for: 4, goals_against: 18, goals_difference: -14 });
    return payload;
  });
  h.advance(5 * MINUTE);

  const result = await h.poll();
  assert.equal(result.wasCold, false);
  assert.deepEqual(
    result.resultChanges.map((change) => [change.kind, change.game.id]),
    [['new', 30265]],
  );
  assert.deepEqual(
    result.standingsChanges.map((change) => [change.kind, change.team.name]),
    [
      ['updated', 'Real Rejunte'],
      ['updated', 'Babacar FC'],
    ],
  );
});
