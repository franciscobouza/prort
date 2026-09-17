/**
 * Telegram delivery (design D13), copied from Ligador; it also logs Telegram's
 * own reason when a message is refused. Send-only — nothing is ever received, so
 * no bot framework. Never throws: a Telegram outage must not cost us a poll.
 */

import type { Config } from './config.js';

/** Telegram's hard limit is 4096 characters; we format to stay under it. */
export const TELEGRAM_MAX_CHARS = 4096;

const RETRYABLE_ATTEMPTS = 3;

export type Sender = (text: string) => Promise<boolean>;

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Telegram explains a refusal in `description` ("Bad Request: chat not found"), which is
 * what makes a wrong chat id diagnosable. The token is scrubbed in case it is ever echoed.
 */
async function refusalReason(response: Response, botToken: string): Promise<string> {
  try {
    const body = (await response.json()) as { description?: unknown };
    return typeof body.description === 'string' ? `: ${body.description.replaceAll(botToken, '[token]')}` : '';
  } catch {
    return '';
  }
}

export function createSender(config: Config, log: Logger): Sender | null {
  if (!config.telegram.enabled) {
    log.info('telegram not configured, notifications disabled');
    return null;
  }
  const { botToken, chatId } = config.telegram;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  return async function send(text: string): Promise<boolean> {
    for (let attempt = 1; attempt <= RETRYABLE_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(config.upstream.timeoutMs),
        });

        if (response.ok) return true;

        const reason = await refusalReason(response, botToken);
        // 4xx means bad token, bad chat id or malformed text — retrying cannot help.
        if (response.status >= 400 && response.status < 500) {
          log.warn(`telegram rejected the message (${response.status}${reason}), giving up`);
          return false;
        }
        log.warn(`telegram returned ${response.status}${reason}, attempt ${attempt}/${RETRYABLE_ATTEMPTS}`);
      } catch (error) {
        log.warn(
          `telegram request failed (${(error as Error).message}), attempt ${attempt}/${RETRYABLE_ATTEMPTS}`,
        );
      }

      if (attempt < RETRYABLE_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
    return false;
  };
}

/**
 * Splits a report on entry boundaries so no change is ever dropped (design D13).
 * Only when the bound is hit does anything get left out, and then the count of
 * omitted entries is stated explicitly.
 */
export function packMessages(
  header: string,
  entries: string[],
  maxMessages: number,
  siteUrl: string,
): string[] {
  if (entries.length === 0) return [];

  const messages: string[] = [];
  let current: string[] = [];
  let omitted = 0;

  const flush = () => {
    if (current.length > 0) {
      messages.push(current.join('\n'));
      current = [];
    }
  };

  const budget = (partHeader: string) => TELEGRAM_MAX_CHARS - partHeader.length - 64;

  for (const [index, entry] of entries.entries()) {
    if (messages.length >= maxMessages) {
      omitted = entries.length - index;
      break;
    }
    const projected = [...current, entry].join('\n');
    if (projected.length > budget(header) && current.length > 0) {
      flush();
      if (messages.length >= maxMessages) {
        omitted = entries.length - index;
        break;
      }
    }
    // A single oversized entry is still sent, trimmed to fit its own message.
    current.push(entry.length > budget(header) ? `${entry.slice(0, budget(header))}…` : entry);
  }

  if (messages.length < maxMessages) flush();
  else if (current.length > 0) omitted += current.length;

  const total = messages.length;
  return messages.map((body, index) => {
    const label = total > 1 ? `${header} (${index + 1}/${total})` : header;
    const isLast = index === total - 1;
    const tail =
      isLast && omitted > 0
        ? `\n\n…y ${omitted} cambio(s) más${siteUrl ? ` — ver ${siteUrl}` : ''}`
        : '';
    return `${label}\n${body}${tail}`;
  });
}

/** Sends parts in order, stopping at the first failure so the sequence stays coherent. */
export async function sendAll(send: Sender, messages: string[]): Promise<number> {
  let sent = 0;
  for (const message of messages) {
    const ok = await send(message);
    if (!ok) break;
    sent += 1;
  }
  return sent;
}
