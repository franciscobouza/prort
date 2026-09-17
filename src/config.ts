/**
 * Every environment variable the service reads is parsed and validated here,
 * once, at boot (design D14). Nothing else in the codebase touches process.env.
 */

import { DEFAULT_TIME_ZONE, isValidTimeZone } from './format.js';

export type Config = {
  upstream: {
    baseUrl: string;
    tournamentId: number;
    timeoutMs: number;
    userAgent: string;
  };
  poll: {
    intervalMinutes: number;
    jitterSeconds: number;
    jornadaRefreshMinutes: number;
  };
  details: {
    ttlMinutes: number;
    requestsPerMinute: number;
  };
  server: {
    port: number;
    host: string;
    logLevel: string;
  };
  /** Timezone used to render our own timestamps, independent of the host's. */
  timeZone: string;
  snapshotPath: string;
  telegram:
    | { enabled: true; botToken: string; chatId: string; maxMessagesPerPoll: number }
    | { enabled: false; maxMessagesPerPoll: number };
  siteUrl: string;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function text(env: Env, key: string, fallback: string, problems: string[]): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value === '') {
    problems.push(`${key} is set but empty`);
    return fallback;
  }
  return value;
}

function number(
  env: Env,
  key: string,
  fallback: number,
  problems: string[],
  { min, max, integer = false }: { min: number; max: number; integer?: boolean },
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    problems.push(`${key} must be ${integer ? 'an integer' : 'a number'}, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  if (value < min || value > max) {
    problems.push(`${key} must be between ${min} and ${max}, got ${value}`);
    return fallback;
  }
  return value;
}

function tournamentId(env: Env, problems: string[]): number {
  const fallback = 549;
  const raw = env.UPSTREAM_TOURNAMENT_ID;
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim();
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    problems.push(`UPSTREAM_TOURNAMENT_ID must be a positive integer, got ${JSON.stringify(raw)}`);
    return fallback;
  }
  return Number(value);
}

function timeZone(env: Env, problems: string[]): string {
  const value = text(env, 'DISPLAY_TIMEZONE', DEFAULT_TIME_ZONE, problems);
  if (!isValidTimeZone(value)) {
    problems.push(
      `DISPLAY_TIMEZONE is not an IANA timezone this runtime knows: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

function logLevel(env: Env, problems: string[]): string {
  const value = text(env, 'LOG_LEVEL', 'info', problems);
  if (!LOG_LEVELS.includes(value)) {
    problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Strips any trailing slash so path joining stays predictable. */
function baseUrl(env: Env, problems: string[]): string {
  const value = text(env, 'UPSTREAM_BASE_URL', 'https://www.ligapro.uy', problems);
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`UPSTREAM_BASE_URL must be http(s), got ${url.protocol}`);
    }
  } catch {
    problems.push(`UPSTREAM_BASE_URL is not a valid URL: ${JSON.stringify(value)}`);
  }
  return value.replace(/\/+$/, '');
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const maxMessagesPerPoll = number(env, 'TELEGRAM_MAX_MESSAGES_PER_POLL', 5, problems, {
    min: 1,
    max: 20,
    integer: true,
  });

  if ((botToken && !chatId) || (!botToken && chatId)) {
    problems.push(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together (or both left unset to disable notifications)',
    );
  }

  const config: Config = {
    upstream: {
      baseUrl: baseUrl(env, problems),
      tournamentId: tournamentId(env, problems),
      timeoutMs: number(env, 'UPSTREAM_TIMEOUT_MS', 10_000, problems, { min: 500, max: 120_000 }),
      userAgent: text(
        env,
        'UPSTREAM_USER_AGENT',
        'prort/1.0 (+standings mirror; contact: repo owner)',
        problems,
      ),
    },
    poll: {
      intervalMinutes: number(env, 'POLL_INTERVAL_MINUTES', 5, problems, { min: 0.1, max: 1440 }),
      jitterSeconds: number(env, 'POLL_JITTER_SECONDS', 30, problems, { min: 0, max: 3600 }),
      jornadaRefreshMinutes: number(env, 'JORNADA_REFRESH_MINUTES', 60, problems, {
        min: 1,
        max: 10_080,
      }),
    },
    details: {
      ttlMinutes: number(env, 'MATCH_DETAILS_TTL_MINUTES', 15, problems, { min: 0, max: 1440 }),
      // A retrieval needs two requests (info and events), so fewer than two would starve it.
      requestsPerMinute: number(env, 'MATCH_DETAILS_REQUESTS_PER_MINUTE', 20, problems, {
        min: 2,
        max: 600,
        integer: true,
      }),
    },
    server: {
      port: number(env, 'PORT', 3000, problems, { min: 0, max: 65_535, integer: true }),
      host: text(env, 'HOST', '0.0.0.0', problems),
      logLevel: logLevel(env, problems),
    },
    snapshotPath: text(env, 'SNAPSHOT_PATH', './data/snapshot.json', problems),
    timeZone: timeZone(env, problems),
    telegram:
      botToken && chatId
        ? { enabled: true, botToken, chatId, maxMessagesPerPoll }
        : { enabled: false, maxMessagesPerPoll },
    // Optional and shipped empty in .env.example, so an empty value means "unset", not an error.
    siteUrl: env.SITE_URL?.trim() ?? '',
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
