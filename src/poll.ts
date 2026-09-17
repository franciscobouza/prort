/**
 * One poll (design D3, D4, D5). Every time: the standings, then the complete
 * fixture. When due: the structure refresh — tournament info, the jornada list
 * and one fixture request per jornada. Requests go strictly one at a time with a
 * gap; each feed succeeds or fails on its own; an HTTP 429 ends the poll and
 * starts a backoff.
 */

import { jornadaLookup } from './aggregate.js';
import type { Config } from './config.js';
import type { MatchDetailsService } from './details.js';
import { diffResults, diffStandings, standingsChanged, type ResultChange, type TeamChange } from './diff.js';
import type { Game, JornadaState } from './model.js';
import type { Notifier } from './notify.js';
import type { RunOutcome } from './scheduler.js';
import { saveSnapshot, type Logger, type TournamentStore } from './store.js';
import {
  parseFixture,
  parseJornadas,
  parseStandings,
  parseTournament,
  RateLimitedError,
  routes,
  UpstreamError,
  type JsonFetcher,
  type RateLimitState,
} from './upstream.js';

/** Minimum spacing between the end of one upstream request and the start of the next. */
export const REQUEST_GAP_MS = 250;

/** A backoff with less than this left is not worth skipping a poll for. */
const SKIP_TOLERANCE_MS = 1_000;

