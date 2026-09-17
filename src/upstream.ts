/**
 * The boundary with LigaPro's public JSON routes (design D1, D5, D6): URL
 * building, fetching, rate-limit bookkeeping, and the hand-written validators
 * that refuse to let a malformed payload into the store. Every parser fails for
 * exactly one payload, never for another feed.
 */

import type { Config } from './config.js';
import type {
  EventKind,
  FeaturedPlayer,
  Game,
  Jornada,
  MatchEvent,
  MatchInfo,
  MatchTeam,
  StandingsGroup,
  TeamRow,
  Tournament,
} from './model.js';

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/** Upstream answered 404 (for example, an unknown game id). */
export class NotFoundError extends UpstreamError {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** Upstream answered 429. `retryAfterSeconds` is set when it said how long to wait. */
export class RateLimitedError extends UpstreamError {
  constructor(public readonly retryAfterSeconds: number | null) {
    super(`rate limited by upstream${retryAfterSeconds === null ? '' : ` (retry after ${retryAfterSeconds}s)`}`);
    this.name = 'RateLimitedError';
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type Target = Pick<Config['upstream'], 'baseUrl' | 'tournamentId'>;

const tournamentBase = (target: Target) => `${target.baseUrl}/api/tournaments/${target.tournamentId}`;

export const routes = {
  tournament: (target: Target) => tournamentBase(target),
  positions: (target: Target) => `${tournamentBase(target)}/positions`,
  groupweeks: (target: Target) => `${tournamentBase(target)}/groupweeks`,
  games: (target: Target) => `${tournamentBase(target)}/games`,
  /** The same fixture route narrowed to one jornada: the only source of jornada membership. */
  jornadaGames: (target: Target, jornadaId: number) =>
    `${tournamentBase(target)}/games?${new URLSearchParams([['filter[groupweek][0]', String(jornadaId)]])}`,
  gameInfo: (target: Pick<Target, 'baseUrl'>, gameId: number) => `${target.baseUrl}/api/games/${gameId}/info`,
  gameEvents: (target: Pick<Target, 'baseUrl'>, gameId: number) => `${target.baseUrl}/api/games/${gameId}/events`,
  gameMvps: (target: Pick<Target, 'baseUrl'>, gameId: number) => `${target.baseUrl}/api/games/${gameId}/mvps`,
  /** LigaPro's own public pages, for links. */
  tournamentPage: (target: Target) => `${target.baseUrl}/campeonatos/${target.tournamentId}`,
  gamePage: (target: Pick<Target, 'baseUrl'>, gameId: number) => `${target.baseUrl}/juego/${gameId}`,
};

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type JsonFetcher = (url: string) => Promise<unknown>;

/** Only whole seconds are honored; an HTTP-date `Retry-After` is ignored (design D5). */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function createFetcher(
  upstream: Pick<Config['upstream'], 'timeoutMs' | 'userAgent'>,
  fetchImpl: typeof fetch = fetch,
): JsonFetcher {
  return async function fetchJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(upstream.timeoutMs),
        headers: { accept: 'application/json', 'user-agent': upstream.userAgent },
      });
    } catch (error) {
      throw new UpstreamError(`request failed: ${(error as Error).message}`);
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => {});
      throw new RateLimitedError(parseRetryAfter(response.headers.get('retry-after')));
    }
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      throw new NotFoundError('upstream answered 404');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new UpstreamError(`unexpected status ${response.status} ${response.statusText}`.trim());
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new UpstreamError(`reading the response failed: ${(error as Error).message}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new UpstreamError(`response was not JSON (${body.slice(0, 80)}…)`);
    }
  };
}

// ---------------------------------------------------------------------------
// Rate-limit backoff shared by polls, match details, the page and /health
// ---------------------------------------------------------------------------

const BACKOFF_CAP_MS = 60 * 60_000;

export class RateLimitState {
  private consecutive = 0;
  private untilMs: number | null = null;

  /**
   * Records a 429 and returns how long to wait: the base interval doubled per
   * consecutive rate-limited poll, capped at the larger of 60 minutes and the
   * interval, and never shorter than `Retry-After`.
   */
  onRateLimited(intervalMs: number, retryAfterSeconds: number | null, nowMs: number): number {
    this.consecutive += 1;
    const cap = Math.max(BACKOFF_CAP_MS, intervalMs);
    const exponential = Math.min(intervalMs * 2 ** this.consecutive, cap);
    const backoffMs = Math.max(exponential, (retryAfterSeconds ?? 0) * 1000);
    this.untilMs = Math.max(this.untilMs ?? 0, nowMs + backoffMs);
    return backoffMs;
  }

  /** A poll completed without any 429: back to the base interval. */
  onCleanPoll(): void {
    this.consecutive = 0;
    this.untilMs = null;
  }

  isActive(nowMs: number): boolean {
    return this.untilMs !== null && nowMs < this.untilMs;
  }

  remainingMs(nowMs: number): number {
    return this.untilMs === null ? 0 : Math.max(0, this.untilMs - nowMs);
  }

  until(nowMs: number): string | null {
    return this.isActive(nowMs) ? new Date(this.untilMs!).toISOString() : null;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers (design D6)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function object(value: unknown, where: string): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UpstreamError(`${where} is not an object`);
  }
  return value as Row;
}

function dataArray(payload: unknown, what: string): unknown[] {
  const data = object(payload, `${what} payload`).data;
  if (!Array.isArray(data)) throw new UpstreamError(`${what}: data is not an array`);
  return data;
}

const describe = (value: unknown) => (value === undefined ? 'missing' : JSON.stringify(value));

/**
 * Accepts a JSON integer or an all-digit string — LigaPro already mixes the two —
 * and rejects "", "12abc", fractions and negatives rather than coercing them.
 */
function nonNegativeInteger(value: unknown, field: string, where: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  throw new UpstreamError(`${where}: ${field} is not a non-negative integer (${describe(value)})`);
}

function positiveInteger(value: unknown, field: string, where: string): number {
  const parsed = nonNegativeInteger(value, field, where);
  if (parsed === 0) throw new UpstreamError(`${where}: ${field} must be positive (0)`);
  return parsed;
}

/** Goal difference is the only counter allowed below zero. */
function signedInteger(value: unknown, field: string, where: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
  throw new UpstreamError(`${where}: ${field} is not an integer (${describe(value)})`);
}

/** Trims and collapses internal whitespace: `"La  Axioneta "` → `"La Axioneta"`. Empty → null. */
export function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized === '' ? null : normalized;
}

function requiredText(value: unknown, field: string, where: string): string {
  const normalized = normalizeText(value);
  if (normalized === null) throw new UpstreamError(`${where}: ${field} is missing or empty`);
  return normalized;
}

function optionalUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

const isAbsent = (value: unknown) => value === null || value === undefined;

/** `"29/08/2026"` → `"2026-08-29"`; anything that is not a real calendar date → null. */
export function parseUpstreamDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `"20:30"` → `"20:30"`. `"00:00"` is upstream's placeholder for "no time recorded" → null. */
export function parseUpstreamTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return null;
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  if (hour > 23 || minute > 59 || (hour === 0 && minute === 0)) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Empty or `-` → null; otherwise normalized (`"Complejo  LigaSiete"` → `"Complejo LigaSiete"`). */
export function parseVenue(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized === null || normalized === '-' ? null : normalized;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** @throws UpstreamError unless the payload is the tournament info. */
export function parseTournament(payload: unknown): Tournament {
  const data = object(object(payload, 'tournament payload').data, 'tournament');
  const current = data.current_groupweek_id;
  return {
    id: positiveInteger(data.id, 'id', 'tournament'),
    name: requiredText(data.name, 'name', 'tournament'),
    startDate: parseUpstreamDate(data.start_at),
    endDate: parseUpstreamDate(data.finish_at),
    currentJornadaId: isAbsent(current) ? null : positiveInteger(current, 'current_groupweek_id', 'tournament'),
  };
}

function parseTeamRow(value: unknown, where: string): TeamRow {
  const row = object(value, where);
  return {
    id: positiveInteger(row.id, 'id', where),
    position: nonNegativeInteger(row.position, 'position', where),
    name: requiredText(row.name, 'name', where),
    logo: optionalUrl(row.logo),
    pts: nonNegativeInteger(row.points, 'points', where),
    pj: nonNegativeInteger(row.games, 'games', where),
    pg: nonNegativeInteger(row.games_won, 'games_won', where),
    pe: nonNegativeInteger(row.games_tied, 'games_tied', where),
    pp: nonNegativeInteger(row.games_lost, 'games_lost', where),
    gf: nonNegativeInteger(row.goals_for, 'goals_for', where),
    gc: nonNegativeInteger(row.goals_against, 'goals_against', where),
    dg: signedInteger(row.goals_difference, 'goals_difference', where),
  };
}

const isGroup = (entry: unknown): boolean =>
  typeof entry === 'object' && entry !== null && Array.isArray((entry as Row).positions);

/**
 * Accepts the grouped shape (`[{name, positions: [...]}]`) and the flat one
 * (`[row, ...]`, stored as one unnamed group).
 * @throws UpstreamError on any malformed row, a mixed shape, or zero teams.
 */
export function parseStandings(payload: unknown): StandingsGroup[] {
  const data = dataArray(payload, 'standings');

  let groups: StandingsGroup[];
  if (data.length > 0 && data.every(isGroup)) {
    groups = data.map((entry, groupIndex) => {
      const group = entry as Row;
      return {
        name: normalizeText(group.name),
        rows: (group.positions as unknown[]).map((row, rowIndex) =>
          parseTeamRow(row, `standings group ${groupIndex} row ${rowIndex}`),
        ),
      };
    });
  } else if (!data.some(isGroup)) {
    groups = [{ name: null, rows: data.map((row, rowIndex) => parseTeamRow(row, `standings row ${rowIndex}`)) }];
  } else {
    throw new UpstreamError('standings: data mixes groups and team rows');
  }

  // A tournament id that does not exist answers 200 with no teams; a real one lists them even at zero games.
  if (groups.every((group) => group.rows.length === 0)) {
    throw new UpstreamError('standings: no teams at all (unknown tournament?)');
  }

  const ids = groups.flatMap((group) => group.rows.map((row) => row.id));
  if (new Set(ids).size !== ids.length) throw new UpstreamError('standings: a team id appears twice');

  return groups;
}

function parseGame(value: unknown, index: number): Game {
  const row = object(value, `game ${index}`);
  const id = positiveInteger(row.id, 'id', `game ${index}`);
  const where = `game ${id}`;

  const homeAbsent = isAbsent(row.local_team_result);
  const awayAbsent = isAbsent(row.visiting_team_result);
  if (homeAbsent !== awayAbsent) throw new UpstreamError(`${where}: only one of the two scores is present`);

  return {
    id,
    home: { name: requiredText(row.local_team_name, 'local_team_name', where), logo: optionalUrl(row.local_team_logo) },
    away: {
      name: requiredText(row.visiting_team_name, 'visiting_team_name', where),
      logo: optionalUrl(row.visiting_team_logo),
    },
    homeGoals: homeAbsent ? null : nonNegativeInteger(row.local_team_result, 'local_team_result', where),
    awayGoals: awayAbsent ? null : nonNegativeInteger(row.visiting_team_result, 'visiting_team_result', where),
    date: parseUpstreamDate(row.date),
    time: parseUpstreamTime(row.hour),
    venue: parseVenue(row.stadium),
  };
}

/**
 * The complete fixture or one jornada of it. An empty list is valid here; the
 * poll rejects it only when a non-empty fixture is already stored.
 * @throws UpstreamError on any malformed game or a repeated game id.
 */
export function parseFixture(payload: unknown): Game[] {
  const games = dataArray(payload, 'fixture').map((value, index) => parseGame(value, index));
  const ids = games.map((game) => game.id);
  if (new Set(ids).size !== ids.length) throw new UpstreamError('fixture: a game id appears twice');
  return games;
}

/** @throws UpstreamError unless every jornada has an id, a name and an order. */
export function parseJornadas(payload: unknown): Jornada[] {
  return dataArray(payload, 'jornadas').map((value, index) => {
    const where = `jornada ${index}`;
    const row = object(value, where);
    return {
      id: positiveInteger(row.id, 'id', where),
      name: requiredText(row.name, 'name', where),
      order: nonNegativeInteger(row.order, 'order', where),
      date: parseUpstreamDate(row.date),
    };
  });
}

function parseMatchTeam(value: unknown, field: string): MatchTeam {
  const team = object(value, `match info ${field}`);
  const where = `match info ${field}`;
  return {
    id: positiveInteger(team.id, 'id', where),
    name: requiredText(team.name, 'name', where),
    logo: optionalUrl(team.logo),
    goals: isAbsent(team.result) ? null : nonNegativeInteger(team.result, 'result', where),
  };
}

/** @throws UpstreamError unless the payload is one game's info. */
export function parseMatchInfo(payload: unknown): MatchInfo {
  const data = object(object(payload, 'match info payload').data, 'match info');
  return {
    id: positiveInteger(data.id, 'id', 'match info'),
    jornadaName: normalizeText(data.groupweek_name),
    tournamentName: normalizeText(data.tournament_name),
    date: parseUpstreamDate(data.date),
    time: parseUpstreamTime(data.hour),
    venue: parseVenue(data.stadium),
    home: parseMatchTeam(data.local_team, 'local_team'),
    away: parseMatchTeam(data.visiting_team, 'visiting_team'),
  };
}

/** Kinds come from the numeric type, never the label: upstream spells the red card "Tarjets Roja". */
const KIND_BY_TYPE: Record<number, EventKind> = { 1: 'goal', 8: 'assist', 3: 'yellow', 4: 'red' };

function parseEvent(value: unknown, where: string): MatchEvent {
  const row = object(value, where);
  const typeId = positiveInteger(row.type_id, 'type_id', where);
  return {
    id: positiveInteger(row.id, 'id', where),
    typeId,
    kind: KIND_BY_TYPE[typeId] ?? 'other',
    label: normalizeText(row.type_name),
    player: normalizeText(row.player_name),
    teamId: positiveInteger(row.team_id, 'team_id', where),
    period: normalizeText(row.period) ?? '',
    minute: nonNegativeInteger(row.minutes, 'minutes', where),
    second: isAbsent(row.seconds) ? 0 : nonNegativeInteger(row.seconds, 'seconds', where),
  };
}

/**
 * One bad event is dropped (and reported through `onDropped`) rather than
 * hiding the whole timeline.
 * @throws UpstreamError only when the payload itself is not an events list.
 */
export function parseEvents(payload: unknown, onDropped: (reason: string) => void = () => {}): MatchEvent[] {
  const events: MatchEvent[] = [];
  dataArray(payload, 'events').forEach((value, index) => {
    try {
      events.push(parseEvent(value, `event ${index}`));
    } catch (error) {
      onDropped((error as Error).message);
    }
  });
  return events;
}

/** At most one featured player per team, identified only by the team's logo URL. */
export function parseMvps(payload: unknown): FeaturedPlayer[] {
  return dataArray(payload, 'mvps').flatMap((value) => {
    if (typeof value !== 'object' || value === null) return [];
    const row = value as Row;
    const name = normalizeText(row.name);
    return name === null ? [] : [{ name, teamLogo: optionalUrl(row.team_logo) }];
  });
}
