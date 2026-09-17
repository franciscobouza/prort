/**
 * Change detection (design D12). Standings are compared through a canonical
 * form keyed by team id, so row order, official position, name or logo alone
 * never read as a change; results are compared game by game on the upstream id.
 */

import { orderRows } from './aggregate.js';
import { isPlayed, type Game, type PlayedGame, type StandingRow, type StandingsGroup } from './model.js';

export type StandingsField = 'PJ' | 'PG' | 'PE' | 'PP' | 'GF' | 'GC' | 'Pts' | 'PPerd';

export type FieldChange = {
  field: StandingsField;
  before: number;
  after: number;
};

export type TeamChange =
  | { kind: 'added'; team: StandingRow; group: string | null }
  | { kind: 'removed'; team: StandingRow; group: string | null }
  | {
      kind: 'updated';
      team: StandingRow;
      group: string | null;
      /** Only the values that moved; empty when the team moved purely because others did. */
      fields: FieldChange[];
      positionBefore: number;
      positionAfter: number;
    };

export type Score = { home: number; away: number };

export type ResultChange =
  | { kind: 'new'; game: PlayedGame }
  | { kind: 'corrected'; game: PlayedGame; before: Score }
  | { kind: 'cleared'; game: Game; before: Score };

const COUNTED = [
  { field: 'PJ', of: 'pj' },
  { field: 'PG', of: 'pg' },
  { field: 'PE', of: 'pe' },
  { field: 'PP', of: 'pp' },
  { field: 'GF', of: 'gf' },
  { field: 'GC', of: 'gc' },
  { field: 'Pts', of: 'pts' },
] as const;

export function canonicalStandings(groups: StandingsGroup[]): string {
  return groups
    .flatMap((group) => group.rows)
    .sort((a, b) => a.id - b.id)
    .map((row) => [row.id, row.pj, row.pg, row.pe, row.pp, row.gf, row.gc, row.pts].join('|'))
    .join('\n');
}

export function standingsChanged(before: StandingsGroup[] | null, after: StandingsGroup[]): boolean {
  if (before === null) return false; // No baseline: nothing to compare against, so nothing to report.
  return canonicalStandings(before) !== canonicalStandings(after);
}

type Located = { row: StandingRow; group: string | null };

/** Team id → row, in group order and then official order, so reports read top to bottom. */
function locate(groups: StandingsGroup[]): Map<number, Located> {
  const located = new Map<number, Located>();
  for (const group of groups) {
    for (const row of orderRows(group.rows)) located.set(row.id, { row, group: group.name });
  }
  return located;
}

/** Per-team diff, including movement in the official position and in PPerd. */
export function diffStandings(before: StandingsGroup[], after: StandingsGroup[]): TeamChange[] {
  const previous = locate(before);
  const current = locate(after);
  const changes: TeamChange[] = [];

  for (const [id, { row, group }] of current) {
    const old = previous.get(id);
    if (old === undefined) {
      changes.push({ kind: 'added', team: row, group });
      continue;
    }
    const fields: FieldChange[] = COUNTED.filter(({ of }) => old.row[of] !== row[of]).map(({ field, of }) => ({
      field,
      before: old.row[of],
      after: row[of],
    }));
    if (old.row.pperd !== row.pperd) fields.push({ field: 'PPerd', before: old.row.pperd, after: row.pperd });

    if (fields.length > 0 || old.row.position !== row.position) {
      changes.push({
        kind: 'updated',
        team: row,
        group,
        fields,
        positionBefore: old.row.position,
        positionAfter: row.position,
      });
    }
  }

  for (const [id, { row, group }] of previous) {
    if (!current.has(id)) changes.push({ kind: 'removed', team: row, group });
  }

  return changes;
}

/** New, corrected and cleared results, keyed by game id. Date, time, venue and jornada are ignored. */
export function diffResults(before: Game[] | null, after: Game[]): ResultChange[] {
  if (before === null) return [];
  const previous = new Map(before.map((game) => [game.id, game]));
  const changes: ResultChange[] = [];

  for (const game of after) {
    const old = previous.get(game.id);
    const oldPlayed = old !== undefined && isPlayed(old) ? old : null;

    if (isPlayed(game)) {
      if (oldPlayed === null) {
        changes.push({ kind: 'new', game });
      } else if (oldPlayed.homeGoals !== game.homeGoals || oldPlayed.awayGoals !== game.awayGoals) {
        changes.push({ kind: 'corrected', game, before: { home: oldPlayed.homeGoals, away: oldPlayed.awayGoals } });
      }
    } else if (oldPlayed !== null) {
      changes.push({ kind: 'cleared', game, before: { home: oldPlayed.homeGoals, away: oldPlayed.awayGoals } });
    }
  }

  const present = new Set(after.map((game) => game.id));
  for (const old of before) {
    if (!present.has(old.id) && isPlayed(old)) {
      changes.push({ kind: 'cleared', game: old, before: { home: old.homeGoals, away: old.awayGoals } });
    }
  }

  return changes;
}
