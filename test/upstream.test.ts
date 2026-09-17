import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isPlayed } from '../src/model.js';
import {
  createFetcher,
  NotFoundError,
  parseEvents,
  parseFixture,
  parseJornadas,
  parseMatchInfo,
  parseMvps,
  parseRetryAfter,
  parseStandings,
  parseTournament,
  parseUpstreamDate,
  parseUpstreamTime,
  parseVenue,
  RateLimitedError,
  RateLimitState,
  routes,
  UpstreamError,
} from '../src/upstream.js';
import {
  gamesPayload,
  groupweeksPayload,
  jornadaGamesPayload,
  jornadaIds,
  matchPayload,
  positionsEmptyPayload,
  positionsFlatPayload,
  positionsPayload,
  rawFixture,
  tournamentPayload,
} from './fixtures.js';

const MINUTE = 60_000;
const clone = <T>(value: T): T => structuredClone(value);
type Json = Record<string, any>;

test('routes are built from the base URL and tournament id, with the jornada filter encoded', () => {
  const target = { baseUrl: 'https://www.ligapro.uy', tournamentId: 549 };
  assert.equal(routes.positions(target), 'https://www.ligapro.uy/api/tournaments/549/positions');
  assert.equal(routes.games(target), 'https://www.ligapro.uy/api/tournaments/549/games');
  assert.equal(
    routes.jornadaGames(target, 5392),
    'https://www.ligapro.uy/api/tournaments/549/games?filter%5Bgroupweek%5D%5B0%5D=5392',
  );
  assert.equal(routes.gameEvents(target, 30248), 'https://www.ligapro.uy/api/games/30248/events');
  assert.equal(routes.gamePage(target, 30248), 'https://www.ligapro.uy/juego/30248');
});

test('tournament info: name, dates as YYYY-MM-DD and the current jornada', () => {
  assert.deepEqual(parseTournament(tournamentPayload), {
    id: 549,
    name: 'Serie 4 / Divisional B / Clausura 2026',
    startDate: '2026-08-22',
    endDate: '2026-12-12',
    currentJornadaId: 5392,
  });
});

test('grouped standings keep the group and normalize names; goal difference may be negative', () => {
  const groups = parseStandings(positionsPayload);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.name, 'Divisional B');
  assert.equal(groups[0]!.rows.length, 15);

  const axioneta = groups[0]!.rows.find((row) => row.id === 1285)!;
  assert.equal(axioneta.name, 'La Axioneta');
  assert.equal(axioneta.dg, -29);

  const ort = groups[0]!.rows.find((row) => row.name === 'Universidad ORT Uruguay')!;
  assert.deepEqual(
    { position: ort.position, pts: ort.pts, pj: ort.pj, pg: ort.pg, pe: ort.pe, pp: ort.pp, gf: ort.gf, gc: ort.gc, dg: ort.dg },
    { position: 4, pts: 7, pj: 3, pg: 2, pe: 1, pp: 0, gf: 15, gc: 6, dg: 9 },
  );
});

test('flat standings become a single unnamed group', () => {
  const groups = parseStandings(positionsFlatPayload);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]!.name, null);
  assert.equal(groups[0]!.rows.length, 11);
});

test('standings with no teams at all are rejected (what an unknown tournament returns)', () => {
  assert.throws(() => parseStandings(positionsEmptyPayload), /no teams/);
});

test('malformed standings are rejected', () => {
  const mutate = (change: (row: Json) => void) => {
    const payload = clone(positionsPayload) as Json;
    change(payload.data[0].positions[3]);
    return payload;
  };

  assert.throws(() => parseStandings([]), UpstreamError, 'non-object body');
  assert.throws(() => parseStandings({ data: 'nope' }), UpstreamError, 'data not an array');
  assert.throws(() => parseStandings(mutate((row) => delete row.games)), /games is not a non-negative integer/);
  assert.throws(() => parseStandings(mutate((row) => (row.points = '12abc'))), /points/);
  assert.throws(() => parseStandings(mutate((row) => (row.games_lost = -1))), /games_lost/);
  assert.throws(() => parseStandings(mutate((row) => (row.goals_difference = 'lots'))), /goals_difference/);
  assert.throws(() => parseStandings(mutate((row) => (row.name = '   '))), /name/);
  assert.throws(() => parseStandings(mutate((row) => (row.id = null))), /id/);

  // Digit strings are accepted, since LigaPro mixes numbers and strings elsewhere.
  assert.equal(parseStandings(mutate((row) => (row.points = '7')))[0]!.rows[3]!.pts, 7);
});

