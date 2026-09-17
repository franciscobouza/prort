import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { loadSnapshot, saveSnapshot, TournamentStore } from '../src/store.js';
import { parseFixture, parseStandings, parseTournament } from '../src/upstream.js';
import { gamesPayload, positionsPayload, tournamentPayload } from './fixtures.js';

const standings = parseStandings(positionsPayload);
const fixture = parseFixture(gamesPayload);
const tournament = parseTournament(tournamentPayload);

const messages: string[] = [];
const log = { info: (message: string) => messages.push(message), warn: (message: string) => messages.push(message) };

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prort-store-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a new store is cold and empty', () => {
  const store = new TournamentStore(549);
  assert.equal(store.isCold, true);
  assert.equal(store.standings(), null);
  assert.equal(store.lastSuccessAt(), null);
  assert.equal(store.anyFeedFailing(), false);
});

test('a failure keeps the previous data and timestamp of that feed only', () => {
  const store = new TournamentStore(549);
  store.record('standings', standings, '2026-09-17T10:00:00.000Z');
  store.record('fixture', fixture, '2026-09-17T10:00:00.000Z');

  store.record('standings', standings, '2026-09-17T10:05:00.000Z');
  store.recordFailure('fixture', 'unexpected status 500');

  assert.equal(store.feed('standings').fetchedAt, '2026-09-17T10:05:00.000Z');
  assert.equal(store.feed('standings').lastAttemptFailed, false);

  assert.equal(store.fixture(), fixture);
  assert.equal(store.feed('fixture').fetchedAt, '2026-09-17T10:00:00.000Z');
  assert.equal(store.feed('fixture').lastAttemptFailed, true);
  assert.equal(store.feed('fixture').lastError, 'unexpected status 500');

  assert.deepEqual(store.failingFeeds(), ['fixture']);
});

test('a success after a failure clears the failure', () => {
  const store = new TournamentStore(549);
  store.recordFailure('standings', 'rate limited');
  store.record('standings', standings, '2026-09-17T10:05:00.000Z');
  assert.equal(store.anyFeedFailing(), false);
});

test('the last success considers only the live feeds', () => {
  const store = new TournamentStore(549);
  store.record('standings', standings, '2026-09-17T10:00:00.000Z');
  store.record('fixture', fixture, '2026-09-17T10:02:00.000Z');
  store.record('tournament', tournament, '2026-09-17T10:09:00.000Z');
  assert.equal(store.lastSuccessAt(), '2026-09-17T10:02:00.000Z');
});

test('a snapshot round-trips and warms the store', async () => {
  const path = join(dir, 'nested', 'snapshot.json');
  const store = new TournamentStore(549);
  store.record('standings', standings, '2026-09-17T10:00:00.000Z');
  store.record('fixture', fixture, '2026-09-17T10:00:00.000Z');
  store.record('tournament', tournament, '2026-09-17T10:00:00.000Z');
  store.record('jornadas', { list: [], assignment: { 30248: 5392 }, fixtureIds: [30248] }, '2026-09-17T10:00:00.000Z');
  await saveSnapshot(store, path, log);

  const restored = new TournamentStore(549);
  assert.equal(await loadSnapshot(restored, path, log), true);
  assert.equal(restored.isCold, false);
  assert.deepEqual(restored.standings(), standings);
  assert.deepEqual(restored.fixture(), fixture);
  assert.deepEqual(restored.jornadas()?.assignment, { 30248: 5392 });
  assert.equal(restored.feed('fixture').fetchedAt, '2026-09-17T10:00:00.000Z');

  const onDisk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(onDisk.tournamentId, 549);
});

test('a missing, corrupt or unusable snapshot starts cold without throwing', async () => {
  const store = new TournamentStore(549);
  assert.equal(await loadSnapshot(store, join(dir, 'nope.json'), log), false);

  const corrupt = join(dir, 'corrupt.json');
  await writeFile(corrupt, '{"version": 1, "feeds": ');
  assert.equal(await loadSnapshot(store, corrupt, log), false);

  const unusable = join(dir, 'unusable.json');
  await writeFile(unusable, JSON.stringify({ version: 1, tournamentId: 549, feeds: { standings: { data: 'x' } } }));
  assert.equal(await loadSnapshot(store, unusable, log), false);

  assert.equal(store.isCold, true);
});

test('a snapshot from another tournament is ignored', async () => {
  const path = join(dir, 'other.json');
  const old = new TournamentStore(548);
  old.record('standings', standings, '2026-09-17T10:00:00.000Z');
  await saveSnapshot(old, path, log);

  const store = new TournamentStore(549);
  messages.length = 0;
  assert.equal(await loadSnapshot(store, path, log), false);
  assert.equal(store.isCold, true);
  assert.equal(store.standings(), null);
  assert.ok(messages.some((message) => message.includes('another tournament')));
});

test('a snapshot that cannot be written is logged, not thrown', async () => {
  const blocker = join(dir, 'a-file');
  await writeFile(blocker, 'not a directory');
  const store = new TournamentStore(549);

  messages.length = 0;
  await saveSnapshot(store, join(blocker, 'snapshot.json'), log);
  assert.ok(messages.some((message) => message.startsWith('could not write snapshot')));
});
