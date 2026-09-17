import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { MatchDetailsService } from '../src/details.js';
import { createServer } from '../src/server.js';
import { TournamentStore } from '../src/store.js';
import { RateLimitState, type JsonFetcher } from '../src/upstream.js';
import { matchPayload, tournamentData } from './fixtures.js';

const silent = { info: () => {}, warn: () => {} };
const AT = '2026-09-17T12:00:00.000Z';

type Feeds = { tournament?: boolean; standings?: boolean; fixture?: boolean; jornadas?: boolean };

function harness(feeds: Feeds = { tournament: true, standings: true, fixture: true, jornadas: true }) {
  const config = loadConfig({ UPSTREAM_BASE_URL: 'http://upstream.test', LOG_LEVEL: 'silent' });
  const store = new TournamentStore(549);
  const data = tournamentData();
  if (feeds.tournament) store.record('tournament', data.tournament, AT);
  if (feeds.standings) store.record('standings', data.standings, AT);
  if (feeds.fixture) store.record('fixture', data.fixture, AT);
  if (feeds.jornadas) store.record('jornadas', data.jornadas, AT);

  const calls: string[] = [];
  const fetchJson: JsonFetcher = async (url) => {
    calls.push(url);
    const [, gameId, part] = /\/api\/games\/(\d+)\/(info|events|mvps)$/.exec(url)!;
    return matchPayload(Number(gameId), part as 'info' | 'events' | 'mvps');
  };

  const clock = Date.parse('2026-09-17T12:03:00.000Z');
  const rateLimit = new RateLimitState();
  const details = new MatchDetailsService({ config, store, fetchJson, rateLimit, log: silent, now: () => clock });
  const app = createServer({
    config,
    store,
    details,
    rateLimit,
    nextPollAt: () => '2026-09-17T12:05:00.000Z',
    now: () => clock,
  });
  return { app, store, calls, rateLimit, clock };
}

/** The panel row of one team, from its opening tag to the next team row. */
function panelOf(html: string, teamId: number): string {
  const start = html.indexOf(`<tr class="details" id="p-t0-${teamId}"`);
  assert.ok(start !== -1, `panel for team ${teamId} not found`);
  const end = html.indexOf('<tr data-pos=', start);
  return html.slice(start, end === -1 ? undefined : end);
}

