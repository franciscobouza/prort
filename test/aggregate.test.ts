import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildGroupViews, orderRows, pperd } from '../src/aggregate.js';
import type { Game, GroupView, TeamRow, TeamView } from '../src/model.js';
import { tournamentData } from './fixtures.js';

const views = (overrides: Partial<ReturnType<typeof tournamentData>> = {}): GroupView[] => {
  const data = { ...tournamentData(), ...overrides };
  return buildGroupViews(data.standings, data.fixture, data.jornadas);
};

const team = (groups: GroupView[], name: string): TeamView => {
  const found = groups.flatMap((group) => group.teams).find((view) => view.row.name === name);
  assert.ok(found, `team ${name} not found`);
  return found;
};

test('PPerd is 3 per loss plus 2 per draw', () => {
  assert.equal(pperd({ pe: 1, pp: 1 }), 5);
  assert.equal(pperd({ pe: 0, pp: 4 }), 12);
  assert.equal(pperd({ pe: 1, pp: 0 }), 2);

  const groups = views();
  assert.equal(team(groups, 'DELTA FC').row.pperd, 5);
  assert.equal(team(groups, 'Juana Chard').row.pperd, 12);
  assert.equal(team(groups, 'Real Rejunte').row.pperd, 2);
});

test('rows keep the official order and values', () => {
  const [group] = views();
  assert.equal(group!.name, 'Divisional B');
  assert.deepEqual(
    group!.teams.map((view) => view.row.position),
    [...Array(15).keys()].map((index) => index + 1),
  );
  // Six teams on 7 points sit at positions 3 to 8, in the official order whatever their goal difference.
  assert.deepEqual(
    group!.teams.slice(2, 8).map((view) => [view.row.name, view.row.pts]),
    [
      ['DELTA FC', 7],
      ['Universidad ORT Uruguay', 7],
      ['Inter Mitente FC', 7],
      ['TFC', 7],
      ['Chacal F.C', 7],
      ['Sportivo Malvin', 7],
    ],
  );
});

test('colliding positions fall back to points, goal difference, goals for and name', () => {
  const row = (name: string, over: Partial<TeamRow>): TeamRow => ({
    id: name.length,
    position: 2,
    name,
    logo: null,
    pts: 7,
    pj: 3,
    pg: 2,
    pe: 1,
    pp: 0,
    gf: 10,
    gc: 5,
    dg: 5,
    ...over,
  });
  const ordered = orderRows([
    row('Zeta', {}),
    row('Alfa', {}),
    row('More goals', { gf: 11 }),
    row('Better difference', { dg: 6 }),
    row('More points', { pts: 8 }),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.name),
    ['More points', 'Better difference', 'More goals', 'Alfa', 'Zeta'],
  );
});

test('every one of the 15 teams agrees with its standings row', () => {
  const [group] = views();
  for (const view of group!.teams) {
    assert.equal(view.discrepancy, false, `${view.row.name} disagrees`);
    assert.equal(view.played.length, view.row.pj);
    assert.equal(view.played.length + view.remaining.length, 14, `${view.row.name} should face 14 opponents`);
  }
});

test('played matches are oriented to the team: home win, away win, draw', () => {
  const ort = team(views(), 'Universidad ORT Uruguay');
  assert.deepEqual(
    ort.played.map((match) => [match.jornada?.name, match.home, match.opponent, `${match.goalsFor}-${match.goalsAgainst}`, match.outcome]),
    [
      ['Jornada 1', true, 'Cesar Nabia FC', '2-2', 'D'],
      ['Jornada 2', false, 'Babacar FC', '9-1', 'W'],
      ['Jornada 3', true, 'Chacal F.C', '4-3', 'W'],
    ],
  );
  assert.equal(ort.played[0]!.venue, 'Pro Fútbol');
});

test('played matches follow the jornada, not the date', () => {
  const delta = team(views(), 'DELTA FC');
  assert.deepEqual(
    delta.played.map((match) => [match.jornada?.order, match.date]),
    [
      [1, '2026-08-22'],
      [2, '2026-08-29'],
      [3, '2026-11-28'],
      [4, '2026-08-29'],
    ],
  );
  assert.equal(delta.played[1]!.outcome, 'L', 'DELTA FC lost 3-4 at home in Jornada 2');
});

test("Universidad ORT Uruguay's 11 remaining opponents appear in jornada order", () => {
  assert.deepEqual(
    team(views(), 'Universidad ORT Uruguay').remaining,
    [
      'TFC',
      'Sportivo Malvin',
      'Ligamentos Cruzeiro',
      'La Axioneta',
      'Montevinas FC',
      'C.A.Ankara',
      'DELTA FC',
      'Real Rejunte',
      'Carechimba FC',
      'Juana Chard',
      'Inter Mitente FC',
    ].map((name) => ({ name, count: 1 })),
  );
});

