/**
 * Entrypoint: load config, restore the snapshot, start the HTTP server, then
 * poll immediately and on a jittered schedule.
 */

import type { FastifyInstance } from 'fastify';

import { ConfigError, loadConfig, type Config } from './config.js';
import { MatchDetailsService } from './details.js';
import { Notifier } from './notify.js';
import { createPollCycle } from './poll.js';
import { Scheduler } from './scheduler.js';
import { createServer } from './server.js';
import { loadSnapshot, TournamentStore } from './store.js';
import { createSender } from './telegram.js';
import { createFetcher, RateLimitState } from './upstream.js';

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const startedAt = Date.now();
  const store = new TournamentStore(config.upstream.tournamentId);
  const rateLimit = new RateLimitState();
  const fetchJson = createFetcher(config.upstream);

  // The details service and the poll log through the server's logger, created just below.
  let app: FastifyInstance | undefined;
  const log = {
    info: (message: string) => app?.log.info(message),
    warn: (message: string) => app?.log.warn(message),
  };

  const details = new MatchDetailsService({ config, store, fetchJson, rateLimit, log });
  let scheduler: Scheduler | undefined;
  app = createServer({ config, store, details, rateLimit, nextPollAt: () => scheduler?.nextRunAt ?? null });

  await loadSnapshot(store, config.snapshotPath, log);

  const notifier = new Notifier(
    createSender(config, log),
    log,
    config.telegram.maxMessagesPerPoll,
    config.siteUrl,
    config.timeZone,
  );

  scheduler = new Scheduler({
    intervalMs: config.poll.intervalMinutes * 60_000,
    jitterMs: config.poll.jitterSeconds * 1_000,
    onError: (error) => log.warn(`poll failed unexpectedly: ${(error as Error)?.message ?? error}`),
    run: createPollCycle({
      config,
      store,
      fetchJson,
      rateLimit,
      log,
      startedAt,
      notifier,
      details,
      snapshotPath: config.snapshotPath,
    }),
  });

  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(
    `tournament ${config.upstream.tournamentId}: polling every ${config.poll.intervalMinutes} min ±${config.poll.jitterSeconds}s, ` +
      `jornadas every ${config.poll.jornadaRefreshMinutes} min; notifications ${notifier.enabled ? 'on' : 'off'}`,
  );

  // Registered before the first poll: with a jornada refresh it takes several seconds, and a
  // deploy that stops the container meanwhile should still close the server cleanly.
  const shutdown = async (signal: string) => {
    app?.log.info(`${signal} received, shutting down`);
    scheduler?.stop();
    await app?.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await scheduler.start();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
