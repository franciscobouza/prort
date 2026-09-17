/**
 * Timestamp formatting (design D15).
 *
 * Our own timestamps (when a poll last succeeded, when the next one is due) are
 * stored as UTC ISO strings and MUST be rendered in a fixed, configured
 * timezone — never the host's. A container deployed anywhere runs in UTC, which
 * would show Uruguayan evening polls as the following day.
 *
 * Upstream match dates are the opposite case: LigaPro sends bare local
 * wall-clock text ("29/08/2026", "00:00") with no zone. The boundary stores them
 * as "2026-08-29" and "20:30", and they are reformatted here as text without
 * ever going through Date. Do not "fix" those into a timezone.
 */

export const DEFAULT_TIME_ZONE = 'America/Montevideo';

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('es-UY', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "2026-08-18T00:22:20.689Z" in America/Montevideo → "17/08 21:22". */
export function formatStamp(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('es-UY', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  // Assembled and padded by hand rather than trusting the locale's pattern:
  // es-UY renders August as "8" even when 2-digit is requested, and separators
  // vary by ICU version. Only the timezone maths is delegated to Intl.
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    (parts.find((part) => part.type === type)?.value ?? '').padStart(2, '0');

  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

const UPSTREAM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Upstream local date "2026-08-29" → "29/08" (text only, no timezone). */
export function shortDate(date: string | null): string | null {
  const match = date ? UPSTREAM_DATE.exec(date) : null;
  if (!match) return null;
  return `${match[3]}/${match[2]}`;
}

/** Upstream local date "2026-08-29" → "29/08/2026" (text only, no timezone). */
export function longDate(date: string | null): string | null {
  const match = date ? UPSTREAM_DATE.exec(date) : null;
  if (!match) return null;
  return `${match[3]}/${match[2]}/${match[1]}`;
}