test('every team has exactly one bye; past ones belong to the four teams on PJ 3', () => {
  const [group] = views();
  for (const view of group!.teams) assert.equal(view.byes.length, 1, `${view.row.name} should have one bye`);

  const past = group!.teams
    .filter((view) => view.byes[0]!.past)
    .map((view) => [view.byes[0]!.jornada.name, view.row.name, view.row.pj])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es', { numeric: true }));
  assert.deepEqual(past, [
    ['Jornada 1', 'Inter Mitente FC', 3],
    ['Jornada 2', 'Sportivo Malvin', 3],
    ['Jornada 3', 'Babacar FC', 3],
    ['Jornada 4', 'Universidad ORT Uruguay', 3],
  ]);

  assert.deepEqual(team([group!], 'TFC').byes, [{ jornada: { id: 5403, name: 'Jornada 15', order: 15 }, past: false }]);
  assert.equal(team([group!], 'Ligamentos Cruzeiro').byes[0]!.jornada.name, 'Jornada 5');
});

test('a partially played jornada keeps its bye upcoming', () => {
  const data = tournamentData();
  // Play one of Jornada 5's games early.
  const jornada5Game = Object.entries(data.jornadas.assignment).find(([, jornadaId]) => jornadaId === 5393)![0];
  const fixture = data.fixture.map((game) =>
    game.id === Number(jornada5Game) ? { ...game, homeGoals: 1, awayGoals: 0 } : game,
  );
  const ligamentos = team(buildGroupViews(data.standings, fixture, data.jornadas), 'Ligamentos Cruzeiro');
  assert.deepEqual(ligamentos.byes, [{ jornada: { id: 5393, name: 'Jornada 5', order: 5 }, past: false }]);
});

test('no byes without jornada assignment, and games then order by date with no jornada label', () => {
  const data = tournamentData();
  const groups = buildGroupViews(data.standings, data.fixture, null);
  for (const view of groups[0]!.teams) assert.deepEqual(view.byes, []);

  const delta = team(groups, 'DELTA FC');
  assert.deepEqual(
    delta.played.map((match) => [match.jornada, match.date]),
    [
      [null, '2026-08-22'],
      [null, '2026-08-29'],
      [null, '2026-08-29'],
      [null, '2026-11-28'],
    ],
  );
});

test('a jornada with no games is not a bye for anyone', () => {
  const data = tournamentData();
  data.jornadas.list.push({ id: 9999, name: 'Jornada 16', order: 16, date: null });
  const [group] = buildGroupViews(data.standings, data.fixture, data.jornadas);
  for (const view of group!.teams) {
    assert.ok(view.byes.every((bye) => bye.jornada.id !== 9999), `${view.row.name} got a bye in an empty jornada`);
  }
});

test('an unlinked team gets no matches and no byes, and keeps its fixture name as an opponent', () => {
  const data = tournamentData();
  const renamed = data.standings.map((group) => ({
    ...group,
    rows: group.rows.map((row) =>
      row.name === 'Babacar FC' ? { ...row, name: 'Babacar Fútbol Club', logo: 'https://example.test/other.png' } : row,
    ),
  }));
  const groups = buildGroupViews(renamed, data.fixture, data.jornadas);

  const babacar = team(groups, 'Babacar Fútbol Club');
  assert.deepEqual(babacar.played, []);
  assert.deepEqual(babacar.byes, []);
  assert.deepEqual(babacar.remaining, []);
  assert.equal(babacar.discrepancy, true, 'PJ 3 with no linked matches');

  const ort = team(groups, 'Universidad ORT Uruguay');
  assert.equal(ort.played[1]!.opponent, 'Babacar FC');
});

test('a renamed team with the same crest is still linked by its logo', () => {
  const data = tournamentData();
  const renamed = data.standings.map((group) => ({
    ...group,
    rows: group.rows.map((row) => (row.name === 'Babacar FC' ? { ...row, name: 'Babacar Fútbol Club' } : row)),
  }));
  const babacar = team(buildGroupViews(renamed, data.fixture, data.jornadas), 'Babacar Fútbol Club');
  assert.equal(babacar.played.length, 3);
  assert.equal(babacar.discrepancy, false);
  assert.equal(team(buildGroupViews(renamed, data.fixture, data.jornadas), 'Universidad ORT Uruguay').played[1]!.opponent, 'Babacar Fútbol Club');
});

test('an opponent faced twice is listed once with a count', () => {
  const data = tournamentData();
  const tfcGame = data.fixture.find(
    (game) => game.home.name === 'TFC' && game.away.name === 'Universidad ORT Uruguay',
  )!;
  const rematch: Game = { ...tfcGame, id: 99_001, home: tfcGame.away, away: tfcGame.home, date: '2026-12-05' };
  const remaining = team(buildGroupViews(data.standings, [...data.fixture, rematch], data.jornadas), 'Universidad ORT Uruguay').remaining;

  assert.deepEqual(remaining[0], { name: 'TFC', count: 2 });
  assert.equal(remaining.length, 11);
});

test('without a fixture, teams have no views and no discrepancy', () => {
  const data = tournamentData();
  const [group] = buildGroupViews(data.standings, null, null);
  for (const view of group!.teams) {
    assert.deepEqual([view.played, view.byes, view.remaining, view.discrepancy], [[], [], [], false]);
  }
});
