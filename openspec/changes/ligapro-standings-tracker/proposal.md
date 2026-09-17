## Why

LigaPro's tournament page (`https://www.ligapro.uy/campeonatos/549`, *Serie 4 / Divisional B / Clausura 2026*) spreads what a player wants across separate tabs: the table is under **Posiciones**, results are paged one jornada at a time under **Fixture**, and goals and cards are another click away on each match's **Resumen**. It never shows **Puntos Perdidos** (points dropped), cannot re-sort the table, has no per-team view of results and remaining opponents, and cannot say when a result lands without re-opening it. Ligador already solves this for the Liga Universitaria. This change builds the same kind of service for LigaPro.

## What Changes

- **New standalone web service** in this repo (currently only a README), modeled on Ligador: it polls LigaPro's public JSON API, serves one fast page, and sends Telegram messages.
- **Public JSON, no scraping**: the site's own browser code calls unauthenticated `GET` routes under `https://www.ligapro.uy/api/`, and the service calls the same ones:
  - `tournaments/{id}`: name, start and end dates, current jornada.
  - `tournaments/{id}/positions`: standings per group, with the official position and a numeric team id.
  - `tournaments/{id}/groupweeks`: the jornadas.
  - `tournaments/{id}/games`: the whole fixture with scores (`null` while unplayed). `?filter[groupweek][0]={id}` narrows it to one jornada, which is the only way to learn which jornada a game belongs to.
  - `games/{id}/info`, `games/{id}/events`, `games/{id}/mvps`: one match's teams, goals, assists, yellow and red cards (each with minute and player), and featured players.
  - The tournament id (`549`) and base URL are configuration, so the next tournament is a config change.
- **Standings table** with the official columns plus **`PPerd`** = `3 × PP + 2 × PE` (3 per loss, 2 per draw, 0 per win; lower is better), sortable by any column without a reload.
- **Team panel**: selecting a team reveals the matches it has played (jornada, date, home or away, opponent, score, outcome, venue), the jornadas it sits out (*Libre*), and a collapsed, comma-separated list of the teams it still has to play.
- **Match detail**: selecting a played match shows its jornada, date, time when one is recorded, venue and score, a minute-by-minute timeline of goals (with assists) and yellow and red cards, and the featured players (one per team). Details are fetched on demand and cached, not polled for every match.
- **Refresh every 5 minutes** (env-configurable, with jitter), while keeping the load on LigaPro low. LigaPro rate-limits its API, so requests are paced and the service backs off when refused.
- **Telegram notifications**, as in Ligador: a startup message, plus one report per poll covering every new, corrected or cleared result and every standings movement, split across messages rather than truncated.
- **In-memory state** with an optional JSON snapshot so restarts do not report the whole table as changed. No database, no login.

## Capabilities

### New Capabilities

- `tournament-ingestion`: scheduled, paced polling of the LigaPro API for the tournament, standings, fixture and jornada assignment. Covers validation and normalization at the boundary, jittered and non-overlapping scheduling, per-feed failure isolation, rate-limit backoff, and the configurable tournament target.
- `standings-aggregation`: the `PPerd` column, table ordering, linking fixture games to standings teams, and each team's derived views: played matches oriented to that team, byes, remaining opponents, and the consistency check against its standings row.
- `match-details`: on-demand retrieval, caching and normalization of a single match's info, events and featured players. Covers timeline ordering, reconciling recorded goals against the score, bounded upstream load, and the match detail view with its stable URL.
- `standings-web`: the public HTTP surface. Covers the page and its tournament header, sortable standings tables, team panels with played matches, byes and collapsed remaining opponents, the freshness indicator, JSON endpoints, the health endpoint, and lightweight responsive presentation.
- `change-notifications`: detecting standings and result changes against the previous snapshot, and delivering them over Telegram (on change and on startup), with complete, split and bounded message reports.

### Modified Capabilities

None. `openspec/specs/` is empty; this is the first change in the repo.

## Impact

- **New codebase**: Node.js 22 + TypeScript + Fastify, with server-rendered HTML and a small vanilla-JS script, following Ligador's layout. Several Ligador modules (scheduler, Telegram delivery and message packing, timestamp formatting, snapshot store, table sort script) are copied and adapted rather than shared as a package.
- **New runtime configuration** (env vars, documented in `.env.example`): upstream base URL and tournament id, poll interval and jitter, jornada refresh interval, match-detail cache lifetime and request budget, Telegram bot token and chat id, HTTP port, display timezone, snapshot path, public site URL.
- **External dependencies**:
  - The LigaPro public API: unauthenticated and read-only, but rate-limited (its own frontend handles HTTP 429). The default schedule is about 2 requests per poll, plus about 17 requests an hour to refresh jornada assignment, plus match details only when someone opens a match.
  - The Telegram Bot API.
- **Operational**: one process in one container. No database; the snapshot file is an optimization, not a requirement.
- **Non-goals**:
  - LigaPro's Ranking, Sancionados, Videos and Galería tabs, and player ratings.
  - A league-wide results browser by jornada. Results are reached through teams.
  - Team crests, which would add third-party image requests.
  - Notifications for schedule-only changes (date, venue, jornada moves) or for match events (goals, cards). Result messages carry the score, never the scorers.
  - Tracking several tournaments at once, or discovering the next tournament automatically.
  - Accounts, history or charts.
