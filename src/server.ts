/**
 * HTTP surface: the page, the match detail page and fragment, the JSON mirror,
 * health, and a favicon so the page never makes a failing request. Everything
 * but a match detail on a cache miss is served from memory (design D8, D10).
 */

import Fastify, { LogController, type FastifyInstance, type FastifyReply } from 'fastify';

import { buildGroupViews } from './aggregate.js';
import type { Config } from './config.js';
import type { MatchDetailsResult, MatchDetailsService } from './details.js';
import { FEED_IDS, type JornadaState, type Tournament } from './model.js';
import {
  renderMatchDetail,
  renderMatchPage,
  renderNotFoundFragment,
  renderNotFoundPage,
  renderPage,
  type CurrentJornada,
  type Freshness,
  type Links,
  type PageModel,
} from './render.js';
import type { TournamentStore } from './store.js';
import { routes, type RateLimitState } from './upstream.js';

// 16x16 transparent ICO, inlined so there is no static asset to serve.
const FAVICON = Buffer.from(
  'AAABAAEAEBAAAAEAIABoBAAAFgAAACgAAAAQAAAAIAAAAAEAIAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAA=',
  'base64',
);

export type ServerDeps = {
  config: Config;
  store: TournamentStore;
  details: Pick<MatchDetailsService, 'get' | 'cachedCount'>;
  rateLimit: RateLimitState;
  /** When the scheduler will poll next. */
  nextPollAt: () => string | null;
  now?: () => number;
};

export function currentJornada(tournament: Tournament | null, jornadas: JornadaState | null): CurrentJornada | null {
  if (tournament === null || tournament.currentJornadaId === null || jornadas === null) return null;
  const ordered = [...jornadas.list].sort((a, b) => a.order - b.order || a.id - b.id);
  const index = ordered.findIndex((jornada) => jornada.id === tournament.currentJornadaId);
  if (index === -1) return null;
  return { name: ordered[index]!.name, position: index + 1, total: ordered.length };
}

function linksFor(config: Config): Links {
  return {
    tournament: routes.tournamentPage(config.upstream),
    match: (gameId) => `/partido/${gameId}`,
    officialMatch: (gameId) => routes.gamePage(config.upstream, gameId),
  };
}

function freshness(deps: ServerDeps): Freshness {
  const now = (deps.now ?? Date.now)();
  const { store, config } = deps;
  const lastSuccessAt = store.lastSuccessAt();
  const age = lastSuccessAt === null ? Number.POSITIVE_INFINITY : now - Date.parse(lastSuccessAt);
  return {
    lastSuccessAt,
    failing: store.anyFeedFailing(),
    // Two intervals, so jitter and a slow poll never flash a warning on healthy data.
    stale: age > 2 * config.poll.intervalMinutes * 60_000,
    backoffUntil: deps.rateLimit.until(now),
    intervalMinutes: config.poll.intervalMinutes,
  };
}

export function pageModel(deps: ServerDeps): PageModel {
  const { store, config } = deps;
  const standings = store.standings();
  return {
    tournamentId: config.upstream.tournamentId,
    tournament: store.tournament(),
    currentJornada: currentJornada(store.tournament(), store.jornadas()),
    groups: standings === null ? null : buildGroupViews(standings, store.fixture(), store.jornadas()),
    fixtureKnown: store.fixture() !== null,
    freshness: freshness(deps),
    timeZone: config.timeZone,
    links: linksFor(config),
  };
}

/** Fresh details may be cached briefly; anything degraded must not be pinned by a browser. */
function detailCacheHeader(reply: FastifyReply, result: MatchDetailsResult): void {
  reply.header('cache-control', result.status === 'fresh' ? 'public, max-age=60' : 'no-store');
}

export function createServer(deps: ServerDeps): FastifyInstance {
  const { config, store, details } = deps;
  const app = Fastify({
    logger: { level: config.server.logLevel },
    // Per-request logs would drown the poll logs.
    logController: new LogController({ disableRequestLogging: true }),
  });

  const matchModel = () => ({
    tournamentId: config.upstream.tournamentId,
    timeZone: config.timeZone,
    links: linksFor(config),
  });

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    reply.header('cache-control', 'public, max-age=30');
    return renderPage(pageModel(deps));
  });

  app.get<{ Params: { id: string }; Querystring: { embed?: string } }>('/partido/:id', async (request, reply) => {
    const embed = request.query.embed === '1';
    const result = await details.get(request.params.id);
    reply.type('text/html; charset=utf-8');

    if (result === null) {
      reply.code(404).header('cache-control', 'no-store');
      return embed ? renderNotFoundFragment() : renderNotFoundPage();
    }

    detailCacheHeader(reply, result);
    return embed ? renderMatchDetail(result, matchModel()) : renderMatchPage(result, matchModel());
  });

  app.get('/api/standings', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=30');
    const model = pageModel(deps);
    return {
      tournament: model.tournament,
      currentJornada: model.currentJornada,
      freshness: { ...model.freshness, nextPollAt: deps.nextPollAt() },
      groups:
        model.groups === null
          ? null
          : model.groups.map((group) => ({
              name: group.name,
              teams: group.teams.map((view) => ({
                ...view.row,
                played: view.played,
                byes: view.byes,
                remaining: view.remaining,
                discrepancy: view.discrepancy,
              })),
            })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/matches/:id', async (request, reply) => {
    const result = await details.get(request.params.id);
    if (result === null) {
      reply.code(404).header('cache-control', 'no-store');
      return { error: 'not found' };
    }
    detailCacheHeader(reply, result);
    return {
      status: result.status,
      match: result.basic,
      timeline: result.timeline,
      missingGoals: result.missingGoals,
      noEvents: result.noEvents,
      featuredPlayers: result.featuredPlayers,
      fetchedAt: result.fetchedAt,
    };
  });

  app.get('/health', async (_request, reply) => {
    const now = (deps.now ?? Date.now)();
    reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      tournamentId: config.upstream.tournamentId,
      lastSuccessAt: store.lastSuccessAt(),
      nextPollAt: deps.nextPollAt(),
      rateLimit: { active: deps.rateLimit.isActive(now), until: deps.rateLimit.until(now) },
      feeds: Object.fromEntries(
        FEED_IDS.map((id) => {
          const feed = store.feed(id);
          return [id, { fetchedAt: feed.fetchedAt, lastAttemptFailed: feed.lastAttemptFailed }];
        }),
      ),
      matchDetailsCached: details.cachedCount,
    };
  });

  app.get('/favicon.ico', async (_request, reply) => {
    reply.type('image/x-icon');
    reply.header('cache-control', 'public, max-age=86400');
    return FAVICON;
  });

  return app;
}
