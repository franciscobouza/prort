/**
 * In-memory source of truth (design D11). Every read path — the page, the JSON
 * endpoints, /health — comes from here, so no request waits on I/O. The snapshot
 * file exists only so a restart has a baseline to diff against; losing it is safe.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  emptyFeeds,
  FEED_IDS,
  type FeedData,
  type FeedId,
  type Feeds,
  type FeedState,
  type Game,
  type JornadaState,
  type SnapshotFile,
  type StandingsGroup,
  type Tournament,
} from './model.js';

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

export type RestoreOutcome = 'restored' | 'other-tournament' | 'unusable';

/** The feeds refreshed on every poll; the other two are structure, refreshed hourly. */
const LIVE_FEEDS: readonly FeedId[] = ['standings', 'fixture'];

export class TournamentStore {
  private feeds: Feeds = emptyFeeds();

  /** True until a snapshot is restored or a poll succeeds — suppresses the fake "everything changed" report on a cold start. */
  private cold = true;

  constructor(readonly tournamentId: number) {}

  get isCold(): boolean {
    return this.cold;
  }

  feed<K extends FeedId>(id: K): Feeds[K] {
    return this.feeds[id];
  }

  tournament(): Tournament | null {
    return this.feeds.tournament.data;
  }

  standings(): StandingsGroup[] | null {
    return this.feeds.standings.data;
  }

  fixture(): Game[] | null {
    return this.feeds.fixture.data;
  }

  jornadas(): JornadaState | null {
    return this.feeds.jornadas.data;
  }

  record<K extends FeedId>(id: K, data: FeedData<K>, at: string): void {
    const state: FeedState<FeedData<K>> = { data, fetchedAt: at, lastAttemptFailed: false, lastError: null };
    (this.feeds as Record<FeedId, FeedState<unknown>>)[id] = state;
  }

  /** Records a failure without touching the stored data or its fetchedAt. */
  recordFailure(id: FeedId, error: string): void {
    const state = this.feeds[id];
    state.lastAttemptFailed = true;
    state.lastError = error;
  }

  markWarm(): void {
    this.cold = false;
  }

  hasStandings(): boolean {
    return this.feeds.standings.data !== null;
  }

  /** Most recent successful retrieval of a live feed (standings or fixture), or null if none ever succeeded. */
  lastSuccessAt(): string | null {
    const timestamps = LIVE_FEEDS.map((id) => this.feeds[id].fetchedAt).filter(
      (value): value is string => value !== null,
    );
    if (timestamps.length === 0) return null;
    return timestamps.reduce((latest, value) => (value > latest ? value : latest));
  }

  failingFeeds(): FeedId[] {
    return FEED_IDS.filter((id) => this.feeds[id].lastAttemptFailed);
  }

  anyFeedFailing(): boolean {
    return this.failingFeeds().length > 0;
  }

  toSnapshot(savedAt: string): SnapshotFile {
    return { version: 1, tournamentId: this.tournamentId, savedAt, feeds: structuredClone(this.feeds) };
  }

  /** Best-effort restore. Anything unexpected in the file is skipped, never fatal. */
  restore(snapshot: unknown): RestoreOutcome {
    if (!isObject(snapshot) || snapshot.version !== 1 || !isObject(snapshot.feeds)) return 'unusable';
    if (snapshot.tournamentId !== this.tournamentId) return 'other-tournament';

    const feeds = snapshot.feeds;
    let restored = false;
    const take = <K extends FeedId>(id: K, looksValid: (data: unknown) => boolean) => {
      const saved = feeds[id];
      if (!isObject(saved) || !looksValid(saved.data)) return;
      this.feeds[id] = {
        data: saved.data,
        fetchedAt: typeof saved.fetchedAt === 'string' ? saved.fetchedAt : null,
        lastAttemptFailed: false,
        lastError: null,
      } as Feeds[K];
      restored = true;
    };

    take('tournament', (data) => isObject(data) && typeof data.id === 'number' && typeof data.name === 'string');
    take(
      'standings',
      (data) =>
        Array.isArray(data) && data.length > 0 && data.every((group) => isObject(group) && Array.isArray(group.rows)),
    );
    take('fixture', (data) => Array.isArray(data) && data.every((game) => isObject(game) && typeof game.id === 'number'));
    take(
      'jornadas',
      (data) =>
        isObject(data) && Array.isArray(data.list) && isObject(data.assignment) && Array.isArray(data.fixtureIds),
    );

    if (!restored) return 'unusable';
    this.cold = false;
    return 'restored';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadSnapshot(store: TournamentStore, path: string, log: Logger): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') log.info(`no snapshot at ${path}, starting cold`);
    else log.warn(`snapshot unreadable at ${path} (${code ?? 'error'}), starting cold`);
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(`snapshot at ${path} is corrupt JSON, starting cold`);
    return false;
  }

  const outcome = store.restore(parsed);
  if (outcome === 'restored') {
    log.info(`snapshot restored from ${path}`);
    return true;
  }
  if (outcome === 'other-tournament') {
    log.warn(`snapshot at ${path} is for another tournament, ignoring it and starting cold`);
  } else {
    log.warn(`snapshot at ${path} had no usable data, starting cold`);
  }
  return false;
}

/** Atomic write: temp file then rename, so a crash mid-write cannot leave a half-file. Never throws. */
export async function saveSnapshot(store: TournamentStore, path: string, log: Logger): Promise<void> {
  const snapshot = store.toSnapshot(new Date().toISOString());
  const temp = `${path}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, JSON.stringify(snapshot), 'utf8');
    await rename(temp, path);
  } catch (error) {
    log.warn(`could not write snapshot to ${path}: ${(error as Error).message}`);
  }
}
