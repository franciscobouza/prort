import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { canonicalStandings, diffResults, diffStandings, standingsChanged } from '../src/diff.js';
import type { Game, StandingsGroup, TeamRow } from '../src/model.js';
import { runPoll } from '../src/poll.js';
import { TournamentStore } from '../src/store.js';
import { RateLimitState, UpstreamError } from '../src/upstream.js';
import { tournamentData } from './fixtures.js';

const { standings, fixture } = tournamentData();

const bump = (groups: StandingsGroup[], id: number, over: Partial<TeamRow>): StandingsGroup[] =>
  groups.map((group) => ({ ...group, rows: group.rows.map((row) => (row.id === id ? { ...row, ...over } : row)) }));

const withGame = (games: Game[], id: number, over: Partial<Game>): Game[] =>
  games.map((game) => (game.id === id ? { ...game, ...over } : game));

const ORT = 997;
const TFC = 275;

test('a row-order-only difference is not a change', () => {
  const reordered = standings.map((group) => ({ ...group, rows: [...group.rows].reverse() }));
  assert.equal(canonicalStandings(standings), canonicalStandings(reordered));
  assert.equal(standingsChanged(standings, reordered), false);
});

test('an official position change alone is not a change', () => {
  const swapped = bump(bump(standings, ORT, { position: 5 }), 987, { position: 4 });
  assert.equal(standingsChanged(standings, swapped), false);
});

test('a name or logo change alone is not a change', () => {
  assert.equal(standingsChanged(standings, bump(standings, ORT, { name: 'ORT', logo: null })), false);
});

test('a stats change is a change, reported with PPerd and the position movement', () => {
  const after = bump(standings, ORT, { position: 1, pj: 4, pg: 3, gf: 19, gc: 7, dg: 12, pts: 10 });
  assert.equal(standingsChanged(standings, after), true);

  const changes = diffStandings(standings, after);
  const ort = changes.find((change) => change.team.id === ORT);
  assert.ok(ort && ort.kind === 'updated');
  assert.deepEqual(ort.fields, [
    { field: 'PJ', before: 3, after: 4 },
    { field: 'PG', before: 2, after: 3 },
    { field: 'GF', before: 15, after: 19 },
    { field: 'GC', before: 6, after: 7 },
    { field: 'Pts', before: 7, after: 10 },
  ]);
  assert.deepEqual([ort.positionBefore, ort.positionAfter, ort.group], [4, 1, 'Divisional B']);

  const lost = diffStandings(standings, bump(standings, TFC, { pj: 5, pp: 2 })).find((change) => change.team.id === TFC);
  assert.ok(lost && lost.kind === 'updated');
  assert.deepEqual(lost.fields.at(-1), { field: 'PPerd', before: 5, after: 8 });
});

test('teams that only moved because others did are listed with no fields of their own', () => {
  const after = bump(bump(standings, ORT, { pts: 10, position: 1 }), 211, { position: 2 });
  const rejunte = diffStandings(standings, after).find((change) => change.team.id === 211);
  assert.ok(rejunte && rejunte.kind === 'updated');
  assert.deepEqual([rejunte.fields, rejunte.positionBefore, rejunte.positionAfter], [[], 1, 2]);
});

test('a new team is a change and is reported as added; a missing one as removed', () => {
  const extra: TeamRow = { ...standings[0]!.rows[0]!, id: 9999, name: 'Nuevo FC', position: 16 };
  const grown = standings.map((group) => ({ ...group, rows: [...group.rows, extra] }));
  assert.equal(standingsChanged(standings, grown), true);
  assert.deepEqual(
    diffStandings(standings, grown).map((change) => [change.kind, change.team.name]),
    [['added', 'Nuevo FC']],
  );
  assert.deepEqual(
    diffStandings(grown, standings).map((change) => [change.kind, change.team.name]),
    [['removed', 'Nuevo FC']],
  );
});

test('no baseline means nothing to report', () => {
  assert.equal(standingsChanged(null, standings), false);
  assert.deepEqual(diffResults(null, fixture), []);
});

test('identical fixtures produce no result changes', () => {
  assert.deepEqual(diffResults(fixture, structuredClone(fixture)), []);
});

test('a pending game that gets scores is a new result', () => {
  const after = withGame(fixture, 30265, { homeGoals: 2, awayGoals: 1 });
  assert.deepEqual(
    diffResults(fixture, after).map((change) => [change.kind, change.game.id]),
    [['new', 30265]],
  );
});

test('a changed score is a corrected result, with the previous score', () => {
  const after = withGame(fixture, 30258, { homeGoals: 1, awayGoals: 10 });
  const [change] = diffResults(fixture, after);
  assert.ok(change && change.kind === 'corrected');
  assert.deepEqual(change.before, { home: 1, away: 9 });
  assert.deepEqual([change.game.homeGoals, change.game.awayGoals], [1, 10]);
});

test('a played game that loses its scores, or disappears from the fixture, is a cleared result', () => {
  const blanked = withGame(fixture, 30258, { homeGoals: null, awayGoals: null });
  assert.deepEqual(
    diffResults(fixture, blanked).map((change) => [change.kind, change.game.id, change.kind === 'cleared' && change.before]),
    [['cleared', 30258, { home: 1, away: 9 }]],
  );

  const removed = fixture.filter((game) => game.id !== 30258);
  assert.deepEqual(
    diffResults(fixture, removed).map((change) => [change.kind, change.game.id]),
    [['cleared', 30258]],
  );
});

test('a rescheduled game is not a result change', () => {
  const moved = withGame(fixture, 30252, { date: '2026-11-28', time: '20:30', venue: 'Otra cancha' });
  assert.deepEqual(diffResults(fixture, moved), []);
  const newPending: Game = { ...fixture[0]!, id: 99_002, homeGoals: null, awayGoals: null };
  assert.deepEqual(diffResults(fixture, [...fixture, newPending]), []);
});

test('a failed poll reports nothing', async () => {
  const store = new TournamentStore(549);
  const at = '2026-09-17T12:00:00.000Z';
  store.record('standings', standings, at);
  store.record('fixture', fixture, at);
  store.markWarm();

  const result = await runPoll({
    config: loadConfig({ UPSTREAM_BASE_URL: 'http://upstream.test' }),
    store,
    fetchJson: async () => {
      throw new UpstreamError('request failed: getaddrinfo ENOTFOUND');
    },
    rateLimit: new RateLimitState(),
    log: { info: () => {}, warn: () => {} },
    gapMs: 0,
  });

  assert.equal(result.anySuccess, false);
  assert.deepEqual([result.standingsChanges, result.resultChanges], [[], []]);
  assert.equal(store.fixture(), fixture);
});
