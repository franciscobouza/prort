/**
 * Server-rendered HTML (design D10). The tables and every team's panel are in
 * the markup before any JavaScript runs; the inline script only sorts, toggles
 * panels, and loads a match's detail inline from this service. No external
 * font, stylesheet, script or image — the page works with every other host
 * blocked. Every upstream string passes through escapeHtml.
 */

import type { MatchDetailsResult } from './details.js';
import { formatStamp, longDate, shortDate } from './format.js';
import type { EventKind, GroupView, TeamBye, TeamMatch, TeamView, TimelineEvent, Tournament } from './model.js';

export type Freshness = {
  lastSuccessAt: string | null;
  /** The latest attempt of some feed failed. */
  failing: boolean;
  /** No successful retrieval of a live feed within two poll intervals. */
  stale: boolean;
  /** Set while a rate-limit backoff is in effect: when the next attempt is due. */
  backoffUntil: string | null;
  intervalMinutes: number;
};

export type CurrentJornada = {
  name: string;
  position: number;
  total: number;
};

export type Links = {
  /** LigaPro's own tournament page. */
  tournament: string;
  /** This service's detail page for a match. */
  match: (gameId: number) => string;
  /** LigaPro's own page for a match. */
  officialMatch: (gameId: number) => string;
};

export type PageModel = {
  tournamentId: number;
  tournament: Tournament | null;
  currentJornada: CurrentJornada | null;
  /** Null until standings have been retrieved. */
  groups: GroupView[] | null;
  /** False until the fixture has been retrieved: team rows are then not interactive. */
  fixtureKnown: boolean;
  freshness: Freshness;
  timeZone: string;
  links: Links;
};

