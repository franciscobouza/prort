/** An in-memory LigaPro serving the captured fixtures of tournament 549, shared by the poll tests. */

import type { JsonFetcher } from '../src/upstream.js';
import { fixture } from './fixtures.js';

/** Route name for a LigaPro URL: positions, games, tournament, groupweeks or jornada:<id>. */
export function routeOf(url: string): string {
  const { pathname, searchParams } = new URL(url);
  const jornada = searchParams.get('filter[groupweek][0]');
  if (jornada !== null) return `jornada:${jornada}`;
  if (pathname.endsWith('/positions')) return 'positions';
  if (pathname.endsWith('/groupweeks')) return 'groupweeks';
  if (pathname.endsWith('/games')) return 'games';
  return 'tournament';
}

export const payloadFor = (route: string): unknown => {
  if (route.startsWith('jornada:')) return fixture(`games-jornada-${route.slice('jornada:'.length)}`);
  return fixture({ positions: 'positions', games: 'games', groupweeks: 'groupweeks', tournament: 'tournament' }[route]!);
};

/** An in-memory LigaPro serving the captured fixtures, with per-route overrides. */
export function fakeUpstream() {
  const calls: string[] = [];
  const overrides = new Map<string, () => unknown>();
  let inFlight = 0;
  let peak = 0;

  const fetchJson: JsonFetcher = async (url) => {
    const route = routeOf(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    calls.push(route);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      const override = overrides.get(route);
      return override ? override() : payloadFor(route);
    } finally {
      inFlight -= 1;
    }
  };

  return { fetchJson, calls, overrides, peak: () => peak };
}
