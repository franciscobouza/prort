/**
 * Match details on demand (design D8, D9). Only played games of the stored
 * fixture are served; details are cached for a TTL, retrieved once per match
 * however many requests arrive together, and upstream requests are budgeted per
 * minute and suspended during a rate-limit backoff, so no amount of traffic can
 * turn this service into a heavy LigaPro client. The poll never calls this.
 */

import { jornadaLookup } from './aggregate.js';
import type { Config } from './config.js';
import {
  isPlayed,
  type FeaturedPlayer,
  type FeaturedPlayerView,
  type JornadaRef,
  type MatchDetails,
  type MatchEvent,
  type MatchInfo,
  type Side,
  type TimelineEvent,
} from './model.js';
import type { Logger, TournamentStore } from './store.js';
import {
  parseEvents,
  parseMatchInfo,
  parseMvps,
  RateLimitedError,
  routes,
  UpstreamError,
  type JsonFetcher,
  type RateLimitState,
} from './upstream.js';

/** What the stored fixture alone says about a played match. */
export type BasicMatch = {
  gameId: number;
  tournamentName: string | null;
  jornada: JornadaRef | null;
  /** The jornada's name, from the assignment or, failing that, from the match info. */
  jornadaName: string | null;
  date: string | null;
  time: string | null;
  venue: string | null;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
};

/** `fresh`: retrieved within the TTL. `stale`: an expired copy served because retrieval was not possible. `unavailable`: basic info only. */
export type DetailStatus = 'fresh' | 'stale' | 'unavailable';

export type MatchDetailsResult = {
  status: DetailStatus;
  basic: BasicMatch;
  timeline: TimelineEvent[] | null;
  /** Goals on the scoreboard with no recorded scorer, per side. */
  missingGoals: { home: number; away: number } | null;
  noEvents: boolean | null;
  featuredPlayers: FeaturedPlayerView[];
  fetchedAt: string | null;
};

export type DetailsDeps = {
  config: Config;
  store: TournamentStore;
  fetchJson: JsonFetcher;
  rateLimit: RateLimitState;
  log: Logger;
  now?: () => number;
};

const MINUTE = 60_000;

const PERIOD_RANK: Record<string, number> = { FIRST_TIME: 0, SECOND_TIME: 1 };
const periodRank = (event: MatchEvent) => PERIOD_RANK[event.period] ?? 2;
const KIND_RANK = { goal: 0, assist: 1, yellow: 2, red: 3, other: 4 } as const;

/** Attributes each event to a side and orders the timeline; upstream's own order is never relied on. */
export function buildTimeline(events: MatchEvent[], info: MatchInfo): TimelineEvent[] {
  const sideOf = (teamId: number): Side | null =>
    teamId === info.home.id ? 'home' : teamId === info.away.id ? 'away' : null;

  return events
    .map((event) => ({ ...event, side: sideOf(event.teamId) }))
    .sort(
      (a, b) =>
        periodRank(a) - periodRank(b) ||
        a.period.localeCompare(b.period) ||
        a.minute - b.minute ||
        a.second - b.second ||
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.id - b.id,
    );
}

/** Upstream identifies a featured player's team only by its logo URL. */
export function attributeFeaturedPlayers(players: FeaturedPlayer[], info: MatchInfo): FeaturedPlayerView[] {
  const distinct = info.home.logo !== null && info.away.logo !== null && info.home.logo !== info.away.logo;
  return players.map((player) => ({
    name: player.name,
    side:
      !distinct || player.teamLogo === null
        ? null
        : player.teamLogo === info.home.logo
          ? 'home'
          : player.teamLogo === info.away.logo
            ? 'away'
            : null,
  }));
}

type CacheEntry = {
  details: MatchDetails;
  fetchedAtMs: number;
};

export class MatchDetailsService {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly inFlight = new Map<number, Promise<void>>();
  /** Bumped by invalidate(), so a retrieval that started before a score correction is discarded. */
  private readonly generations = new Map<number, number>();
  private requestTimes: number[] = [];

  constructor(private readonly deps: DetailsDeps) {}

  get cachedCount(): number {
    return this.cache.size;
  }

  /** Null when the id is not a played game of the stored fixture — and then upstream is never contacted. */
  async get(rawId: string | number): Promise<MatchDetailsResult | null> {
    const basic = this.basicMatch(rawId);
    if (basic === null) return null;
    const id = basic.gameId;

    const cached = this.cache.get(id);
    if (cached !== undefined && this.now() - cached.fetchedAtMs < this.ttlMs()) {
      return this.result('fresh', basic, cached);
    }

    let pending = this.inFlight.get(id);
    if (pending === undefined) {
      if (this.deps.rateLimit.isActive(this.now()) || !this.canSpend(2)) {
        return this.fallback(basic, id);
      }
      // Reserve both required requests up front, so concurrent retrievals can never overdraw the budget.
      this.spend(2);
      pending = this.retrieve(id).finally(() => this.inFlight.delete(id));
      this.inFlight.set(id, pending);
    }
    await pending;

    const stored = this.cache.get(id);
    if (stored !== undefined && stored !== cached) return this.result('fresh', basic, stored);
    return this.fallback(basic, id);
  }

