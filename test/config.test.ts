import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ConfigError, loadConfig } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'expected a ConfigError');
    return error.problems;
  }
  assert.fail('expected the configuration to be rejected');
}

/** The same KEY=VALUE reading Node's --env-file does, enough for .env.example. */
function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]!] = match[2]!.trim();
  }
  return env;
}

test('defaults target tournament 549 on LigaPro with the documented cadence', () => {
  const config = loadConfig({});

  assert.equal(config.upstream.baseUrl, 'https://www.ligapro.uy');
  assert.equal(config.upstream.tournamentId, 549);
  assert.equal(config.upstream.timeoutMs, 10_000);
  assert.match(config.upstream.userAgent, /^prort\//);
  assert.deepEqual(config.poll, { intervalMinutes: 5, jitterSeconds: 30, jornadaRefreshMinutes: 60 });
  assert.deepEqual(config.details, { ttlMinutes: 15, requestsPerMinute: 20 });
  assert.deepEqual(config.server, { port: 3000, host: '0.0.0.0', logLevel: 'info' });
  assert.equal(config.timeZone, 'America/Montevideo');
  assert.equal(config.snapshotPath, './data/snapshot.json');
  assert.deepEqual(config.telegram, { enabled: false, maxMessagesPerPoll: 5 });
  assert.equal(config.siteUrl, '');
});

test('values are read from the environment and the base URL loses its trailing slash', () => {
  const config = loadConfig({
    UPSTREAM_BASE_URL: 'http://localhost:4000/',
    UPSTREAM_TOURNAMENT_ID: '550',
    POLL_INTERVAL_MINUTES: '2',
    POLL_JITTER_SECONDS: '0',
    JORNADA_REFRESH_MINUTES: '30',
    MATCH_DETAILS_TTL_MINUTES: '5',
    MATCH_DETAILS_REQUESTS_PER_MINUTE: '12',
    TELEGRAM_BOT_TOKEN: '123:abc',
    TELEGRAM_CHAT_ID: '42',
    SITE_URL: 'https://prort.example',
  });

  assert.equal(config.upstream.baseUrl, 'http://localhost:4000');
  assert.equal(config.upstream.tournamentId, 550);
  assert.deepEqual(config.poll, { intervalMinutes: 2, jitterSeconds: 0, jornadaRefreshMinutes: 30 });
  assert.deepEqual(config.details, { ttlMinutes: 5, requestsPerMinute: 12 });
  assert.deepEqual(config.telegram, {
    enabled: true,
    botToken: '123:abc',
    chatId: '42',
    maxMessagesPerPoll: 5,
  });
  assert.equal(config.siteUrl, 'https://prort.example');
});

test('a tournament id that is not a positive integer is rejected by name', () => {
  for (const value of ['abc', '0', '-1', '1.5', '549abc']) {
    const problems = problemsOf({ UPSTREAM_TOURNAMENT_ID: value });
    assert.ok(
      problems.some((problem) => problem.startsWith('UPSTREAM_TOURNAMENT_ID')),
      `${value} should be reported`,
    );
  }
});

test('a base URL that is not http(s) is rejected by name', () => {
  for (const value of ['ftp://www.ligapro.uy', 'not a url']) {
    const problems = problemsOf({ UPSTREAM_BASE_URL: value });
    assert.ok(problems.some((problem) => problem.startsWith('UPSTREAM_BASE_URL')), `${value} should be reported`);
  }
});

test('half-configured Telegram is rejected in both directions', () => {
  for (const env of [{ TELEGRAM_BOT_TOKEN: '123:abc' }, { TELEGRAM_CHAT_ID: '42' }]) {
    const problems = problemsOf(env);
    assert.ok(problems.some((problem) => problem.includes('must be set together')));
  }
});

test('an unknown timezone is rejected', () => {
  const problems = problemsOf({ DISPLAY_TIMEZONE: 'Mars/Olympus_Mons' });
  assert.ok(problems.some((problem) => problem.startsWith('DISPLAY_TIMEZONE')));
});

test('every problem is reported at once', () => {
  const problems = problemsOf({
    UPSTREAM_TOURNAMENT_ID: 'x',
    POLL_JITTER_SECONDS: '-5',
    MATCH_DETAILS_REQUESTS_PER_MINUTE: '1',
    LOG_LEVEL: 'loud',
  });
  assert.equal(problems.length, 4);
});

test('.env.example, copied as-is, loads without problems and sets every variable config reads', () => {
  const env = readEnvFile(join(root, '.env.example'));
  const config = loadConfig(env);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.siteUrl, '');

  const source = readFileSync(join(root, 'src', 'config.ts'), 'utf8');
  // Environment keys only ever appear as `env.KEY` or as a quoted 'KEY' literal.
  const read = new Set([...source.matchAll(/(?:env\.|')([A-Z][A-Z0-9_]+)\b/g)].map((match) => match[1]!));
  for (const key of read) {
    assert.ok(key in env, `.env.example is missing ${key}`);
  }
  for (const key of Object.keys(env)) {
    assert.ok(read.has(key), `.env.example documents ${key}, which config.ts never reads`);
  }
});