export type MatchPageModel = {
  tournamentId: number;
  timeZone: string;
  links: Links;
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const UNKNOWN = 's/d';

function titleOf(tournamentId: number, tournament: Tournament | null): string {
  return tournament?.name ?? `Campeonato ${tournamentId}`;
}

/** "Jornada 4" → "J4"; anything without a trailing number is shown whole. */
function jornadaShort(name: string): string {
  const match = /(\d+)\s*$/.exec(name);
  return match ? `J${match[1]}` : name;
}

/** "Jornada 4 de 15", or "Fecha final (15 de 15)" when the name does not carry the number. */
export function currentJornadaLabel(current: CurrentJornada): string {
  return new RegExp(`\\b${current.position}$`).test(current.name)
    ? `${current.name} de ${current.total}`
    : `${current.name} (${current.position} de ${current.total})`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type Column = { key: string; label: string; title: string; numeric: boolean; desc: boolean };

const COLUMNS: Column[] = [
  { key: 'pos', label: '#', title: 'Posición', numeric: true, desc: false },
  { key: 'team', label: 'Equipo', title: 'Equipo', numeric: false, desc: false },
  { key: 'pj', label: 'PJ', title: 'Partidos jugados', numeric: true, desc: true },
  { key: 'pg', label: 'PG', title: 'Partidos ganados', numeric: true, desc: true },
  { key: 'pe', label: 'PE', title: 'Partidos empatados', numeric: true, desc: true },
  { key: 'pp', label: 'PP', title: 'Partidos perdidos', numeric: true, desc: true },
  { key: 'gf', label: 'GF', title: 'Goles a favor', numeric: true, desc: true },
  { key: 'gc', label: 'GC', title: 'Goles en contra', numeric: true, desc: true },
  { key: 'dg', label: 'DG', title: 'Diferencia de gol', numeric: true, desc: true },
  { key: 'pts', label: 'Pts', title: 'Puntos', numeric: true, desc: true },
  { key: 'pperd', label: 'PPerd', title: 'Puntos perdidos (3 por derrota, 2 por empate)', numeric: true, desc: false },
];

function freshnessBanner(freshness: Freshness, timeZone: string): string {
  const last = formatStamp(freshness.lastSuccessAt, timeZone) ?? 'nunca';
  if (freshness.backoffUntil !== null) {
    const next = formatStamp(freshness.backoffUntil, timeZone) ?? UNKNOWN;
    return `<p class="banner warn" role="status">⚠️ LigaPro está limitando las consultas; próximo intento ${escapeHtml(next)}. Última actualización correcta: ${escapeHtml(last)}.</p>`;
  }
  if (freshness.stale || freshness.failing) {
    const reason = freshness.failing ? ' (el último intento falló)' : '';
    return `<p class="banner warn" role="status">⚠️ Datos posiblemente desactualizados${reason} — última actualización correcta: ${escapeHtml(last)}.</p>`;
  }
  const cadence = Number(freshness.intervalMinutes.toFixed(1));
  return `<p class="banner">Última actualización: ${escapeHtml(last)} · se consulta cada ~${cadence} min.</p>`;
}

function headerMeta(model: PageModel): string {
  const parts: string[] = [];
  const start = longDate(model.tournament?.startDate ?? null);
  const end = longDate(model.tournament?.endDate ?? null);
  if (start !== null || end !== null) parts.push(`${escapeHtml(start ?? UNKNOWN)} – ${escapeHtml(end ?? UNKNOWN)}`);
  if (model.currentJornada !== null) parts.push(escapeHtml(currentJornadaLabel(model.currentJornada)));
  parts.push(`<a href="${escapeHtml(model.links.tournament)}" rel="noreferrer">Ver en LigaPro</a>`);
  return `<p class="meta">${parts.join(' · ')}</p>`;
}

function dateCell(date: string | null, time: string | null): string {
  const day = shortDate(date);
  if (day === null) return UNKNOWN;
  return time === null ? day : `${day} ${time}`;
}

function matchRow(match: TeamMatch, panelId: string, links: Links): string {
  const outcomeLabel = { W: 'G', D: 'E', L: 'P' }[match.outcome];
  const outcomeTitle = { W: 'Ganado', D: 'Empatado', L: 'Perdido' }[match.outcome];
  const jornada = match.jornada === null ? UNKNOWN : jornadaShort(match.jornada.name);
  const jornadaTitle = match.jornada === null ? 'Jornada desconocida' : match.jornada.name;
  const detailId = `m-${panelId}-${match.gameId}`;
  return `<tr class="match">
<td class="md" title="${escapeHtml(jornadaTitle)}">${escapeHtml(jornada)}</td>
<td class="dt">${escapeHtml(dateCell(match.date, match.time))}</td>
<td class="ha" title="${match.home ? 'De local' : 'De visitante'}">${match.home ? 'L' : 'V'}</td>
<td class="opp">${escapeHtml(match.opponent)}</td>
<td class="sc"><a class="match-link" href="${escapeHtml(links.match(match.gameId))}" title="Ver el detalle del partido" aria-expanded="false" aria-controls="${detailId}"><strong>${match.goalsFor}</strong>-${match.goalsAgainst}</a></td>
<td class="oc oc-${match.outcome}" title="${outcomeTitle}">${outcomeLabel}</td>
<td class="vn">${escapeHtml(match.venue ?? UNKNOWN)}</td>
</tr>`;
}

function byeRow(bye: TeamBye): string {
  return `<tr class="bye">
<td class="md" title="${escapeHtml(bye.jornada.name)}">${escapeHtml(jornadaShort(bye.jornada.name))}</td>
<td class="libre" colspan="6">Libre</td>
</tr>`;
}

function playedBlock(view: TeamView, panelId: string, links: Links): string {
  const pastByes = view.byes.filter((bye) => bye.past);
  // Past byes slot in at their jornada; matches with an unknown jornada stay last.
  const rows = [
    ...view.played.map((match) => ({ order: match.jornada?.order ?? Number.POSITIVE_INFINITY, html: matchRow(match, panelId, links) })),
    ...pastByes.map((bye) => ({ order: bye.jornada.order, html: byeRow(bye) })),
  ].sort((a, b) => a.order - b.order);

  const empty = view.played.length === 0 ? '<p class="empty">Todavía no jugó partidos.</p>' : '';
  if (rows.length === 0) return empty;
  return `${empty}<table class="matches">
<thead><tr><th scope="col">Jornada</th><th scope="col">Día</th><th scope="col">L/V</th><th scope="col">Rival</th><th scope="col">Resultado</th><th scope="col">R</th><th scope="col">Cancha</th></tr></thead>
<tbody>${rows.map((row) => row.html).join('')}</tbody>
</table>`;
}

function remainingBlock(view: TeamView): string {
  const upcoming = view.byes.filter((bye) => !bye.past);
  const byeNote =
    upcoming.length === 0 ? '' : ` · libre en ${upcoming.map((bye) => escapeHtml(bye.jornada.name)).join(', ')}`;

  if (view.remaining.length === 0) return `<p class="remaining-none">No le quedan partidos${byeNote}.</p>`;

  const games = view.remaining.reduce((total, opponent) => total + opponent.count, 0);
  const gamesNote = games === view.remaining.length ? '' : ` (${plural(games, 'partido', 'partidos')})`;
  const names = view.remaining
    .map((opponent) => `${escapeHtml(opponent.name)}${opponent.count > 1 ? ` (×${opponent.count})` : ''}`)
    .join(', ');
  return `<details class="remaining"><summary>Le quedan ${plural(view.remaining.length, 'rival', 'rivales')}${gamesNote}${byeNote}</summary><p>${names}</p></details>`;
}

function panelRow(view: TeamView, panelId: string, links: Links): string {
  const note = view.discrepancy
    ? `<p class="warn">Los partidos registrados no coinciden con la tabla para este equipo (${plural(view.played.length, 'partido jugado', 'partidos jugados')} contra PJ ${view.row.pj}).</p>`
    : '';
  return `<tr class="details" id="${panelId}" hidden><td colspan="${COLUMNS.length}"><div class="panel">${playedBlock(view, panelId, links)}${note}${remainingBlock(view)}</div></td></tr>`;
}

function teamRow(view: TeamView, panelId: string, interactive: boolean): string {
  const { row } = view;
  const name = escapeHtml(row.name);
  const nameCell = interactive
    ? `<td class="team"><button type="button" class="toggle" aria-expanded="false" aria-controls="${panelId}"><span class="chev" aria-hidden="true">▸</span>${name}</button></td>`
    : `<td class="team"><span class="plain">${name}</span></td>`;

  return `<tr data-pos="${row.position}">
<td class="pos" data-sort="${row.position}">${row.position}</td>
${nameCell}
<td data-sort="${row.pj}">${row.pj}</td>
<td data-sort="${row.pg}">${row.pg}</td>
<td data-sort="${row.pe}">${row.pe}</td>
<td data-sort="${row.pp}">${row.pp}</td>
<td data-sort="${row.gf}">${row.gf}</td>
<td data-sort="${row.gc}">${row.gc}</td>
<td data-sort="${row.dg}">${row.dg > 0 ? `+${row.dg}` : row.dg}</td>
<td class="pts" data-sort="${row.pts}">${row.pts}</td>
<td class="pperd" data-sort="${row.pperd}">${row.pperd}</td>
</tr>`;
}

function groupSection(group: GroupView, index: number, model: PageModel): string {
  const heading = escapeHtml(group.name ?? 'Posiciones');
  if (group.teams.length === 0) {
    return `<section class="group"><h2>${heading}</h2><p class="empty">Sin equipos en este grupo.</p></section>`;
  }

  const tableId = `t${index}`;
  const header = COLUMNS.map(
    (column) =>
      `<th scope="col" data-key="${column.key}" data-desc="${column.desc}" data-numeric="${column.numeric}" title="${escapeHtml(column.title)}" aria-sort="none" tabindex="0">${column.label}<span class="arrow" aria-hidden="true"></span></th>`,
  ).join('');

  const body = group.teams
    .map((view) => {
      const panelId = `p-${tableId}-${view.row.id}`;
      const main = teamRow(view, panelId, model.fixtureKnown);
      return model.fixtureKnown ? main + panelRow(view, panelId, model.links) : main;
    })
    .join('');

  return `<section class="group">
<h2>${heading}</h2>
<div class="scroller">
<table id="${tableId}" class="standings">
<thead><tr>${header}</tr></thead>
<tbody>${body}</tbody>
</table>
</div>
</section>`;
}

function htmlDocument(title: string, head: string, body: string, script: boolean): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<link rel="icon" href="/favicon.ico">
<style>${STYLES}</style>
${head}
</head>
<body>
${body}
${script ? `<script>${SCRIPT}</script>` : ''}
</body>
</html>`;
}

export function renderPage(model: PageModel): string {
  const title = escapeHtml(titleOf(model.tournamentId, model.tournament));
  const content =
    model.groups === null
      ? '<section class="group"><p class="empty">Todavía no se pudieron obtener los datos de LigaPro. La tabla aparece en cuanto haya información.</p></section>'
      : model.groups.map((group, index) => groupSection(group, index, model)).join('\n');

  const body = `<header>
<h1>${title}</h1>
${headerMeta(model)}
${freshnessBanner(model.freshness, model.timeZone)}
</header>
<main>
${content}
</main>
<footer>
<p><strong>PPerd</strong> = puntos perdidos: 3 por derrota, 2 por empate, 0 por victoria.</p>
<p>Tocá un equipo para ver sus partidos, su jornada libre y los rivales que le quedan. Tocá un resultado para ver el detalle del partido.</p>
<p>Datos de <a href="${escapeHtml(model.links.tournament)}" rel="noreferrer">ligapro.uy</a>.</p>
</footer>`;

  return htmlDocument(
    `${title} — Posiciones y Puntos Perdidos`,
    '<noscript><style>.details{display:table-row !important}.toggle .chev{display:none}</style></noscript>',
    body,
    true,
  );
}

// ---------------------------------------------------------------------------
// Match detail: one renderer for the inline fragment and the full page
// ---------------------------------------------------------------------------

const KIND_LABELS: Record<Exclude<EventKind, 'other'>, string> = {
  goal: '⚽ Gol',
  assist: '👟 Asistencia',
  yellow: '🟨 Amarilla',
  red: '🟥 Roja',
};

const PERIOD_LABELS: Record<string, string> = { FIRST_TIME: 'Primer tiempo', SECOND_TIME: 'Segundo tiempo' };

/** 5' → "05'"; seconds only when upstream recorded them. */
export function minuteLabel(event: Pick<TimelineEvent, 'minute' | 'second'>): string {
  const minute = String(event.minute).padStart(2, '0');
  return event.second === 0 ? `${minute}'` : `${minute}'${String(event.second).padStart(2, '0')}"`;
}

function timeline(result: MatchDetailsResult): string {
  if (result.timeline === null) return '';
  if (result.noEvents) return '<p class="note">No hay eventos registrados para este partido.</p>';

  const teamOf = (side: TimelineEvent['side']) =>
    side === 'home' ? result.basic.home : side === 'away' ? result.basic.away : 'sin equipo';

  const items: string[] = [];
  let period: string | null = null;
  for (const event of result.timeline) {
    if (event.period !== period) {
      period = event.period;
      items.push(`<li class="period">${escapeHtml(PERIOD_LABELS[period] ?? (period || 'Sin período'))}</li>`);
    }
    const kind = event.kind === 'other' ? `• ${escapeHtml(event.label ?? 'Evento')}` : KIND_LABELS[event.kind];
    items.push(
      `<li class="ev ${event.side ?? 'none'} kind-${event.kind}"><span class="min">${minuteLabel(event)}</span><span class="what"><span class="kind">${kind}</span> <span class="who">${escapeHtml(event.player ?? 'Jugador s/d')}</span><span class="side"> · ${escapeHtml(teamOf(event.side))}</span></span></li>`,
    );
  }
  return `<ol class="timeline">${items.join('')}</ol>`;
}

function missingGoalsNotes(result: MatchDetailsResult): string {
  if (result.missingGoals === null || result.noEvents) return '';
  return (['home', 'away'] as const)
    .filter((side) => result.missingGoals![side] > 0)
    .map((side) => {
      const count = result.missingGoals![side];
      const team = escapeHtml(side === 'home' ? result.basic.home : result.basic.away);
      return `<p class="note">${plural(count, 'gol', 'goles')} de ${team} sin autor registrado.</p>`;
    })
    .join('');
}

function featuredPlayers(result: MatchDetailsResult): string {
  if (result.featuredPlayers.length === 0) return '';
  const names = result.featuredPlayers
    .map((player) => {
      const team = player.side === 'home' ? result.basic.home : player.side === 'away' ? result.basic.away : null;
      return `${escapeHtml(player.name)}${team === null ? '' : ` <span class="muted">(${escapeHtml(team)})</span>`}`;
    })
    .join(', ');
  return `<p class="mvp">${result.featuredPlayers.length === 1 ? 'Figura' : 'Figuras'}: ${names}</p>`;
}

function statusNotice(result: MatchDetailsResult, timeZone: string): string {
  if (result.status === 'stale') {
    const at = formatStamp(result.fetchedAt, timeZone) ?? UNKNOWN;
    return `<p class="notice">Detalle posiblemente desactualizado: es del ${escapeHtml(at)} y LigaPro no se pudo consultar ahora.</p>`;
  }
  if (result.status === 'unavailable') {
    return '<p class="notice">El detalle de este partido no está disponible por ahora (goles, tarjetas y figuras). Probá de nuevo en unos minutos.</p>';
  }
  return '';
}

/** The detail itself, as inserted inline under a match row and as the body of /partido/{id}. */
export function renderMatchDetail(result: MatchDetailsResult, model: MatchPageModel): string {
  const { basic } = result;
  const meta = [basic.tournamentName, basic.jornadaName].filter((part): part is string => part !== null);
  const day = longDate(basic.date) ?? 'fecha s/d';
  const when = basic.time === null ? day : `${day} ${basic.time}`;

  return `<article class="match-card">
${meta.length > 0 ? `<p class="mc-meta">${meta.map(escapeHtml).join(' · ')}</p>` : ''}
<p class="mc-when">${escapeHtml(when)} · ${escapeHtml(basic.venue ?? 'cancha s/d')}</p>
<p class="mc-score"><span class="mc-team">${escapeHtml(basic.home)}</span> <strong>${basic.homeGoals} - ${basic.awayGoals}</strong> <span class="mc-team">${escapeHtml(basic.away)}</span></p>
${statusNotice(result, model.timeZone)}${timeline(result)}${missingGoalsNotes(result)}${featuredPlayers(result)}
<p class="mc-links"><a href="${escapeHtml(model.links.officialMatch(basic.gameId))}" rel="noreferrer">Ver el partido en LigaPro</a></p>
</article>`;
}

export function renderMatchPage(result: MatchDetailsResult, model: MatchPageModel): string {
  const { basic } = result;
  const heading = `${basic.home} ${basic.homeGoals}-${basic.awayGoals} ${basic.away}`;
  const body = `<header>
<p class="back"><a href="/">← Volver a la tabla</a></p>
<h1>${escapeHtml(heading)}</h1>
</header>
<main>
<section class="group">
${renderMatchDetail(result, model)}
</section>
</main>`;
  return htmlDocument(`${escapeHtml(heading)} — ${escapeHtml(basic.tournamentName ?? `Campeonato ${model.tournamentId}`)}`, '', body, false);
}

export function renderNotFoundFragment(): string {
  return '<p class="notice">Ese partido no está disponible: no es un partido jugado de este campeonato.</p>';
}

export function renderNotFoundPage(): string {
  const body = `<header>
<p class="back"><a href="/">← Volver a la tabla</a></p>
<h1>Partido no encontrado</h1>
</header>
<main>
<section class="group">${renderNotFoundFragment()}</section>
</main>`;
  return htmlDocument('Partido no encontrado', '', body, false);
}

// ---------------------------------------------------------------------------
// Styles and script
// ---------------------------------------------------------------------------

const STYLES = `
:root{
  --bg:#f6f7f9; --card:#fff; --fg:#16181d; --muted:#6b7280; --line:#e4e7ec;
  --accent:#0d6d4f; --accent-soft:#e7f4ee; --warn-bg:#fdf3d8; --warn-fg:#7a5c00;
  --win:#127a4b; --draw:#8a6d1f; --loss:#b3261e; --zebra:#fafbfc; --panel:#f2f4f7; --detail:#fff;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#101216; --card:#171a20; --fg:#e8eaed; --muted:#9aa2ae; --line:#272b33;
    --accent:#4ade9f; --accent-soft:#12281f; --warn-bg:#3a2f10; --warn-fg:#f3d78a;
    --win:#4ade9f; --draw:#e0c069; --loss:#ff8b80; --zebra:#1b1f26; --panel:#1c2027; --detail:#15181e;
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; padding:1rem; background:var(--bg); color:var(--fg);
  font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,Cantarell,"Helvetica Neue",Arial,sans-serif;
  overflow-x:hidden;
}
a{color:var(--accent)}
header,main,footer{max-width:1000px;margin:0 auto}
h1{font-size:1.25rem;margin:0 0 .35rem}
h2{font-size:1rem;margin:0 0 .5rem}
.meta{margin:0 0 .5rem;font-size:.82rem;color:var(--muted)}
.back{margin:0 0 .5rem;font-size:.85rem}
.banner{margin:0 0 1rem;font-size:.8rem;color:var(--muted)}
.banner.warn{background:var(--warn-bg);color:var(--warn-fg);padding:.5rem .75rem;border-radius:8px}
.group{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem;margin-bottom:1rem}
.scroller{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.standings{min-width:640px}
/* Child combinators keep these off the match tables nested inside each panel. */
.standings>thead>tr>th,.standings>tbody>tr>td{padding:.4rem .45rem;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}
.standings>thead>tr>th{
  position:sticky;top:0;background:var(--card);z-index:1;cursor:pointer;user-select:none;
  font-size:.72rem;letter-spacing:.02em;text-transform:uppercase;color:var(--muted)
}
.standings>thead>tr>th:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.standings th[aria-sort="ascending"] .arrow::after{content:" ▲"}
.standings th[aria-sort="descending"] .arrow::after{content:" ▼"}
.standings th[aria-sort="ascending"],.standings th[aria-sort="descending"]{color:var(--accent)}
.standings td.pos{width:2.2rem;color:var(--muted)}
.standings th[data-key="team"],.standings td.team{text-align:left;white-space:normal;min-width:11rem}
.standings>tbody>tr:not(.details):nth-child(4n+3){background:var(--zebra)}
.standings td.pts{font-weight:700}
.standings th[data-key="pperd"],.standings td.pperd{background:var(--accent-soft);font-weight:700;color:var(--accent)}
.toggle{
  font:inherit;color:inherit;background:none;border:0;padding:.1rem .2rem .1rem 0;
  cursor:pointer;text-align:left;display:inline-flex;gap:.35rem;align-items:baseline;border-radius:6px
}
.toggle:hover{color:var(--accent)}
.toggle:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.chev{display:inline-block;transition:transform .12s ease;color:var(--muted);font-size:.8em}
.toggle[aria-expanded="true"] .chev{transform:rotate(90deg)}
.plain{padding:.1rem 0}
.standings>tbody>tr.details>td{padding:0;border-bottom:1px solid var(--line);background:var(--panel);text-align:left;white-space:normal}
/* The standings table may scroll sideways on a phone; its open panel stays pinned to the visible width. */
.panel{padding:.6rem .5rem .7rem 1.4rem;overflow-x:auto;position:sticky;left:0;max-width:calc(100vw - 3.8rem)}
/* Hugs its content instead of stretching, so the columns stay close enough to read as one line. */
.matches{width:auto;font-size:.82rem}
.matches th{
  text-align:left;color:var(--muted);font-weight:600;font-size:.68rem;text-transform:uppercase;
  padding:.2rem .55rem .2rem 0;border-bottom:1px solid var(--line)
}
.matches td{text-align:left;padding:.28rem .55rem .28rem 0;border-bottom:1px solid var(--line);white-space:nowrap}
.matches>tbody>tr:last-child>td{border-bottom:0}
.matches .opp{white-space:normal}
.matches .md,.matches .ha,.matches .oc{color:var(--muted)}
.matches .vn{color:var(--muted);font-size:.95em}
.matches tr.match{cursor:pointer}
.matches tr.match:hover>td{color:var(--fg)}
.match-link{color:inherit;text-decoration:underline dotted;text-underline-offset:3px;border-radius:4px}
.match-link:hover,.match-link[aria-expanded="true"]{color:var(--accent)}
.match-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.matches .libre{color:var(--muted);font-style:italic}
.oc{font-weight:700}
.oc-W{color:var(--win)} .oc-D{color:var(--draw)} .oc-L{color:var(--loss)}
.matches tr.match-detail>td{padding:.2rem 0 .6rem;white-space:normal;border-bottom:1px solid var(--line)}
/* A zero-width slot: the card neither widens the match columns nor gets squeezed to their width. */
.md-slot{width:0;overflow:visible}
.md-slot>*{width:min(34rem, calc(100vw - 5rem))}
.remaining{margin:.55rem 0 0;font-size:.82rem}
.remaining summary{cursor:pointer;color:var(--muted)}
.remaining summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.remaining p{margin:.35rem 0 0;line-height:1.5}
.remaining-none{margin:.55rem 0 0;font-size:.82rem;color:var(--muted)}
.empty{color:var(--muted);margin:.4rem 0;font-size:.85rem}
.warn{color:var(--warn-fg);background:var(--warn-bg);padding:.35rem .5rem;border-radius:6px;margin:.5rem 0 0;font-size:.78rem}
.match-card{background:var(--detail);border:1px solid var(--line);border-radius:10px;padding:.65rem .75rem;max-width:34rem;font-size:.85rem}
.match-card p{margin:.25rem 0}
.mc-meta,.mc-when{color:var(--muted);font-size:.8rem}
.mc-score{font-size:1rem;display:flex;flex-wrap:wrap;gap:.25rem .5rem;align-items:baseline}
.mc-score strong{font-variant-numeric:tabular-nums;white-space:nowrap}
.notice{color:var(--warn-fg);background:var(--warn-bg);padding:.35rem .5rem;border-radius:6px;font-size:.8rem}
.loading{color:var(--muted);font-size:.8rem}
.note{color:var(--muted);font-size:.8rem}
.mvp{font-size:.82rem}
.muted{color:var(--muted)}
.timeline{list-style:none;margin:.5rem 0;padding:0}
.timeline .period{margin:.45rem 0 .15rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.03em;color:var(--muted);text-align:center}
.ev{display:grid;grid-template-columns:1fr 3.4rem 1fr;align-items:baseline;padding:.12rem 0}
.ev .min{grid-column:2;grid-row:1;text-align:center;color:var(--muted);font-variant-numeric:tabular-nums}
.ev .what{grid-row:1}
.ev.home .what{grid-column:1;text-align:right}
.ev.away .what,.ev.none .what{grid-column:3}
.ev .side{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.ev .kind{white-space:nowrap}
.mc-links{font-size:.8rem}
footer{margin-top:1rem;color:var(--muted);font-size:.75rem}
footer p{margin:.25rem 0}
@media (max-width:520px){
  body{padding:.6rem}
  .group{padding:.6rem;border-radius:10px}
  .panel{padding-left:.6rem;max-width:calc(100vw - 2.6rem)}
  /* The venue is in the match detail; dropping it here keeps the match list inside a phone screen. */
  .matches>thead>tr>th:last-child,.matches .vn{display:none}
  .ev{grid-template-columns:3rem 1fr}
  .ev .min{grid-column:1;text-align:left}
  .ev.home .what,.ev.away .what,.ev.none .what{grid-column:2;text-align:left}
  .ev .side{position:static;width:auto;height:auto;overflow:visible;clip:auto;color:var(--muted)}
}
`;

const SCRIPT = `
(function(){
  var tables = document.querySelectorAll('table.standings');

  function value(row, index, numeric){
    var cell = row.children[index];
    if(!cell) return numeric ? 0 : '';
    var raw = cell.getAttribute('data-sort');
    if(numeric) return raw === null ? 0 : parseFloat(raw);
    return (raw === null ? cell.textContent : raw).trim().toLocaleLowerCase('es');
  }

  function sort(table, index, numeric, direction){
    var body = table.tBodies[0];
    var rows = [];
    // Each team row travels with its panel row, so an open panel stays under its team.
    Array.prototype.forEach.call(body.children, function(row){
      if(row.classList.contains('details')) return;
      var details = row.nextElementSibling;
      rows.push({ row: row, details: details && details.classList.contains('details') ? details : null });
    });

    rows.sort(function(a, b){
      var x = value(a.row, index, numeric), y = value(b.row, index, numeric);
      if(x < y) return -direction;
      if(x > y) return direction;
      return parseInt(a.row.getAttribute('data-pos'), 10) - parseInt(b.row.getAttribute('data-pos'), 10);
    });

    var fragment = document.createDocumentFragment();
    rows.forEach(function(entry){
      fragment.appendChild(entry.row);
      if(entry.details) fragment.appendChild(entry.details);
    });
    body.appendChild(fragment);
  }

  Array.prototype.forEach.call(tables, function(table){
    var headers = table.tHead.rows[0].cells;

    function activate(header){
      var index = header.cellIndex;
      var numeric = header.getAttribute('data-numeric') === 'true';
      var current = header.getAttribute('aria-sort');
      var direction;
      if(current === 'ascending') direction = -1;
      else if(current === 'descending') direction = 1;
      else direction = header.getAttribute('data-desc') === 'true' ? -1 : 1;

      Array.prototype.forEach.call(headers, function(other){ other.setAttribute('aria-sort', 'none'); });
      header.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
      sort(table, index, numeric, direction);
    }

    table.tHead.addEventListener('click', function(event){
      var header = event.target.closest('th');
      if(header) activate(header);
    });

    table.tHead.addEventListener('keydown', function(event){
      if(event.key !== 'Enter' && event.key !== ' ') return;
      var header = event.target.closest('th');
      if(!header) return;
      event.preventDefault();
      activate(header);
    });

    table.tBodies[0].addEventListener('click', function(event){
      var button = event.target.closest('.toggle');
      if(!button) return;
      var panel = document.getElementById(button.getAttribute('aria-controls'));
      if(!panel) return;
      var open = button.getAttribute('aria-expanded') === 'true';
      button.setAttribute('aria-expanded', open ? 'false' : 'true');
      panel.hidden = open;
    });
  });

  function showFailure(cell, href){
    var notice = document.createElement('p');
    notice.className = 'notice';
    notice.appendChild(document.createTextNode('No se pudo cargar el detalle. '));
    var link = document.createElement('a');
    link.href = href;
    link.textContent = 'Abrir el partido';
    notice.appendChild(link);
    cell.textContent = '';
    cell.appendChild(notice);
  }

  function load(link, detail){
    var cell = detail.querySelector('.md-slot');
    var href = link.getAttribute('href');
    detail.setAttribute('data-state', 'loading');
    cell.innerHTML = '<p class="loading" role="status">Cargando detalle…</p>';
    fetch(href + '?embed=1', { headers: { accept: 'text/html' } })
      .then(function(response){
        if(!response.ok) throw new Error('HTTP ' + response.status);
        return response.text();
      })
      .then(function(html){
        // Served by this site from escaped data, never from the browser's input.
        cell.innerHTML = html;
        detail.setAttribute('data-state', 'loaded');
      })
      .catch(function(){
        detail.removeAttribute('data-state');
        showFailure(cell, href);
      });
  }

  function toggleMatch(link){
    var row = link.closest('tr');
    var detail = document.getElementById(link.getAttribute('aria-controls'));
    if(link.getAttribute('aria-expanded') === 'true'){
      link.setAttribute('aria-expanded', 'false');
      if(detail) detail.hidden = true;
      return;
    }
    if(!detail){
      detail = document.createElement('tr');
      detail.className = 'match-detail';
      detail.id = link.getAttribute('aria-controls');
      var cell = document.createElement('td');
      cell.colSpan = row.children.length;
      var slot = document.createElement('div');
      slot.className = 'md-slot';
      cell.appendChild(slot);
      detail.appendChild(cell);
      row.parentNode.insertBefore(detail, row.nextSibling);
    }
    link.setAttribute('aria-expanded', 'true');
    detail.hidden = false;
    var state = detail.getAttribute('data-state');
    if(state !== 'loaded' && state !== 'loading') load(link, detail);
  }

  // A match opens inline; a modified click (new tab, etc.) keeps the plain link behaviour.
  document.addEventListener('click', function(event){
    if(event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var link = event.target.closest('a.match-link');
    if(!link){
      var row = event.target.closest('tr.match');
      if(!row || event.target.closest('a, button, summary')) return;
      link = row.querySelector('a.match-link');
      if(!link) return;
    }
    event.preventDefault();
    toggleMatch(link);
  });
})();
`;