test('the complete fixture: 105 games, 28 played, status from scores only', () => {
  const games = parseFixture(gamesPayload);
  assert.equal(games.length, 105);
  assert.equal(games.filter(isPlayed).length, 28);

  const axioneta = games.find((game) => game.id === 30248)!;
  assert.deepEqual(axioneta, {
    id: 30248,
    home: { name: 'La Axioneta', logo: axioneta.home.logo },
    away: { name: 'Carechimba FC', logo: axioneta.away.logo },
    homeGoals: 1,
    awayGoals: 10,
    date: '2026-08-29',
    time: null,
    venue: 'Pro Fútbol',
  });

  // Jornada 3's games are dated 28/11 yet already played; Jornada 15's are dated 05/09 and pending.
  const dated28Nov = games.find((game) => game.id === 30337)!;
  assert.equal(dated28Nov.date, '2026-11-28');
  assert.equal(isPlayed(dated28Nov), true);
  const dated05Sep = games.find((game) => game.id === 30252)!;
  assert.equal(dated05Sep.date, '2026-09-05');
  assert.equal(isPlayed(dated05Sep), false);
});

test('malformed games reject the fixture payload', () => {
  const mutate = (change: (game: Json) => void) => {
    const payload = clone(gamesPayload) as Json;
    change(payload.data[0]);
    return payload;
  };

  assert.throws(() => parseFixture(mutate((game) => (game.visiting_team_result = null))), /only one of the two scores/);
  assert.throws(() => parseFixture(mutate((game) => (game.local_team_result = '3abc'))), /local_team_result/);
  assert.throws(() => parseFixture(mutate((game) => (game.local_team_result = -2))), /local_team_result/);
  assert.throws(() => parseFixture(mutate((game) => delete game.local_team_name)), /local_team_name/);
  assert.throws(() => parseFixture(mutate((game) => (game.id = 'x'))), /id/);

  const duplicated = clone(gamesPayload) as Json;
  duplicated.data.push(duplicated.data[0]);
  assert.throws(() => parseFixture(duplicated), /appears twice/);
});

test('an unparseable date, the 00:00 placeholder and a "-" venue become unknown instead of failing', () => {
  const payload = clone(gamesPayload) as Json;
  payload.data[0].date = '31/02/2026';
  payload.data[1].date = 'pronto';
  payload.data[2].hour = '20:30';
  payload.data[3].stadium = ' - ';
  const games = parseFixture(payload);

  assert.equal(games[0]!.date, null);
  assert.equal(games[1]!.date, null);
  assert.equal(games[2]!.time, '20:30');
  assert.equal(games[3]!.venue, null);
  assert.equal(games[4]!.time, null, '00:00 is a placeholder');

  assert.equal(parseUpstreamDate('5/9/2026'), '2026-09-05');
  assert.equal(parseUpstreamTime('00:00'), null);
  assert.equal(parseUpstreamTime('24:10'), null);
  assert.equal(parseVenue('Complejo  LigaSiete'), 'Complejo LigaSiete');
});

test('an empty fixture parses; rejecting it over a stored one is the poll\'s job', () => {
  assert.deepEqual(parseFixture({ data: [] }), []);
});

test('jornadas parse in order, and the per-jornada lists partition the complete fixture', () => {
  const jornadas = parseJornadas(groupweeksPayload);
  assert.equal(jornadas.length, 15);
  assert.deepEqual(jornadas.map((jornada) => jornada.order), [...Array(15).keys()].map((i) => i + 1));
  assert.deepEqual(jornadas[3], { id: 5392, name: 'Jornada 4', order: 4, date: '2026-09-12' });

  const perJornada = jornadaIds.flatMap((id) => parseFixture(jornadaGamesPayload(id)).map((game) => game.id));
  const complete = parseFixture(gamesPayload).map((game) => game.id);
  assert.equal(perJornada.length, 105);
  assert.deepEqual([...perJornada].sort(), [...complete].sort());
});

test('match info carries both team ids and logos', () => {
  const info = parseMatchInfo(matchPayload(30248, 'info'));
  assert.equal(info.id, 30248);
  assert.equal(info.jornadaName, 'Jornada 4');
  assert.equal(info.venue, 'Pro Fútbol');
  assert.equal(info.time, null);
  assert.deepEqual(
    { home: [info.home.id, info.home.name, info.home.goals], away: [info.away.id, info.away.name, info.away.goals] },
    { home: [1285, 'La Axioneta', 1], away: [704, 'Carechimba FC', 10] },
  );
  assert.ok(info.home.logo?.endsWith('4bd7c197dbfb2568aa1b4876fd5a5c3d.jpg'));
  assert.throws(() => parseMatchInfo({ data: { id: 1 } }), UpstreamError);
});

