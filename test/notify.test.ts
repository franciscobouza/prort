import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jornadaLookup } from '../src/aggregate.js';
import { loadConfig } from '../src/config.js';
import { MatchDetailsService } from '../src/details.js';
import { diffResults, diffStandings, type ResultChange, type TeamChange } from '../src/diff.js';
import type { Game, StandingsGroup, TeamRow } from '../src/model.js';
import { buildChangeMessages, buildStartupMessage, type ChangeReport } from '../src/notify.js';
import { TournamentStore } from '../src/store.js';
import { packMessages, TELEGRAM_MAX_CHARS } from '../src/telegram.js';
import { RateLimitState } from '../src/upstream.js';
import { matchPayload, tournamentData } from './fixtures.js';

const data = tournamentData();
const jornadaOf = jornadaLookup(data.jornadas);
const TOURNAMENT = 'Serie 4 / Divisional B / Clausura 2026';

const report = (over: Partial<ChangeReport>): ChangeReport => ({
  tournamentName: TOURNAMENT,
  results: [],
  standings: [],
  jornadaOf,
  groupCount: 1,
  ...over,
});

/** Jornada 5 played in full, and every team that played moving in the table. */
function wholeJornada(): { results: ResultChange[]; standings: TeamChange[] } {
  const jornada5 = new Set(
    Object.entries(data.jornadas.assignment)
      .filter(([, jornadaId]) => jornadaId === 5393)
      .map(([gameId]) => Number(gameId)),
  );
  const after: Game[] = data.fixture.map((game) =>
    jornada5.has(game.id) ? { ...game, homeGoals: 2, awayGoals: 1 } : game,
  );
  const results = diffResults(data.fixture, after);

  const playing = new Set(
    data.fixture.filter((game) => jornada5.has(game.id)).flatMap((game) => [game.home.name, game.away.name]),
  );
  const moved: StandingsGroup[] = data.standings.map((group) => ({
    ...group,
    rows: group.rows.map((row) => (playing.has(row.name) ? { ...row, pj: row.pj + 1, gf: row.gf + 1 } : row)),
  }));
  return { results, standings: diffStandings(data.standings, moved) };
}

test('a whole jornada landing at once reports all 7 results and all 14 teams exactly once', () => {
  const { results, standings } = wholeJornada();
  assert.equal(results.length, 7);
  assert.equal(standings.length, 14);

  const text = buildChangeMessages(report({ results, standings }), 5, '').join('\n');
  for (const change of results) {
    const line = `⚽ Jornada 5: ${change.game.home.name} 2-1 ${change.game.away.name}`;
    assert.equal(text.split(line).length - 1, 1, `"${line}" should appear exactly once`);
  }
  for (const change of standings) {
    assert.equal(text.split(`📊 ${change.team.name}:`).length - 1, 1, `${change.team.name} should appear exactly once`);
  }
});

test('result lines come first, ordered by jornada, and name the service and tournament', () => {
  const { results, standings } = wholeJornada();
  const corrected = diffResults(data.fixture, data.fixture.map((game) => (game.id === 30258 ? { ...game, awayGoals: 10 } : game)));
  const [message] = buildChangeMessages(report({ results: [...results, ...corrected], standings }), 5, '');

  const lines = message!.split('\n');
  assert.equal(lines[0], `🏆 <b>prort</b> · Cambios · ${TOURNAMENT}`);
  assert.equal(lines[1], '✏️ Resultado corregido — Jornada 2: Babacar FC 1-10 Universidad ORT Uruguay (antes 1-9)');
  assert.match(lines[2]!, /^⚽ Jornada 5: /);
  assert.match(lines.at(-1)!, /^📊 /);
});

test('a cleared result shows the score it had, and an unknown jornada drops the prefix', () => {
  const cleared = diffResults(data.fixture, data.fixture.map((game) => (game.id === 30258 ? { ...game, homeGoals: null, awayGoals: null } : game)));
  const [known] = buildChangeMessages(report({ results: cleared }), 5, '');
  assert.match(known!, /↩️ Resultado anulado — Jornada 2: Babacar FC vs Universidad ORT Uruguay \(era 1-9\)/);

  const [unknown] = buildChangeMessages(report({ results: cleared, jornadaOf: () => null }), 5, '');
  assert.match(unknown!, /↩️ Resultado anulado — Babacar FC vs Universidad ORT Uruguay \(era 1-9\)/);
});

test('team lines show every moved value, PPerd included, and the official position movement', () => {
  const after = data.standings.map((group) => ({
    ...group,
    rows: group.rows.map((row) => (row.id === 893 ? { ...row, pj: 4, pp: 4, gf: 4, gc: 18, position: 15 } : row)),
  }));
  const [message] = buildChangeMessages(report({ standings: diffStandings(data.standings, after) }), 5, '');
  assert.match(message!, /📊 Babacar FC: PJ 3→4, PP 3→4, GF 3→4, GC 16→18, PPerd 9→12/);
});

