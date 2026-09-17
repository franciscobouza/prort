/**
 * Everything derived from the stored feeds (design D7): Puntos Perdidos, the
 * official ordering, links from fixture sides to standings teams, and each
 * team's views — played matches from its own side, byes, remaining opponents —
 * plus the consistency check against its standings row. Nothing here is stored,
 * so a fix to any rule takes effect without touching the snapshot.
 */

import {
  isPlayed,
  type Game,
  type GameSide,
  type GroupView,
  type JornadaRef,
  type JornadaState,
  type Outcome,
  type PlayedGame,
  type RemainingOpponent,
  type StandingRow,
  type StandingsGroup,
  type TeamBye,
  type TeamMatch,
  type TeamRow,
  type TeamView,
} from './model.js';

/** Points dropped: 3 for a loss, 2 for a draw, 0 for a win. Lower is better. */
export function pperd(row: Pick<TeamRow, 'pe' | 'pp'>): number {
  return 3 * row.pp + 2 * row.pe;
}

/** Match key for a team name across feeds: case- and whitespace-insensitive. */
export function teamKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLocaleUpperCase('es');
}

/**
 * The official order, untouched. Colliding positions fall back to points, goal
 * difference, goals for and name, so repeated renders are byte-identical.
 */
export function orderRows(rows: TeamRow[]): StandingRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.position - b.position ||
        b.pts - a.pts ||
        b.dg - a.dg ||
        b.gf - a.gf ||
        a.name.localeCompare(b.name, 'es'),
    )
    .map((row) => ({ ...row, pperd: pperd(row) }));
}

export type SideLinks = { home: number | null; away: number | null };

/** Index of `key → team id`, keeping only keys that belong to exactly one team. */
function uniqueIndex(rows: TeamRow[], key: (row: TeamRow) => string | null): Map<string, number> {
  const ids = new Map<string, number[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null) continue;
    ids.set(value, [...(ids.get(value) ?? []), row.id]);
  }
  return new Map([...ids].filter(([, owners]) => owners.length === 1).map(([value, owners]) => [value, owners[0]!]));
}

/** Links each side of each game to a team id: by name, else by a logo owned by exactly one team. */
export function linkFixture(rows: TeamRow[], games: Game[]): Map<number, SideLinks> {
  const byName = uniqueIndex(rows, (row) => teamKey(row.name));
  const byLogo = uniqueIndex(rows, (row) => row.logo);
  const link = (side: GameSide): number | null =>
    byName.get(teamKey(side.name)) ?? (side.logo === null ? undefined : byLogo.get(side.logo)) ?? null;
  return new Map(games.map((game) => [game.id, { home: link(game.home), away: link(game.away) }]));
}

export type JornadaLookup = (gameId: number) => JornadaRef | null;

export function jornadaLookup(jornadas: JornadaState | null): JornadaLookup {
  if (jornadas === null) return () => null;
  const byId = new Map(jornadas.list.map((jornada) => [jornada.id, jornada]));
  return (gameId) => {
    const jornadaId = jornadas.assignment[String(gameId)];
    const jornada = jornadaId === undefined ? undefined : byId.get(jornadaId);
    return jornada === undefined ? null : { id: jornada.id, name: jornada.name, order: jornada.order };
  };
}

const LAST_DATE = '9999-12-31';

/** Jornada order first (unknown last), then date (unknown last), then game id. Dates alone cannot be trusted. */
export function compareGames(jornadaOf: JornadaLookup): (a: Game, b: Game) => number {
  return (a, b) =>
    (jornadaOf(a.id)?.order ?? Number.POSITIVE_INFINITY) - (jornadaOf(b.id)?.order ?? Number.POSITIVE_INFINITY) ||
    (a.date ?? LAST_DATE).localeCompare(b.date ?? LAST_DATE) ||
    a.id - b.id;
}

function outcomeOf(goalsFor: number, goalsAgainst: number): Outcome {
  if (goalsFor > goalsAgainst) return 'W';
  if (goalsFor < goalsAgainst) return 'L';
  return 'D';
}

