import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Game, JornadaState, StandingsGroup, Tournament } from '../src/model.js';
import { parseFixture, parseJornadas, parseStandings, parseTournament } from '../src/upstream.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Payloads captured live from https://www.ligapro.uy/api/ on 2026-09-17 (tournament 549,
 * "Serie 4 / Divisional B / Clausura 2026", after Jornada 4), in one paced session so the
 * standings, the complete fixture and the per-jornada lists agree with each other.
 */
export function fixture(name: string): unknown {
  return JSON.parse(rawFixture(name));
}

export function rawFixture(name: string): string {
  return readFileSync(join(here, 'fixtures', `${name}.json`), 'utf8');
}

export const tournamentPayload = fixture('tournament');
export const positionsPayload = fixture('positions');
export const groupweeksPayload = fixture('groupweeks');
export const gamesPayload = fixture('games');

/** Jornada ids in upstream order: Jornada 1 is 5389, Jornada 15 is 5403. */
export const jornadaIds: number[] = (groupweeksPayload as { data: { id: number }[] }).data.map(
  (jornada) => jornada.id,
);

export const jornadaGamesPayload = (jornadaId: number): unknown =>
  fixture(`games-jornada-${jornadaId}`);

/** Tournament 520: the flat standings shape (`has_groups: false`). */
export const positionsFlatPayload = fixture('positions-flat');
/** What upstream answers, with HTTP 200, for a tournament id that does not exist. */
export const positionsEmptyPayload = fixture('positions-empty');
/** The 404 body for an unknown game's `info`. */
export const gameNotFoundPayload = fixture('game-not-found');

/** Games whose details were captured: see design.md, Context. */
export const detailGameIds = [30237, 30239, 30240, 30248, 30258, 30259] as const;

export const matchPayload = (gameId: number, part: 'info' | 'events' | 'mvps'): unknown =>
  fixture(`game-${gameId}-${part}`);

/** The jornada assignment a successful refresh builds from the 15 per-jornada captures. */
export function jornadaState(): JornadaState {
  const assignment: Record<string, number> = {};
  for (const jornadaId of jornadaIds) {
    for (const game of parseFixture(jornadaGamesPayload(jornadaId))) assignment[String(game.id)] = jornadaId;
  }
  return {
    list: parseJornadas(groupweeksPayload),
    assignment,
    fixtureIds: parseFixture(gamesPayload).map((game) => game.id),
  };
}

/** Every feed of tournament 549, parsed as the store would hold it. Fresh copies on each call. */
export function tournamentData(): {
  tournament: Tournament;
  standings: StandingsGroup[];
  fixture: Game[];
  jornadas: JornadaState;
} {
  return {
    tournament: parseTournament(tournamentPayload),
    standings: parseStandings(positionsPayload),
    fixture: parseFixture(gamesPayload),
    jornadas: jornadaState(),
  };
}