export type PollDeps = {
  config: Config;
  store: TournamentStore;
  fetchJson: JsonFetcher;
  rateLimit: RateLimitState;
  log: Logger;
  /** Process start (epoch ms). A jornada assignment older than this is refreshed on the first poll. */
  startedAt?: number;
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type PollResult = {
  standingsChanges: TeamChange[];
  resultChanges: ResultChange[];
  anySuccess: boolean;
  /** True when this poll had no baseline to compare against (cold start). */
  wasCold: boolean;
  refreshedJornadas: boolean;
  rateLimited: boolean;
  /** How long the scheduler must wait before the next poll; 0 when not backing off. */
  backoffMs: number;
  /** True when the poll never ran because a backoff was still in effect. */
  skipped: boolean;
};

type Attempt<T> = { ok: true; data: T } | { ok: false; error: string };

/** "20s" for short waits, "10 min" otherwise. */
function describeWait(ms: number): string {
  return ms < 120_000 ? `${Math.ceil(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`;
}

/** The structure refresh is due at startup, after a failure, once the interval elapses, or when the fixture grows. */
export function jornadaRefreshDue(
  store: TournamentStore,
  nowMs: number,
  refreshMs: number,
  startedAt: number,
): boolean {
  const state = store.feed('jornadas');
  if (state.data === null || state.fetchedAt === null || state.lastAttemptFailed) return true;

  const refreshedAt = Date.parse(state.fetchedAt);
  if (!Number.isFinite(refreshedAt) || refreshedAt < startedAt || nowMs - refreshedAt >= refreshMs) return true;

  // Compared with the fixture as it was at that refresh, so a game upstream lists
  // under no jornada triggers one extra refresh, not one per poll.
  const known = new Set(state.data.fixtureIds);
  return (store.fixture() ?? []).some((game) => !known.has(game.id));
}

export async function runPoll(deps: PollDeps): Promise<PollResult> {
  const { config, store, fetchJson, rateLimit, log } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const gapMs = deps.gapMs ?? REQUEST_GAP_MS;
  const target = config.upstream;

  const result: PollResult = {
    standingsChanges: [],
    resultChanges: [],
    anySuccess: false,
    wasCold: store.isCold,
    refreshedJornadas: false,
    rateLimited: false,
    backoffMs: 0,
    skipped: false,
  };

  // A 429 answered to a match-detail request may have started a backoff since the last poll.
  const pending = rateLimit.remainingMs(now());
  if (pending > SKIP_TOLERANCE_MS) {
    result.skipped = true;
    result.backoffMs = pending;
    log.info(`upstream asked to slow down; skipping this poll for ${describeWait(pending)}`);
    return result;
  }

  const at = new Date(now()).toISOString();
  const limited = { retryAfterSeconds: null as number | null };
  let sent = 0;

  async function request<T>(label: string, url: string, parse: (payload: unknown) => T): Promise<Attempt<T>> {
    if (result.rateLimited) return { ok: false, error: 'rate limited' };
    if (sent > 0 && gapMs > 0) await sleep(gapMs);
    sent += 1;
    try {
      return { ok: true, data: parse(await fetchJson(url)) };
    } catch (error) {
      if (error instanceof RateLimitedError) {
        result.rateLimited = true;
        limited.retryAfterSeconds = error.retryAfterSeconds;
      }
      const message = (error as Error).message;
      // Parser errors already name their feed; don't say it twice.
      log.warn(message.startsWith(`${label}:`) ? message : `${label}: ${message}`);
      return { ok: false, error: message };
    }
  }

  // 1. Standings.
  const standings = await request('standings', routes.positions(target), parseStandings);
  if (standings.ok) {
    const previous = store.standings();
    if (!result.wasCold && standingsChanged(previous, standings.data)) {
      result.standingsChanges = diffStandings(previous!, standings.data);
    }
    store.record('standings', standings.data, at);
    result.anySuccess = true;
  } else {
    store.recordFailure('standings', standings.error);
  }

  // 2. The complete fixture. A sudden empty list over a stored one is a hiccup, not 28 cleared results.
  const fixture = await request('fixture', routes.games(target), (payload): Game[] => {
    const games = parseFixture(payload);
    if (games.length === 0 && (store.fixture()?.length ?? 0) > 0) {
      throw new UpstreamError('fixture: no games at all, while a non-empty fixture is stored');
    }
    return games;
  });
  if (fixture.ok) {
    if (!result.wasCold) result.resultChanges = diffResults(store.fixture(), fixture.data);
    store.record('fixture', fixture.data, at);
    result.anySuccess = true;
  } else {
    store.recordFailure('fixture', fixture.error);
  }

  // 3. Structure: tournament info and jornada assignment, when due.
  const refreshMs = config.poll.jornadaRefreshMinutes * 60_000;
  if (jornadaRefreshDue(store, now(), refreshMs, deps.startedAt ?? 0)) {
    await refreshTournament();

    const list = await request('jornadas', routes.groupweeks(target), parseJornadas);
    if (!list.ok) {
      store.recordFailure('jornadas', list.error);
    } else {
      const assignment: JornadaState['assignment'] = {};
      let failure: string | null = null;
      for (const jornada of [...list.data].sort((a, b) => a.order - b.order || a.id - b.id)) {
        const games = await request(`jornada ${jornada.name}`, routes.jornadaGames(target, jornada.id), parseFixture);
        if (!games.ok) {
          failure = `${jornada.name}: ${games.error}`;
          break;
        }
        for (const game of games.data) assignment[String(game.id)] = jornada.id;
      }

      // All or nothing: a partial assignment would silently mislabel games.
      if (failure === null) {
        const fixtureIds = (store.fixture() ?? []).map((game) => game.id);
        store.record('jornadas', { list: list.data, assignment, fixtureIds }, at);
        result.refreshedJornadas = true;
        result.anySuccess = true;
        log.info(`jornadas refreshed: ${list.data.length} jornadas, ${Object.keys(assignment).length} games`);
      } else {
        store.recordFailure('jornadas', failure);
      }
    }
  } else if (store.tournament() === null || store.feed('tournament').lastAttemptFailed) {
    // One cheap request, so a failed tournament info does not wait for the next hourly refresh.
    await refreshTournament();
  }

  async function refreshTournament(): Promise<void> {
    const tournament = await request('tournament', routes.tournament(target), parseTournament);
    if (tournament.ok) {
      store.record('tournament', tournament.data, at);
      result.anySuccess = true;
    } else {
      store.recordFailure('tournament', tournament.error);
    }
  }

  if (result.rateLimited) {
    result.backoffMs = rateLimit.onRateLimited(config.poll.intervalMinutes * 60_000, limited.retryAfterSeconds, now());
    log.warn(`rate limited by upstream; next poll in ${describeWait(result.backoffMs)}`);
  } else {
    rateLimit.onCleanPoll();
  }

  if (result.anySuccess) store.markWarm();
  return result;
}

export type CycleDeps = PollDeps & {
  notifier: Pick<Notifier, 'notifyChanges' | 'notifyStartup'>;
  details: Pick<MatchDetailsService, 'invalidate'>;
  snapshotPath: string;
  save?: typeof saveSnapshot;
};

/**
 * Everything that happens around one poll, in order: poll, persist the
 * baseline, drop cached details a correction made stale, announce the restart
 * once, then report every change. Returns the backoff for the scheduler.
 */
export function createPollCycle(deps: CycleDeps): () => Promise<RunOutcome> {
  const save = deps.save ?? saveSnapshot;
  let startupAnnounced = false;

  return async () => {
    const result = await runPoll(deps);
    const { store } = deps;

    if (result.anySuccess) await save(store, deps.snapshotPath, deps.log);

    for (const change of result.resultChanges) {
      if (change.kind !== 'new') deps.details.invalidate(change.game.id);
    }

    const tournamentName = store.tournament()?.name ?? null;
    if (!startupAnnounced && !result.skipped) {
      startupAnnounced = true;
      await deps.notifier.notifyStartup({
        tournamentName,
        groups: store.standings(),
        lastSuccessAt: store.lastSuccessAt(),
      });
    }

    await deps.notifier.notifyChanges({
      tournamentName,
      results: result.resultChanges,
      standings: result.standingsChanges,
      jornadaOf: jornadaLookup(store.jornadas()),
      groupCount: store.standings()?.length ?? 1,
    });

    return { backoffMs: result.backoffMs };
  };
}
