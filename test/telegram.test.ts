import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { loadConfig } from '../src/config.js';
import { Notifier } from '../src/notify.js';
import { createSender, sendAll } from '../src/telegram.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const silent = { info: () => {}, warn: () => {} };

const configured = () => loadConfig({ TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN', TELEGRAM_CHAT_ID: '42' });

function stubFetch(responses: (Response | Error)[]): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  let index = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { calls };
}

const emptyStartup = { tournamentName: null, groups: null, lastSuccessAt: null };
const emptyChanges = { tournamentName: null, results: [], standings: [], jornadaOf: () => null, groupCount: 1 };

test('no sender is created when telegram is unconfigured', () => {
  assert.equal(createSender(loadConfig({}), silent), null);
});

test('a successful send posts to the bot api once', async () => {
  const { calls } = stubFetch([new Response('{"ok":true}', { status: 200 })]);
  const send = createSender(configured(), silent);

  assert.ok(send);
  assert.equal(await send('hola'), true);
  assert.equal(calls.length, 1);

  const body = JSON.parse(String(calls[0]?.body));
  assert.equal(body.chat_id, '42');
  assert.equal(body.text, 'hola');
  assert.equal(body.parse_mode, 'HTML');
});

test('a 5xx is retried up to three times', async () => {
  const { calls } = stubFetch([new Response('nope', { status: 503 })]);
  const send = createSender(configured(), silent);

  assert.equal(await send!('hola'), false);
  assert.equal(calls.length, 3);
});

test('a 4xx fails fast without retrying', async () => {
  const { calls } = stubFetch([new Response('bad token', { status: 401 })]);
  const send = createSender(configured(), silent);

  assert.equal(await send!('hola'), false);
  assert.equal(calls.length, 1);
});

test("a refusal logs Telegram's own reason, with the token scrubbed", async () => {
  const warnings: string[] = [];
  const log = { info: () => {}, warn: (message: string) => warnings.push(message) };
  stubFetch([
    Response.json({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, { status: 400 }),
    Response.json({ ok: false, error_code: 401, description: 'Unauthorized for 123456:TEST-TOKEN' }, { status: 401 }),
  ]);
  const send = createSender(configured(), log);

  assert.equal(await send!('hola'), false);
  assert.equal(await send!('hola'), false);
  assert.deepEqual(warnings, [
    'telegram rejected the message (400: Bad Request: chat not found), giving up',
    'telegram rejected the message (401: Unauthorized for [token]), giving up',
  ]);
});

test('a network error is retried and then gives up quietly', async () => {
  const { calls } = stubFetch([new Error('ECONNRESET')]);
  const send = createSender(configured(), silent);

  assert.equal(await send!('hola'), false);
  assert.equal(calls.length, 3);
});

test('sendAll stops at the first failure so the sequence stays coherent', async () => {
  const attempted: string[] = [];
  const sent = await sendAll(async (text) => {
    attempted.push(text);
    return text !== 'dos';
  }, ['uno', 'dos', 'tres']);

  assert.equal(sent, 1);
  assert.deepEqual(attempted, ['uno', 'dos']);
});

test('a delivery failure never throws out of the notifier', async () => {
  const notifier = new Notifier(
    async () => {
      throw new Error('telegram is on fire');
    },
    silent,
    5,
    '',
  );
  await notifier.notifyStartup(emptyStartup);
});

test('an unconfigured notifier is a no-op', async () => {
  const notifier = new Notifier(null, silent, 5, '');
  assert.equal(notifier.enabled, false);
  await notifier.notifyStartup(emptyStartup);
  await notifier.notifyChanges(emptyChanges);
});
