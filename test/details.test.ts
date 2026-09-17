import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { MatchDetailsService, type MatchDetailsResult } from '../src/details.js';
import { TournamentStore } from '../src/store.js';
import { NotFoundError, RateLimitedError, RateLimitState, UpstreamError, type JsonFetcher } from '../src/upstream.js';
import { matchPayload, tournamentData } from './fixtures.js';

const MINUTE = 60_000;
const silent = { info: () => {}, warn: () => {} };

type Part = 'info' | 'events' | 'mvps';

function harness(env: Record<string, string> = {}) {
  const config = loadConfig({ UPSTREAM_BASE_URL: 'http://upstream.test', ...env });
  const store = new TournamentStore(549);
  const data = tournamentData();
  const at = '2026-09-17T12:00:00.000Z';
  store.record('tournament', data.tournament, at);
  store.record('standings', data.standings, at);
  store.record('fixture', data.fixture, at);
  store.record('jornadas', data.jornadas, at);

  const calls: string[] = [];
  const overrides = new Map<string, () => unknown>();
  let clock = Date.parse(at);

  const fetchJson: JsonFetcher = async (url) => {
    const [, gameId, part] = /\/api\/games\/(\d+)\/(info|events|mvps)$/.exec(new URL(url).pathname)!;
    const key = `${gameId}/${part}`;
    calls.push(key);
    await new Promise((resolve) => setImmediate(resolve));
    const override = overrides.get(key);
    return override ? override() : matchPayload(Number(gameId), part as Part);
  };

  const rateLimit = new RateLimitState();
  const details = new MatchDetailsService({ config, store, fetchJson, rateLimit, log: silent, now: () => clock });
  return {
    details,
    calls,
    overrides,
    rateLimit,
    store,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const present = (result: MatchDetailsResult | null): MatchDetailsResult => {
  assert.ok(result, 'expected details');
  return result;
};

const lines = (result: MatchDetailsResult) =>
  result.timeline!.map((event) => `${event.period === 'FIRST_TIME' ? '1T' : '2T'} ${event.minute}' ${event.kind} ${event.player} ${event.side}`);

test('a first view retrieves info, events and featured players, then serves them fresh', async () => {
  const h = harness();
  const result = present(await h.details.get(30248));

  assert.deepEqual(h.calls, ['30248/info', '30248/events', '30248/mvps']);
  assert.equal(result.status, 'fresh');
  assert.equal(result.basic.jornadaName, 'Jornada 4');
  assert.equal(result.basic.tournamentName, 'Serie 4 / Divisional B / Clausura 2026');
  assert.deepEqual([result.basic.home, result.basic.homeGoals, result.basic.awayGoals, result.basic.away], ['La Axioneta', 1, 10, 'Carechimba FC']);
  assert.equal(result.fetchedAt, '2026-09-17T12:00:00.000Z');
});

test('the timeline is ordered by period and minute, whatever order upstream used', async () => {
  const result = present(await harness().details.get(30248));
  assert.deepEqual(lines(result).slice(0, 6), [
    "1T 5' goal Felipe Sierra away",
    "1T 11' goal Francisco Fassani away",
    "1T 18' goal Luis Porras away",
    "1T 21' goal Luis Porras away",
    "1T 27' goal Santiago Rodriguez home",
    "2T 5' goal Lucas Bruzzone away",
  ]);
});

test('the misspelled red card is a red card, and each event is attributed to its side', async () => {
  const result = present(await harness().details.get(30259));
  const red = result.timeline!.find((event) => event.kind === 'red')!;
  assert.deepEqual([red.player, red.side, red.minute, red.period], ['Federico DELGADO', 'home', 22, 'FIRST_TIME']);
});

test('assists follow their goals, and yellow cards keep their minute', async () => {
  const result = present(await harness().details.get(30239));
  assert.deepEqual(lines(result).slice(0, 4), [
    "1T 2' goal Roman Ferrero home",
    "1T 2' assist Agustín Costa home",
    "1T 8' goal Javier Gonzalez away",
    "1T 8' assist Santiago Lozano away",
  ]);
  assert.deepEqual(
    result.timeline!.filter((event) => event.kind === 'yellow').map((event) => [event.minute, event.side]),
    [
      [26, 'home'],
      [19, 'home'],
      [22, 'home'],
    ],
  );
});

test('goals without a recorded scorer are counted per side, and a match without events says so', async () => {
  const h = harness();
  assert.deepEqual(present(await h.details.get(30258)).missingGoals, { home: 0, away: 1 });
  assert.deepEqual(present(await h.details.get(30240)).missingGoals, { home: 0, away: 2 });

  const walkover = present(await h.details.get(30237));
  assert.equal(walkover.noEvents, true);
  assert.deepEqual(walkover.timeline, []);
  assert.deepEqual(present(await h.details.get(30248)).missingGoals, { home: 0, away: 0 });
});

test("featured players are each attributed to their own team", async () => {
  const result = present(await harness().details.get(30258));
  assert.deepEqual(result.featuredPlayers, [
    { name: 'Mateo Mandiá Sapone', side: 'home' },
    { name: 'Mauro Rodríguez', side: 'away' },
  ]);
});

test('pending, unknown and malformed ids are not found and never reach upstream', async () => {
  const h = harness();
  for (const id of [30265, 12345, 'abc', '-1', '0', '1e3', '30248 ']) {
    assert.equal(await h.details.get(id), null, `${id} should not be available`);
  }
  assert.deepEqual(h.calls, []);
});

test('a repeat view within the TTL is served from cache; after it, upstream is asked again', async () => {
  const h = harness();
  await h.details.get(30248);
  h.advance(14 * MINUTE);
  assert.equal(present(await h.details.get(30248)).status, 'fresh');
  assert.equal(h.calls.length, 3);

  h.advance(2 * MINUTE);
  assert.equal(present(await h.details.get(30248)).status, 'fresh');
  assert.equal(h.calls.length, 6);
});

test('concurrent views of the same match share one retrieval', async () => {
  const h = harness();
  const results = await Promise.all([h.details.get(30259), h.details.get(30259), h.details.get('30259')]);
  assert.deepEqual(results.map((result) => result?.status), ['fresh', 'fresh', 'fresh']);
  assert.deepEqual(h.calls, ['30259/info', '30259/events', '30259/mvps']);
});

test('the per-minute budget is never exceeded; over it, basic info is served without asking upstream', async () => {
  const h = harness({ MATCH_DETAILS_REQUESTS_PER_MINUTE: '4' });
  await h.details.get(30248);
  assert.equal(h.calls.length, 3);

  const starved = present(await h.details.get(30258));
  assert.equal(starved.status, 'unavailable');
  assert.equal(starved.timeline, null);
  assert.deepEqual([starved.basic.home, starved.basic.homeGoals, starved.basic.awayGoals], ['Babacar FC', 1, 9]);
  assert.equal(h.calls.length, 3, 'no request over the budget');

  h.advance(MINUTE);
  assert.equal(present(await h.details.get(30258)).status, 'fresh');
});

test('featured players are skipped rather than overdrawing the budget', async () => {
  const h = harness({ MATCH_DETAILS_REQUESTS_PER_MINUTE: '2' });
  const result = present(await h.details.get(30258));
  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.featuredPlayers, []);
  assert.deepEqual(h.calls, ['30258/info', '30258/events']);
});

test('during a backoff an expired copy is served as possibly outdated, without asking upstream', async () => {
  const h = harness();
  await h.details.get(30248);
  h.advance(20 * MINUTE);
  h.rateLimit.onRateLimited(5 * MINUTE, null, h.now());

  const result = present(await h.details.get(30248));
  assert.equal(result.status, 'stale');
  assert.ok(result.timeline!.length > 0);
  assert.equal(h.calls.length, 3);

  assert.equal(present(await h.details.get(30259)).status, 'unavailable', 'nothing cached for this one');
  assert.equal(h.calls.length, 3);
});

test('an upstream failure serves the expired copy when there is one, and basic info otherwise', async () => {
  const h = harness();
  await h.details.get(30248);
  h.advance(20 * MINUTE);
  h.overrides.set('30248/events', () => {
    throw new UpstreamError('unexpected status 500');
  });
  assert.equal(present(await h.details.get(30248)).status, 'stale');

  h.overrides.set('30259/info', () => {
    throw new NotFoundError('upstream answered 404');
  });
  const missing = present(await h.details.get(30259));
  assert.equal(missing.status, 'unavailable');

  h.overrides.delete('30248/events');
  assert.equal(present(await h.details.get(30248)).status, 'fresh', 'a later request tries again');
});

test('a failing featured-players request still yields fresh details', async () => {
  const h = harness();
  h.overrides.set('30258/mvps', () => {
    throw new UpstreamError('unexpected status 502');
  });
  const result = present(await h.details.get(30258));
  assert.equal(result.status, 'fresh');
  assert.deepEqual(result.featuredPlayers, []);
  assert.equal(result.missingGoals?.away, 1);
});

test('invalidation after a corrected score forces a refetch', async () => {
  const h = harness();
  await h.details.get(30248);
  h.details.invalidate(30248);
  await h.details.get(30248);
  assert.equal(h.calls.length, 6);
});

test('a retrieval invalidated while in flight is discarded', async () => {
  const h = harness();
  const pending = h.details.get(30248);
  h.details.invalidate(30248);
  const result = present(await pending);
  assert.equal(result.status, 'unavailable');
  assert.equal(h.details.cachedCount, 0);
});

test('a 429 on a detail request starts the shared backoff', async () => {
  const h = harness();
  h.overrides.set('30248/info', () => {
    throw new RateLimitedError(120);
  });
  assert.equal(present(await h.details.get(30248)).status, 'unavailable');
  assert.equal(h.rateLimit.isActive(h.now()), true);

  h.overrides.clear();
  assert.equal(present(await h.details.get(30259)).status, 'unavailable', 'no upstream requests while backing off');
  assert.deepEqual(h.calls, ['30248/info']);
});
