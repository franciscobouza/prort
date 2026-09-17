/**
 * Domain types. Everything LigaPro sends is validated into these shapes at the
 * boundary (upstream.ts); nothing past it sees an upstream field name.
 */

/** The tournament itself (`/api/tournaments/{id}`). */
export type Tournament = {
  id: number;
  name: string;
  /** Upstream local date as `YYYY-MM-DD`, or null when upstream sent something unparseable. */
  startDate: string | null;
  endDate: string | null;
  currentJornadaId: number | null;
};

/** One row of the official table, exactly as upstream computed it. */
export type TeamRow = {
  id: number;
  position: number;
  name: string;
  logo: string | null;
  pts: number;
  pj: number;
  pg: number;
  pe: number;
  pp: number;
  gf: number;
  gc: number;
  /** The only counter allowed to be negative. */
  dg: number;
};

/** A flat standings list is stored as a single group with no name. */
export type StandingsGroup = {
  name: string | null;
  rows: TeamRow[];
};

export type GameSide = {
  name: string;
  logo: string | null;
};

/**
 * One fixture game. Played exactly when both goal counts are present — never
 * inferred from the date, which upstream does not keep in step with results.
 */
export type Game = {
  id: number;
  home: GameSide;
  away: GameSide;
  homeGoals: number | null;
  awayGoals: number | null;
  /** Upstream local date as `YYYY-MM-DD`. */
  date: string | null;
  /** `HH:MM`, or null when upstream sent its `00:00` placeholder. */
  time: string | null;
  venue: string | null;
};

export type PlayedGame = Game & { homeGoals: number; awayGoals: number };

export function isPlayed(game: Game): game is PlayedGame {
  return game.homeGoals !== null && game.awayGoals !== null;
}

export type Jornada = {
  id: number;
  name: string;
  order: number;
  date: string | null;
};

/** What a jornada refresh produces (design D3). */
export type JornadaState = {
  list: Jornada[];
  /** Game id → jornada id. */
  assignment: Record<string, number>;
  /** Game ids in the complete fixture when this assignment was built. */
  fixtureIds: number[];
};

export type FeedState<T> = {
  data: T | null;
  fetchedAt: string | null;
  lastAttemptFailed: boolean;
  lastError: string | null;
};

export type Feeds = {
  tournament: FeedState<Tournament>;
  standings: FeedState<StandingsGroup[]>;
  fixture: FeedState<Game[]>;
  jornadas: FeedState<JornadaState>;
};

export type FeedId = keyof Feeds;

export type FeedData<K extends FeedId> = NonNullable<Feeds[K]['data']>;

export const FEED_IDS: readonly FeedId[] = ['tournament', 'standings', 'fixture', 'jornadas'];

export type SnapshotFile = {
  version: 1;
  tournamentId: number;
  savedAt: string;
  feeds: Feeds;
};

export function emptyFeedState<T>(): FeedState<T> {
  return { data: null, fetchedAt: null, lastAttemptFailed: false, lastError: null };
}

export function emptyFeeds(): Feeds {
  return {
    tournament: emptyFeedState<Tournament>(),
    standings: emptyFeedState<StandingsGroup[]>(),
    fixture: emptyFeedState<Game[]>(),
    jornadas: emptyFeedState<JornadaState>(),
  };
}

// ---------------------------------------------------------------------------
// Match details (fetched on demand, design D8 and D9)
// ---------------------------------------------------------------------------

export type Side = 'home' | 'away';

export type MatchTeam = {
  id: number;
  name: string;
  logo: string | null;
  goals: number | null;
};

/** `/api/games/{id}/info`. */
export type MatchInfo = {
  id: number;
  jornadaName: string | null;
  tournamentName: string | null;
  date: string | null;
  time: string | null;
  venue: string | null;
  home: MatchTeam;
  away: MatchTeam;
};

export type EventKind = 'goal' | 'assist' | 'yellow' | 'red' | 'other';

/** One entry of `/api/games/{id}/events`, before it is attributed to a side. */
export type MatchEvent = {
  id: number;
  typeId: number;
  kind: EventKind;
  /** Upstream's label, shown only for kinds this service does not recognize. */
  label: string | null;
  player: string | null;
  teamId: number;
  /** `FIRST_TIME`, `SECOND_TIME`, or whatever else upstream sends. */
  period: string;
  minute: number;
  second: number;
};

export type TimelineEvent = MatchEvent & { side: Side | null };

/** One entry of `/api/games/{id}/mvps`: the team is known only by its logo. */
export type FeaturedPlayer = {
  name: string;
  teamLogo: string | null;
};

export type FeaturedPlayerView = {
  name: string;
  side: Side | null;
};

/** What the details cache holds for one match. */
export type MatchDetails = {
  gameId: number;
  info: MatchInfo;
  timeline: TimelineEvent[];
  featuredPlayers: FeaturedPlayerView[];
  fetchedAt: string;
};

// ---------------------------------------------------------------------------
// Derived views (design D7): computed on read, never stored
// ---------------------------------------------------------------------------

export type StandingRow = TeamRow & { pperd: number };

export type JornadaRef = {
  id: number;
  name: string;
  order: number;
};

export type Outcome = 'W' | 'D' | 'L';

/** A played game seen from one team's side. */
export type TeamMatch = {
  gameId: number;
  jornada: JornadaRef | null;
  date: string | null;
  time: string | null;
  home: boolean;
  opponent: string;
  goalsFor: number;
  goalsAgainst: number;
  outcome: Outcome;
  venue: string | null;
};

export type TeamBye = {
  jornada: JornadaRef;
  /** True once every game of that jornada has been played. */
  past: boolean;
};

export type RemainingOpponent = {
  name: string;
  /** Pending games against this opponent; more than 1 only in multi-round formats. */
  count: number;
};

export type TeamView = {
  row: StandingRow;
  played: TeamMatch[];
  byes: TeamBye[];
  remaining: RemainingOpponent[];
  /** True when the fixture disagrees with the standings row (design D7). */
  discrepancy: boolean;
};

export type GroupView = {
  name: string | null;
  teams: TeamView[];
};
