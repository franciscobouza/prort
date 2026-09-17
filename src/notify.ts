/**
 * Turns a poll's findings into Telegram messages (design D13). The contract is
 * completeness: every change the poll detected appears in the messages sent for
 * that poll — never just the first, never just the biggest move. Result lines
 * carry the score only, never scorers, so notifications never depend on match
 * details.
 */

import { orderRows } from "./aggregate.js";
import type { ResultChange, TeamChange } from "./diff.js";
import { DEFAULT_TIME_ZONE, formatStamp } from "./format.js";
import type { JornadaRef, StandingsGroup } from "./model.js";
import { packMessages, sendAll, type Logger, type Sender } from "./telegram.js";

/** Named in every message, so these are never mistaken for Ligador's in a shared chat. */
export const SERVICE_NAME = "prort";

export type ChangeReport = {
  tournamentName: string | null;
  results: ResultChange[];
  standings: TeamChange[];
  /** The jornada of a game under the current assignment, or null. */
  jornadaOf: (gameId: number) => JornadaRef | null;
  /** Group sub-headers are only added when the standings have more than one group. */
  groupCount: number;
};

export type StartupReport = {
  tournamentName: string | null;
  groups: StandingsGroup[] | null;
  lastSuccessAt: string | null;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function jornadaPrefix(jornada: JornadaRef | null): string {
  return jornada === null ? "" : `${escapeHtml(jornada.name)}: `;
}

/** One line per result change: jornada, teams and score — never who scored. */
export function formatResultEntry(
  change: ResultChange,
  jornada: JornadaRef | null,
): string {
  const home = escapeHtml(change.game.home.name);
  const away = escapeHtml(change.game.away.name);
  const prefix = jornadaPrefix(jornada);

  switch (change.kind) {
    case "new":
      return `⚽ ${prefix}${home} ${change.game.homeGoals}-${change.game.awayGoals} ${away}`;
    case "corrected":
      return `✏️ Resultado corregido — ${prefix}${home} ${change.game.homeGoals}-${change.game.awayGoals} ${away} (antes ${change.before.home}-${change.before.away})`;
    case "cleared":
      return `↩️ Resultado anulado — ${prefix}${home} vs ${away} (era ${change.before.home}-${change.before.away})`;
  }
}

function positionArrow(before: number, after: number): string {
  if (before === after || before === 0 || after === 0) return "";
  return after < before
    ? ` ⬆️ ${before}º→${after}º`
    : ` ⬇️ ${before}º→${after}º`;
}

/** One line per team, so splitting can never cut a change in half. */
export function formatTeamEntry(change: TeamChange): string {
  const name = escapeHtml(change.team.name);
  if (change.kind === "added") {
    return `➕ ${name} entra a la tabla (${change.team.pts} pts, ${change.team.position}º)`;
  }
  if (change.kind === "removed") return `➖ ${name} ya no aparece en la tabla`;

  const fields = change.fields
    .map((field) => `${field.field} ${field.before}→${field.after}`)
    .join(", ");
  const movement = positionArrow(change.positionBefore, change.positionAfter);
  // A team can move purely because others did; say so instead of an empty line.
  const body = fields
    ? `${fields}${movement}`
    : `sin cambios propios, ${change.positionAfter < change.positionBefore ? "sube" : "baja"}${movement}`;
  return `📊 ${name}: ${body}`;
}

export function buildChangeMessages(
  report: ChangeReport,
  maxMessages: number,
  siteUrl: string,
): string[] {
  const order = (change: ResultChange) =>
    report.jornadaOf(change.game.id)?.order ?? Number.POSITIVE_INFINITY;
  const results = [...report.results].sort(
    (a, b) => order(a) - order(b) || a.game.id - b.game.id,
  );
  const entries = results.map((change) =>
    formatResultEntry(change, report.jornadaOf(change.game.id)),
  );

  if (report.groupCount > 1) {
    const byGroup = new Map<string | null, TeamChange[]>();
    for (const change of report.standings)
      byGroup.set(change.group, [...(byGroup.get(change.group) ?? []), change]);
    for (const [group, changes] of byGroup) {
      entries.push(
        `<b>${escapeHtml(group ?? "Posiciones")}</b>`,
        ...changes.map(formatTeamEntry),
      );
    }
  } else {
    entries.push(...report.standings.map(formatTeamEntry));
  }

  if (entries.length === 0) return [];
  const tournament =
    report.tournamentName === null
      ? ""
      : ` · ${escapeHtml(report.tournamentName)}`;
  return packMessages(
    `🏆 <b>${SERVICE_NAME}</b> · Cambios${tournament}`,
    entries,
    maxMessages,
    escapeHtml(siteUrl),
  );
}

export function buildStartupMessage(
  report: StartupReport,
  siteUrl: string,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  const lines = [`♻️ <b>${SERVICE_NAME} reiniciado</b>`];
  if (report.tournamentName !== null)
    lines.push(escapeHtml(report.tournamentName));

  if (report.groups === null || report.groups.length === 0) {
    lines.push("", "sin datos todavía");
  } else {
    for (const group of report.groups) {
      lines.push("");
      if (group.name !== null || report.groups.length > 1)
        lines.push(`<b>${escapeHtml(group.name ?? "Posiciones")}</b>`);
      for (const row of orderRows(group.rows)) {
        lines.push(
          `${row.position}. ${escapeHtml(row.name)} — ${row.pts} pts (PPerd ${row.pperd})`,
        );
      }
    }
  }

  const stamp = formatStamp(report.lastSuccessAt, timeZone);
  lines.push(
    "",
    stamp === null ? "sin actualización registrada" : `actualizado ${stamp}`,
  );
  if (siteUrl) lines.push(escapeHtml(siteUrl));
  return lines.join("\n");
}

export class Notifier {
  constructor(
    private readonly send: Sender | null,
    private readonly log: Logger,
    private readonly maxMessages: number,
    private readonly siteUrl: string,
    private readonly timeZone: string = DEFAULT_TIME_ZONE,
  ) {}

  get enabled(): boolean {
    return this.send !== null;
  }

  /** Never throws and never rejects a poll — delivery failure is logged, not propagated. */
  private async deliver(messages: string[]): Promise<void> {
    if (!this.send || messages.length === 0) return;
    try {
      const sent = await sendAll(this.send, messages);
      if (sent < messages.length)
        this.log.warn(`telegram: sent ${sent}/${messages.length} messages`);
    } catch (error) {
      this.log.warn(`telegram: delivery failed (${(error as Error).message})`);
    }
  }

  async notifyChanges(report: ChangeReport): Promise<void> {
    await this.deliver(
      buildChangeMessages(report, this.maxMessages, this.siteUrl),
    );
  }

  async notifyStartup(report: StartupReport): Promise<void> {
    await this.deliver([
      buildStartupMessage(report, this.siteUrl, this.timeZone),
    ]);
  }
}