test('the page renders every team, the tournament header and the freshness line, before any JavaScript', async () => {
  const { app } = harness();
  const response = await app.inject('/');
  const html = response.body;

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /text\/html/);
  assert.equal(response.headers['cache-control'], 'public, max-age=30');

  assert.match(html, /<h1>Serie 4 \/ Divisional B \/ Clausura 2026<\/h1>/);
  assert.match(html, /22\/08\/2026 – 12\/12\/2026 · Jornada 4 de 15 · <a href="http:\/\/upstream\.test\/campeonatos\/549"/);
  assert.match(html, /Última actualización: 17\/09 09:00 · se consulta cada ~5 min\./);
  assert.match(html, /<h2>Divisional B<\/h2>/);

  for (const name of ['Real Rejunte', 'Universidad ORT Uruguay', 'La Axioneta', 'Babacar FC']) {
    assert.ok(html.includes(name), `${name} missing`);
  }
  assert.equal(html.match(/class="toggle"/g)?.length, 15);
  assert.equal(html.match(/<tr class="details"/g)?.length, 15);
  assert.match(html, /<td class="pperd" data-sort="2">2<\/td>/);
  assert.match(html, /<td data-sort="22">\+22<\/td>/, 'positive DG carries a sign');
  assert.match(html, /<noscript><style>\.details\{display:table-row !important\}/);
  assert.ok(!/https?:\/\/(?!upstream\.test)[^"\s]+\.(css|js|png|jpg|woff2?)/.test(html), 'no external assets');
});

test("a team's panel holds its matches with detail links, its past bye in place, and its remaining opponents collapsed", async () => {
  const { app } = harness();
  const html = (await app.inject('/')).body;

  const ort = panelOf(html, 997);
  const rows = [...ort.matchAll(/<tr class="(match|bye)">\s*<td class="md" title="([^"]+)">/g)].map((match) => `${match[2]} ${match[1]}`);
  assert.deepEqual(rows, ['Jornada 1 match', 'Jornada 2 match', 'Jornada 3 match', 'Jornada 4 bye']);
  assert.match(ort, /<a class="match-link" href="\/partido\/30258"[^>]*aria-expanded="false"[^>]*><strong>9<\/strong>-1<\/a>/);
  assert.match(ort, /<td class="libre" colspan="6">Libre<\/td>/);
  assert.match(ort, /<details class="remaining"><summary>Le quedan 11 rivales<\/summary><p>TFC, Sportivo Malvin, Ligamentos Cruzeiro, La Axioneta,/);
  assert.ok(!ort.includes('class="warn"'), 'feeds agree, so no discrepancy note');

  const tfc = panelOf(html, 275);
  assert.match(tfc, /<summary>Le quedan 10 rivales · libre en Jornada 15<\/summary>/);
  assert.ok(!tfc.includes('class="bye"'), 'an upcoming bye is not a row');
});

test('upstream strings are HTML-escaped', async () => {
  const { app, store } = harness();
  const standings = store.standings()!.map((group) => ({
    ...group,
    rows: group.rows.map((row) => (row.id === 211 ? { ...row, name: '<img src=x onerror=alert(1)>' } : row)),
  }));
  store.record('standings', standings, AT);

  const html = (await app.inject('/')).body;
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('without tournament info the title falls back to the tournament id', async () => {
  const { app } = harness({ standings: true, fixture: true, jornadas: true });
  const html = (await app.inject('/')).body;
  assert.match(html, /<h1>Campeonato 549<\/h1>/);
  assert.ok(!html.includes('Jornada 4 de 15'));
});

test('before any data the page still answers 200 with an explicit message', async () => {
  const { app } = harness({});
  const response = await app.inject('/');
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Todavía no se pudieron obtener los datos de LigaPro/);
  assert.match(response.body, /Datos posiblemente desactualizados/);
});

test('standings without a fixture render without selectable teams', async () => {
  const { app } = harness({ tournament: true, standings: true });
  const html = (await app.inject('/')).body;
  assert.ok(html.includes('Universidad ORT Uruguay'));
  assert.ok(!html.includes('class="toggle"'));
  assert.ok(!html.includes('<tr class="details"'));
});

test('failures and backoffs are visible in the banner', async () => {
  const failing = harness();
  failing.store.recordFailure('fixture', 'unexpected status 500');
  assert.match((await failing.app.inject('/')).body, /Datos posiblemente desactualizados \(el último intento falló\) — última actualización correcta: 17\/09 09:00/);

  const limited = harness();
  limited.rateLimit.onRateLimited(5 * 60_000, null, limited.clock);
  assert.match((await limited.app.inject('/')).body, /LigaPro está limitando las consultas; próximo intento 17\/09 09:13/);
});

test('a match that is not a played game of the tournament is a 404 that never reaches upstream', async () => {
  const { app, calls } = harness();
  for (const path of ['/partido/30265', '/partido/1', '/partido/abc', '/api/matches/30265', '/api/matches/-5']) {
    const response = await app.inject(path);
    assert.equal(response.statusCode, 404, path);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const fragment = await app.inject('/partido/30265?embed=1');
  assert.equal(fragment.statusCode, 404);
  assert.ok(!fragment.body.includes('<html'));
  assert.deepEqual(calls, []);
});

test('a match detail page is complete without JavaScript; the embed is just the fragment', async () => {
  const { app } = harness();
  const page = await app.inject('/partido/30248');
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers['cache-control'], 'public, max-age=60');
  assert.match(page.body, /^<!doctype html>/);
  assert.match(page.body, /<a href="\/">← Volver a la tabla<\/a>/);
  assert.match(page.body, /<h1>La Axioneta 1-10 Carechimba FC<\/h1>/);
  assert.match(page.body, /Serie 4 \/ Divisional B \/ Clausura 2026 · Jornada 4/);
  assert.match(page.body, /29\/08\/2026 · Pro Fútbol/);
  assert.match(page.body, /<li class="period">Primer tiempo<\/li><li class="ev away kind-goal"><span class="min">05'<\/span>/);
  assert.match(page.body, /Figura: Santiago Rodriguez <span class="muted">\(La Axioneta\)<\/span>/);
  assert.match(page.body, /href="http:\/\/upstream\.test\/juego\/30248"/);
  assert.ok(!page.body.includes('<script>'), 'the detail page needs no script');

  const fragment = await app.inject('/partido/30248?embed=1');
  assert.match(fragment.body, /^<article class="match-card">/);
  assert.ok(!fragment.body.includes('<html'));
});

test('the detail says what it lacks: unrecorded scorers, no events, cards', async () => {
  const { app } = harness();
  assert.match((await app.inject('/partido/30258?embed=1')).body, /1 gol de Universidad ORT Uruguay sin autor registrado\./);
  assert.match((await app.inject('/partido/30240?embed=1')).body, /2 goles de La Axioneta sin autor registrado\./);

  const walkover = (await app.inject('/partido/30237?embed=1')).body;
  assert.match(walkover, /No hay eventos registrados para este partido\./);
  assert.ok(!walkover.includes('sin autor registrado'));

  const cards = (await app.inject('/partido/30259?embed=1')).body;
  assert.match(cards, /🟥 Roja<\/span> <span class="who">Federico DELGADO<\/span>/);
  assert.match(cards, /Figuras: Martin Leguisamo <span class="muted">\(DELTA FC\)<\/span>, Claudio Castagnin <span class="muted">\(Real Rejunte\)<\/span>/);
});

test('an unavailable detail shows the basic match and is not cached by browsers', async () => {
  const { app, rateLimit, clock, calls } = harness();
  rateLimit.onRateLimited(5 * 60_000, null, clock);
  const response = await app.inject('/partido/30248?embed=1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.body, /La Axioneta<\/span> <strong>1 - 10<\/strong>/);
  assert.match(response.body, /no está disponible por ahora/);
  assert.deepEqual(calls, []);
});

test('match details as JSON', async () => {
  const { app } = harness();
  const response = await app.inject('/api/matches/30258');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'fresh');
  assert.deepEqual(
    [body.match.home, body.match.homeGoals, body.match.awayGoals, body.match.away, body.match.jornada.name],
    ['Babacar FC', 1, 9, 'Universidad ORT Uruguay', 'Jornada 2'],
  );
  assert.equal(body.timeline.length, 9);
  assert.deepEqual(body.missingGoals, { home: 0, away: 1 });
  assert.equal(body.noEvents, false);
  assert.deepEqual(body.featuredPlayers, [
    { name: 'Mateo Mandiá Sapone', side: 'home' },
    { name: 'Mauro Rodríguez', side: 'away' },
  ]);
  assert.equal(body.fetchedAt, '2026-09-17T12:03:00.000Z');
});

test('the standings as JSON carry PPerd and every team view', async () => {
  const { app } = harness();
  const body = (await app.inject('/api/standings')).json();

  assert.equal(body.tournament.name, 'Serie 4 / Divisional B / Clausura 2026');
  assert.deepEqual(body.currentJornada, { name: 'Jornada 4', position: 4, total: 15 });
  assert.equal(body.freshness.nextPollAt, '2026-09-17T12:05:00.000Z');
  assert.equal(body.groups[0].teams.length, 15);

  const ort = body.groups[0].teams.find((team: { id: number }) => team.id === 997);
  assert.deepEqual([ort.position, ort.pts, ort.pperd, ort.played.length, ort.remaining.length, ort.discrepancy], [4, 7, 2, 3, 11, false]);
  assert.deepEqual(ort.byes, [{ jornada: { id: 5392, name: 'Jornada 4', order: 4 }, past: true }]);
});

test('health reports every feed, the backoff and the next poll', async () => {
  const { app } = harness();
  const response = await app.inject('/health');
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.tournamentId, 549);
  assert.deepEqual(Object.keys(body.feeds), ['tournament', 'standings', 'fixture', 'jornadas']);
  assert.deepEqual(body.feeds.fixture, { fetchedAt: AT, lastAttemptFailed: false });
  assert.deepEqual(body.rateLimit, { active: false, until: null });
  assert.equal(body.nextPollAt, '2026-09-17T12:05:00.000Z');
});

test('the favicon is served so the page makes no failing request', async () => {
  const response = await harness().app.inject('/favicon.ico');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/x-icon');
});