/**
 * The standings groups with every team's derived views. `games` is null while
 * the fixture has never been retrieved; `jornadas` is null until a jornada
 * refresh has succeeded (then there are no jornada labels and no byes).
 */
export function buildGroupViews(
  groups: StandingsGroup[],
  games: Game[] | null,
  jornadas: JornadaState | null,
): GroupView[] {
  const rows = groups.flatMap((group) => group.rows);
  const teamsById = new Map(rows.map((row) => [row.id, row]));
  const links = linkFixture(rows, games ?? []);
  const jornadaOf = jornadaLookup(jornadas);
  const ordered = [...(games ?? [])].sort(compareGames(jornadaOf));

  const gamesByJornada = new Map<number, Game[]>();
  for (const game of ordered) {
    const jornada = jornadaOf(game.id);
    if (jornada !== null) gamesByJornada.set(jornada.id, [...(gamesByJornada.get(jornada.id) ?? []), game]);
  }
  const jornadaList = [...(jornadas?.list ?? [])].sort((a, b) => a.order - b.order || a.id - b.id);

  const plays = (game: Game, teamId: number) => {
    const link = links.get(game.id);
    return link !== undefined && (link.home === teamId || link.away === teamId);
  };

  const opponentOf = (game: Game, teamId: number) => {
    const link = links.get(game.id)!;
    const home = link.home === teamId;
    const opponentId = home ? link.away : link.home;
    const side = home ? game.away : game.home;
    // A linked opponent shows its standings name; an unlinked one keeps its fixture name.
    const name = (opponentId === null ? undefined : teamsById.get(opponentId)?.name) ?? side.name;
    return { home, opponentId, name };
  };

  const orient = (game: PlayedGame, teamId: number): TeamMatch => {
    const { home, name } = opponentOf(game, teamId);
    const goalsFor = home ? game.homeGoals : game.awayGoals;
    const goalsAgainst = home ? game.awayGoals : game.homeGoals;
    return {
      gameId: game.id,
      jornada: jornadaOf(game.id),
      date: game.date,
      time: game.time,
      home,
      opponent: name,
      goalsFor,
      goalsAgainst,
      outcome: outcomeOf(goalsFor, goalsAgainst),
      venue: game.venue,
    };
  };

  const teamView = (row: StandingRow): TeamView => {
    const own = ordered.filter((game) => plays(game, row.id));

    const played = own.filter(isPlayed).map((game) => orient(game, row.id));

    const remaining: RemainingOpponent[] = [];
    const seen = new Map<string, RemainingOpponent>();
    for (const game of own.filter((candidate) => !isPlayed(candidate))) {
      const { opponentId, name } = opponentOf(game, row.id);
      const identity = opponentId === null ? `name:${teamKey(name)}` : `id:${opponentId}`;
      const existing = seen.get(identity);
      if (existing !== undefined) {
        existing.count += 1;
      } else {
        const entry = { name, count: 1 };
        seen.set(identity, entry);
        remaining.push(entry);
      }
    }

    // No byes without jornada assignment, and none for a team linked to no game —
    // it would otherwise look free in every jornada.
    const byes: TeamBye[] = [];
    if (jornadas !== null && own.length > 0) {
      for (const jornada of jornadaList) {
        const assigned = gamesByJornada.get(jornada.id) ?? [];
        if (assigned.length === 0 || assigned.some((game) => plays(game, row.id))) continue;
        byes.push({
          jornada: { id: jornada.id, name: jornada.name, order: jornada.order },
          past: assigned.every(isPlayed),
        });
      }
    }

    const count = (outcome: Outcome) => played.filter((match) => match.outcome === outcome).length;
    const discrepancy =
      games !== null &&
      (played.length !== row.pj || count('W') !== row.pg || count('D') !== row.pe || count('L') !== row.pp);

    return { row, played, byes, remaining, discrepancy };
  };

  return groups.map((group) => ({ name: group.name, teams: orderRows(group.rows).map(teamView) }));
}