test('event kinds come from the numeric type, including the misspelled red card', () => {
  const events = parseEvents(matchPayload(30259, 'events'));
  const red = events.find((event) => event.typeId === 4)!;
  assert.equal(red.kind, 'red');
  assert.equal(red.label, 'Tarjets Roja');
  assert.equal(red.player, 'Federico DELGADO');

  const kinds = new Set(parseEvents(matchPayload(30239, 'events')).map((event) => event.kind));
  assert.deepEqual(kinds, new Set(['goal', 'assist', 'yellow']));
  assert.deepEqual(parseEvents(matchPayload(30237, 'events')), []);
});

test('a single malformed event is dropped and reported, the rest are kept', () => {
  const payload = clone(matchPayload(30248, 'events')) as Json;
  delete payload.data[0].type_id;
  payload.data[1].minutes = -3;
  const dropped: string[] = [];

  const events = parseEvents(payload, (reason) => dropped.push(reason));
  assert.equal(events.length, 9);
  assert.equal(dropped.length, 2);
  assert.equal(events.some((event) => event.kind === 'other'), false);

  const unknownType = clone(matchPayload(30248, 'events')) as Json;
  unknownType.data[0].type_id = 2;
  unknownType.data[0].type_name = 'Gol en Contra';
  const other = parseEvents(unknownType).find((event) => event.typeId === 2)!;
  assert.equal(other.kind, 'other');
  assert.equal(other.label, 'Gol en Contra');

  assert.throws(() => parseEvents({ data: null }), UpstreamError);
});

test('featured players: one per team, each with its team logo', () => {
  const players = parseMvps(matchPayload(30258, 'mvps'));
  assert.equal(players.length, 2);
  assert.deepEqual(
    players.map((player) => player.name),
    ['Mateo Mandiá Sapone', 'Mauro Rodríguez'],
  );
  assert.ok(players.every((player) => player.teamLogo?.startsWith('https://')));
  assert.deepEqual(parseMvps(matchPayload(30237, 'mvps')), []);
});

function stubFetch(response: Response | Error, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
}

const upstream = { timeoutMs: 1_000, userAgent: 'prort-test/1.0' };

test('the fetcher sends a user agent and a timeout signal, and parses JSON', async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const fetchJson = createFetcher(upstream, stubFetch(new Response('{"data":[]}', { status: 200 }), seen));

  assert.deepEqual(await fetchJson('https://example.test/api'), { data: [] });
  assert.equal((seen.init?.headers as Record<string, string>)['user-agent'], 'prort-test/1.0');
  assert.ok(seen.init?.signal instanceof AbortSignal);
});

test('the fetcher maps 404, 429, other statuses, bad JSON and network errors', async () => {
  const call = (response: Response | Error) => createFetcher(upstream, stubFetch(response))('https://example.test');

  await assert.rejects(call(new Response(rawFixture('game-not-found'), { status: 404 })), NotFoundError);

  await assert.rejects(call(new Response('slow down', { status: 429, headers: { 'retry-after': '900' } })), (error) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfterSeconds, 900);
    return true;
  });
  await assert.rejects(call(new Response('', { status: 429 })), (error) => {
    assert.ok(error instanceof RateLimitedError);
    assert.equal(error.retryAfterSeconds, null);
    return true;
  });

  await assert.rejects(call(new Response('boom', { status: 500 })), /unexpected status 500/);
  await assert.rejects(call(new Response('<html>', { status: 200 })), /not JSON/);
  await assert.rejects(call(new TypeError('fetch failed')), /request failed: fetch failed/);
});

test('Retry-After is honored only as whole seconds', () => {
  assert.equal(parseRetryAfter('900'), 900);
  assert.equal(parseRetryAfter(' 30 '), 30);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('backoff doubles per consecutive rate-limited poll, caps at 60 minutes, and resets after a clean poll', () => {
  const state = new RateLimitState();
  const interval = 5 * MINUTE;

  assert.deepEqual(
    [1, 2, 3, 4, 5].map(() => state.onRateLimited(interval, null, 0) / MINUTE),
    [10, 20, 40, 60, 60],
  );
  assert.equal(state.isActive(59 * MINUTE), true);

  state.onCleanPoll();
  assert.equal(state.isActive(0), false);
  assert.equal(state.until(0), null);
  assert.equal(state.onRateLimited(interval, null, 0), 10 * MINUTE, 'back to the first step');
});

test('backoff is never shorter than Retry-After, and the cap never undercuts a longer interval', () => {
  const state = new RateLimitState();
  assert.equal(state.onRateLimited(5 * MINUTE, 900, 0), 15 * MINUTE);
  assert.equal(state.remainingMs(5 * MINUTE), 10 * MINUTE);

  assert.equal(new RateLimitState().onRateLimited(90 * MINUTE, null, 0), 90 * MINUTE);
});