  /** Called by the poll when a result was corrected or cleared. */
  invalidate(gameId: number): void {
    this.cache.delete(gameId);
    this.generations.set(gameId, (this.generations.get(gameId) ?? 0) + 1);
  }

  private basicMatch(rawId: string | number): BasicMatch | null {
    const text = String(rawId);
    if (!/^\d+$/.test(text)) return null;
    const id = Number(text);
    if (!Number.isSafeInteger(id) || id < 1) return null;

    const game = this.deps.store.fixture()?.find((candidate) => candidate.id === id);
    if (game === undefined || !isPlayed(game)) return null;

    const jornada = jornadaLookup(this.deps.store.jornadas())(id);
    return {
      gameId: id,
      tournamentName: this.deps.store.tournament()?.name ?? null,
      jornada,
      jornadaName: jornada?.name ?? null,
      date: game.date,
      time: game.time,
      venue: game.venue,
      home: game.home.name,
      away: game.away.name,
      homeGoals: game.homeGoals,
      awayGoals: game.awayGoals,
    };
  }

  private async retrieve(id: number): Promise<void> {
    const { config, fetchJson, log } = this.deps;
    const generation = this.generations.get(id) ?? 0;

    try {
      const info = parseMatchInfo(await fetchJson(routes.gameInfo(config.upstream, id)));
      if (info.id !== id) throw new UpstreamError(`match info answered for game ${info.id}`);
      const events = parseEvents(await fetchJson(routes.gameEvents(config.upstream, id)), (reason) =>
        log.warn(`match ${id}: ${reason}; event dropped`),
      );

      // Featured players are best-effort: skipped when the budget is short, and a failure costs nothing else.
      let featured: FeaturedPlayer[] = [];
      if (this.canSpend(1) && !this.deps.rateLimit.isActive(this.now())) {
        this.spend(1);
        try {
          featured = parseMvps(await fetchJson(routes.gameMvps(config.upstream, id)));
        } catch (error) {
          this.noteRateLimit(error);
          log.warn(`match ${id} featured players: ${(error as Error).message}`);
        }
      }

      if ((this.generations.get(id) ?? 0) !== generation) return;
      const fetchedAtMs = this.now();
      this.cache.set(id, {
        fetchedAtMs,
        details: {
          gameId: id,
          info,
          timeline: buildTimeline(events, info),
          featuredPlayers: attributeFeaturedPlayers(featured, info),
          fetchedAt: new Date(fetchedAtMs).toISOString(),
        },
      });
    } catch (error) {
      this.noteRateLimit(error);
      log.warn(`match ${id} details: ${(error as Error).message}`);
    }
  }

  /** A 429 here starts the same backoff a poll would, which also holds off the next poll. */
  private noteRateLimit(error: unknown): void {
    if (!(error instanceof RateLimitedError)) return;
    this.deps.rateLimit.onRateLimited(
      this.deps.config.poll.intervalMinutes * MINUTE,
      error.retryAfterSeconds,
      this.now(),
    );
  }

  private result(status: 'fresh' | 'stale', basic: BasicMatch, entry: CacheEntry): MatchDetailsResult {
    const { details } = entry;
    const recorded = (side: Side) =>
      details.timeline.filter((event) => event.kind === 'goal' && event.side === side).length;
    return {
      status,
      basic: {
        ...basic,
        tournamentName: basic.tournamentName ?? details.info.tournamentName,
        jornadaName: basic.jornadaName ?? details.info.jornadaName,
      },
      timeline: details.timeline,
      missingGoals: {
        home: Math.max(0, basic.homeGoals - recorded('home')),
        away: Math.max(0, basic.awayGoals - recorded('away')),
      },
      noEvents: details.timeline.length === 0,
      featuredPlayers: details.featuredPlayers,
      fetchedAt: details.fetchedAt,
    };
  }

  /** The expired copy when there is one (never an invalidated one), otherwise basic info only. */
  private fallback(basic: BasicMatch, id: number): MatchDetailsResult {
    const entry = this.cache.get(id);
    if (entry !== undefined) return this.result('stale', basic, entry);
    return {
      status: 'unavailable',
      basic,
      timeline: null,
      missingGoals: null,
      noEvents: null,
      featuredPlayers: [],
      fetchedAt: null,
    };
  }

  private canSpend(count: number): boolean {
    const now = this.now();
    this.requestTimes = this.requestTimes.filter((at) => now - at < MINUTE);
    return this.requestTimes.length + count <= this.deps.config.details.requestsPerMinute;
  }

  private spend(count: number): void {
    const now = this.now();
    for (let index = 0; index < count; index += 1) this.requestTimes.push(now);
  }

  private ttlMs(): number {
    return this.deps.config.details.ttlMinutes * MINUTE;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