test('result lines never carry scorers, even when that match\'s details are cached', async () => {
  const store = new TournamentStore(549);
  store.record('fixture', data.fixture, '2026-09-17T12:00:00.000Z');
  store.record('jornadas', data.jornadas, '2026-09-17T12:00:00.000Z');
  const details = new MatchDetailsService({
    config: loadConfig({}),
    store,
    fetchJson: async (url) => {
      const [, gameId, part] = /\/api\/games\/(\d+)\/(info|events|mvps)$/.exec(url)!;
      return matchPayload(Number(gameId), part as 'info' | 'events' | 'mvps');
    },
    rateLimit: new RateLimitState(),
    log: { info: () => {}, warn: () => {} },
  });
  const cached = await details.get(30258);
  const players = [
    ...cached!.timeline!.map((event) => event.player).filter((player): player is string => player !== null),
    ...cached!.featuredPlayers.map((player) => player.name),
  ];
  assert.ok(players.length > 5);

  const corrected = diffResults(data.fixture, data.fixture.map((game) => (game.id === 30258 ? { ...game, awayGoals: 10 } : game)));
  const text = buildChangeMessages(report({ results: corrected }), 5, '').join('\n');
  for (const player of players) assert.ok(!text.includes(player), `${player} must not appear in a result line`);
});

test('group sub-headers appear only when there is more than one group', () => {
  const standings = diffStandings(
    data.standings,
    data.standings.map((group) => ({ ...group, rows: group.rows.map((row) => (row.id === 997 ? { ...row, pts: 8 } : row)) })),
  );
  const [single] = buildChangeMessages(report({ standings }), 5, '');
  assert.ok(!single!.includes('<b>Divisional B</b>'));

  const [multiple] = buildChangeMessages(report({ standings, groupCount: 2 }), 5, '');
  assert.match(multiple!, /<b>Divisional B<\/b>\n📊 Universidad ORT Uruguay/);
});

test('a poll with no changes sends nothing', () => {
  assert.deepEqual(buildChangeMessages(report({}), 5, ''), []);
});

test('every message stays inside the Telegram size limit, parts numbered in order', () => {
  const { results, standings } = wholeJornada();
  const many = Array.from({ length: 30 }, () => [...results, ...standings]).flat();
  const messages = buildChangeMessages(
    report({ results: many.filter((c): c is ResultChange => 'game' in c), standings: many.filter((c): c is TeamChange => 'team' in c) }),
    20,
    '',
  );
  assert.ok(messages.length > 1);
  messages.forEach((message, index) => {
    assert.ok(message.length <= TELEGRAM_MAX_CHARS, `message of ${message.length} chars is too long`);
    assert.match(message, new RegExp(`\\(${index + 1}/${messages.length}\\)`));
  });
});

test('splitting is bounded and says how much it left out, pointing to the site', () => {
  const entries = Array.from({ length: 4000 }, (_, index) => `entrada ${index} con bastante texto de relleno`);
  const messages = packMessages('cabecera', entries, 2, 'https://prort.example');
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /cambio\(s\) más/);
  assert.match(messages[1]!, /prort\.example/);
});

test('the startup message shows the tournament, the top of the table with PPerd, and local time', () => {
  const message = buildStartupMessage(
    { tournamentName: TOURNAMENT, groups: data.standings, lastSuccessAt: '2026-09-17T01:12:00.000Z' },
    'https://prort.example',
  );
  assert.equal(
    message,
    [
      '♻️ <b>prort reiniciado</b>',
      TOURNAMENT,
      '',
      '<b>Divisional B</b>',
      '1. Real Rejunte — 10 pts (PPerd 2)',
      '2. C.A.Ankara — 8 pts (PPerd 4)',
      '3. DELTA FC — 7 pts (PPerd 5)',
      '',
      'actualizado 16/09 22:12',
      'https://prort.example',
    ].join('\n'),
  );
});

test('the site URL is HTML-escaped, so an & in it cannot make Telegram refuse the message', () => {
  const url = 'https://prort.example/?torneo=549&vista=tabla';
  const startup = buildStartupMessage({ tournamentName: TOURNAMENT, groups: null, lastSuccessAt: null }, url);
  assert.match(startup, /https:\/\/prort\.example\/\?torneo=549&amp;vista=tabla$/);

  // Enough changes to overflow one message, so the last one carries the "ver <site>" pointer.
  const { results, standings } = wholeJornada();
  const bounded = buildChangeMessages(report({ results, standings: [...standings, ...Array(300).fill(standings[0])] }), 1, url);
  assert.match(bounded.at(-1)!, /ver https:\/\/prort\.example\/\?torneo=549&amp;vista=tabla/);
});

test('the startup message copes with no data yet', () => {
  const message = buildStartupMessage({ tournamentName: null, groups: null, lastSuccessAt: null }, '');
  assert.match(message, /sin datos todavía/);
  assert.match(message, /sin actualización registrada/);
});

test('no secret ever reaches the message text', () => {
  const secret = '123456:SUPER-SECRET-BOT-TOKEN';
  const config = loadConfig({ TELEGRAM_BOT_TOKEN: secret, TELEGRAM_CHAT_ID: '42', SITE_URL: 'https://prort.example' });
  const { results, standings } = wholeJornada();
  const text = [
    ...buildChangeMessages(report({ results, standings }), config.telegram.maxMessagesPerPoll, config.siteUrl),
    buildStartupMessage({ tournamentName: TOURNAMENT, groups: data.standings, lastSuccessAt: null }, config.siteUrl),
  ].join('\n');
  assert.ok(!text.includes(secret));
  assert.ok(!/bot\d+:/i.test(text));
});

test('team names are HTML-escaped', () => {
  const evil: TeamRow = { ...data.standings[0]!.rows[0]!, name: '<script>x</script>' };
  const before = [{ name: null, rows: [evil] }];
  const after = [{ name: null, rows: [{ ...evil, pts: 11 }] }];
  const text = buildChangeMessages(report({ standings: diffStandings(before, after) }), 5, '').join('\n');
  assert.ok(!text.includes('<script>'));
  assert.match(text, /&lt;script&gt;/);
});
