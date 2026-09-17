## Context

See `proposal.md` (Why). The technical facts below were measured live on 2026-09-16 while investigating `https://www.ligapro.uy/campeonatos/549`.

**How the site gets its data.** `www.ligapro.uy` is a Next.js app. Its tabs are filled by client-side `fetch` calls to route handlers under `https://www.ligapro.uy/api/…`. Those handlers proxy to `https://api-web.ligapro.uy` using a server-side `INTERNAL_API_KEY`, which the public bundle references but never contains. The `/api/*` routes need no auth, cookies or special headers, answer JSON, and sit behind CloudFront plus a proxy cache (`x-proxy-cache: HIT|MISS`, no `ETag` or `Last-Modified`). They are rate-limited: the bundle explicitly handles HTTP 429 for several of them, and during fixture capture on 2026-09-17 LigaPro began answering 429 after about 65 requests in 2.5 minutes, clearing again within a minute. Match pages (`/juego/{id}`) are server-rendered, but the same bundle carries client fallbacks for the per-game routes below, and those routes answer directly.

| Route (under `https://www.ligapro.uy/api/`) | Returns | Size |
| --- | --- | --- |
| `tournaments/549` | `{id, name, start_at, finish_at, current_groupweek_id, …}`, dates as `DD/MM/YYYY` | 0.3 KB |
| `tournaments/549/positions` | `{has_groups, data, qualification_legend}`. `data` is `[{name, qualify, positions: [row…]}]` when grouped, or `[row…]` when flat (tournament 520). A row is `{id, position, name, logo, slug, points, games, games_won, games_tied, games_lost, goals_for, goals_against, goals_difference, …}`, all JSON numbers | 7.6 KB |
| `tournaments/549/groupweeks` | `{data: [{id, name: "Jornada 4", date: "12/09/2026", order: 4}, …]}` (15 entries) | 1 KB |
| `tournaments/549/games` | `{data: [{id, local_team_name, local_team_logo, local_team_result, visiting_team_name, visiting_team_logo, visiting_team_result, date, hour, stadium}, …]}`: the whole fixture (105 games), **no jornada field, no team ids** | 43 KB |
| `tournaments/549/games?filter[groupweek][0]={id}` | same shape, one jornada's 7 games | 2.9 KB |
| `games/{id}/info` | `{groupweek_name, tournament_name, date, hour, stadium, local_team: {id, name, logo, result, …}, visiting_team: {…}}`, or `404 {"errors":[…]}` | 0.7 KB |
| `games/{id}/events` | `{data: [{id, player_name, team_id, type_id, type_name, period, minutes, seconds}, …]}` | ~1.6 KB |
| `games/{id}/mvps` | `{data: [{id, name, avatar, team_logo, rating}, …]}`: the featured players, at most one per team, identified only by `team_logo` | 0.2–0.5 KB |

Latency averaged 0.33 s (max 1.35 s) over 56 sequential requests.

**Data facts for tournament 549** (15 teams in one group, "Divisional B"; 15 jornadas; a single round-robin with one bye per jornada; 28 of 105 games played):

- **The two feeds agree.** Counting a game as played exactly when both results are non-null, the fixture reproduces every team's `games`, `games_won`, `games_tied`, `games_lost`, `goals_for` and `goals_against`, for all 15 teams.
- **The fixture identifies teams only by name and logo.** Names carry stray whitespace (`"La  Axioneta "`, `"C.A.Ankara "`, `"Sportivo Malvin "`) but are byte-identical to the standings' names, and logo URLs are identical across both feeds.
- **The union of the 15 per-jornada lists equals the unfiltered fixture exactly**: no duplicates, nothing missing. Per-jornada requests are the only source of jornada membership. The `include` parameter makes the route error, and `fields` and `append` are ignored.
- **Dates cannot be trusted.** Jornada 3's games are dated 28/11/2026 yet already have scores. Jornada 15's are dated 05/09/2026 and still pending. Jornada 2 mixes 29/08 and 12/09. Games were evidently moved between jornadas without meaningful date updates. `current_groupweek_id` points at Jornada 4 (12/09), although Jornada 5 (19/09) is the next to be played.
- **`hour` is `"00:00"` in all ~430 games sampled** across six tournaments. Venues have double spaces (`"Complejo  LigaSiete"`) and `"-"` placeholders.
- **Event types seen:** `1` "Gol a Favor" (153), `8` "Asistencias" (13), `3` "Tarjeta Amarilla" (9), `4` "Tarjets Roja" [sic] (1). Periods are `FIRST_TIME` and `SECOND_TIME`. Seconds are always `0`. Events arrive unordered, and an assist shares its goal's minute. The 9 yellow-card events match the tournament-wide `yellow-cards` total.
- **Events are best-effort.** Games to capture as fixtures:

  | Game | Score | What its events show |
  | --- | --- | --- |
  | 30237 | 3-0 | No events at all; both teams have default rank values, likely a walkover |
  | 30240 | 2-2 | Only the home side's goals recorded |
  | 30258 | 1-9 | One of the winner's goals missing |
  | 30239 | 2-2 | Assists and three yellow cards |
  | 30259 | 3-4 | A red card |
  | 30248 | 1-10 | Unordered events |

- **A nonexistent tournament answers `200` with `data: []`.** A real tournament that has not started still lists its teams at zero games (tournament 520).

**Ligador** is the reference implementation (Node 22, TypeScript, Fastify, `node:test`, multi-stage Dockerfile). Its `src/` modules — `config`, `upstream`, `model`, `store`, `aggregate`, `diff`, `poll`, `scheduler`, `telegram`, `notify`, `format`, `render`, `server`, `index` — map almost one-to-one onto this service (D2).

## Goals / Non-Goals

**Goals:**

- The main page renders from memory in milliseconds and never waits on LigaPro. Only a match detail can wait on upstream, and only on a cache miss.
- Be a gentle client of a rate-limited API: about 2 requests per 5-minute poll in steady state.
- Stay correct under the observed upstream quirks: unreliable dates, placeholder times, whitespace in names and venues, partial events, misspelled labels, mixed standings shapes.
- Reuse what already works in Ligador instead of reinventing it.
- Moving to the next tournament is a config edit.

**Non-Goals:**

- Calling `api-web.ligapro.uy` or using its internal key, parsing RSC payloads or HTML, or driving a headless browser.
- Persisting match details, keeping history, or charting trends.
- A frontend framework, bundler or browser build step.
- Reloading an open page by itself. Data refreshes server-side on every poll, and the page shows how fresh it is, as Ligador does.
- Special handling for knockout brackets. A phase without standings renders whatever the fixture-derived views can show.

## Decisions

### D1: Consume the public `www.ligapro.uy/api/*` routes

These are the calls LigaPro's own browser code makes, so they are the most stable contract available. They are keyless, return JSON, and are small.

*Alternatives considered:*

- **Calling `api-web.ligapro.uy` directly.** Rejected: it needs the site's server-side `INTERNAL_API_KEY`. Obtaining or using that would be both inappropriate and brittle.
- **Parsing the RSC payload or HTML of `/juego/{id}`.** Rejected: an undocumented serialization format, larger responses, and it breaks on any redeploy.
- **A headless browser.** Rejected for the same reasons as Ligador D1.

*Risk accepted:* the routes are undocumented. Mitigated by strict boundary validation (D6) and by keeping every route shape in one module.

### D2: Same stack as Ligador, modules copied and adapted

This service uses Node.js 22, TypeScript (strict, NodeNext), Fastify, native `fetch`, `node:test` with `tsx`, and a multi-stage non-root Dockerfile. There are no runtime dependencies beyond Fastify.

| Module | Source | What changes |
| --- | --- | --- |
| `scheduler.ts` | Ligador, copied | The next delay can be raised by a backoff returned from the run (D5) |
| `telegram.ts` | Ligador, copied | Logs Telegram's own reason when it refuses a message; otherwise unchanged |
| `format.ts` | Ligador, copied | Adds text-only formatting of upstream `DD/MM/YYYY` dates (D15) |
| `config.ts` | Ligador, adapted | New upstream and cache variables (D14) |
| `store.ts` | Ligador, adapted | Four feeds and a snapshot keyed by tournament id (D11) |
| `diff.ts` | Ligador, adapted | Keyed by team id and game id; adds cleared results (D12) |
| `notify.ts` | Ligador, adapted | New entry lines and startup content (D13) |
| `render.ts` | Ligador, adapted | Groups, header, remaining opponents, inline match detail (D10) |
| `server.ts` | Ligador, adapted | Match detail routes (D8) |
| `upstream.ts` | Rewritten | LigaPro routes, validators, 429 handling (D5, D6) |
| `aggregate.ts` | Rewritten | `PPerd`, team linking, played and remaining views (D7) |
| `poll.ts` | Rewritten | Two cadences, sequential pacing (D3, D4) |
| `details.ts` | New | On-demand match details (D8, D9) |

*Alternative considered:* extracting a shared package used by both repos. Rejected: two small independent services would share only ~400 lines, and a package would couple their release cycles for no user-visible gain. Revisit if a third tracker appears.

### D3: Two cadences: live feeds every poll, structure on refresh

- **Every poll** requests the standings and the unfiltered fixture: 2 requests, ~51 KB. That is enough to detect every new, corrected or cleared result and every standings movement.
- **A structure refresh** requests the tournament info, the jornada list, and one filtered fixture request per jornada: 2 + N requests, 17 for this tournament, ~45 KB. It runs when any of these holds:
  - no refresh has ever succeeded;
  - `JORNADA_REFRESH_MINUTES` (default 60) have passed since the last success;
  - the fixture contains a game id absent from the fixture at the last successful refresh.

  The last trigger is compared against the fixture ids recorded at that refresh, not against the assignment. A game upstream lists under no jornada therefore triggers exactly one extra refresh, not one per poll.
- **Jornada assignment is replaced all at once.** It is a map from game id to jornada id, applied only if the jornada list and every per-jornada response validate. Tournament info is applied independently.
- **The resulting load** at defaults is about 24 + 17 ≈ 41 requests an hour (~1,000 a day), against ~204 an hour (~4,900 a day) if every poll walked every jornada.

The map is keyed by game id because ids are stable: a rescheduled game keeps its id and simply appears under another jornada.

*Alternatives considered:*

- **Walking every jornada on every poll.** Simplest to reason about, but five times the load on a rate-limited API for data that changes a few times a season.
- **The unfiltered fixture alone.** Loses jornadas entirely. Ordering by date instead is wrong for this tournament (see Context).
- **Per-game `info` for `groupweek_name`.** One request per game, 105 of them. Rejected.

### D4: Sequential, paced requests within a poll

Each upstream request of a poll is awaited before the next begins, with a constant 250 ms gap. A poll with a structure refresh takes about 19 × (0.35 s + 0.25 s) ≈ 11 s. Even with every request hitting the 10 s timeout it stays around 3 minutes, inside the 5-minute interval. The scheduler's in-flight guard covers anything worse.

Each request's outcome is still recorded on its own, as Ligador's `attempt()` does, so feeds stay independent (see the `tournament-ingestion` spec).

*Alternative considered:* Ligador's `Promise.all`. Fine for Ligador's 4 requests, but firing 19 concurrently at a rate-limited proxy is how you get HTTP 429.

### D5: Rate-limit backoff shared by polls and match details

`upstream.ts` turns a 429 into a `RateLimitedError` carrying `Retry-After` when that header is a number of seconds (HTTP-date values are ignored). The poll stops at that request and records the unsent feeds as failed with reason "rate limited". It returns `backoffMs`:

```
backoffMs = max(retryAfterMs, min(interval × 2^n, max(60 min, interval)))
```

Here `n` counts consecutive rate-limited polls, starting at 1.

- The scheduler uses `max(normal jittered delay, backoffMs)` for the next run.
- The shared `RateLimitState` records `until`. `details.ts` reads it (D8), and `/health` and the page expose it.
- The first poll with no 429 resets `n`.

*Alternative considered:* treating 429 like any other failure and retrying next poll. Rejected: at a 5-minute cadence that keeps poking a server that just asked us to stop, and it risks a harder block.

### D6: Hand-written validation at the boundary

This follows Ligador D6. There is no schema library: the shapes are few and fixed, and the guards stay small.

- **Integers.** One `integer()` helper accepts a JSON integer or an all-digit string. LigaPro already mixes the two (`ratings.goal` is `"2"` while its siblings are numbers), so tolerating either costs nothing. It rejects `""`, `"12abc"`, fractions and negatives. A signed variant is used only for `goals_difference`.
- **Standings.** The grouped shape (`has_groups: true`, entries with `positions`) and the flat shape are both accepted, and anything else is rejected. Zero teams in total is rejected, since that is what a wrong tournament id looks like.
- **Fixture.** An id is a positive integer; names are non-empty after normalization; scores are both null or both non-negative integers.
  - `date` is parsed as `DD/MM/YYYY`, checked to be a real calendar date, and stored as text `YYYY-MM-DD`, or null.
  - `hour` is stored as `HH:MM`, with `"00:00"` and anything unparseable becoming null.
  - `stadium` is normalized, with `""` and `"-"` becoming null.
  - An empty `data` array is rejected when a non-empty fixture is stored. This guard stops a transient empty `200` from turning into 28 "cleared result" notifications.
- **Jornadas.** An id is a positive integer, the name is non-empty, the order is an integer, and the date is lenient.
- **Tournament.** Id and name are required, dates are lenient, and `current_groupweek_id` is an integer or null.
- **Match info, events and MVPs** are covered in D9.

Display names are normalized once at the boundary: trimmed, with whitespace runs collapsed. The case-insensitive matching key is derived later (D7).

### D7: Team linking and per-team views are derived at read time

Nothing derived is stored. On each render (and for `/api/standings`), `aggregate.ts` computes the following from the stored standings, fixture and jornada assignment:

- **`PPerd`** is `3 × games_lost + 2 × games_tied`. `position`, `points` and `goals_difference` pass through untouched; the default order is `position`, with the spec's tiebreak for collisions.
- **Links** go from each fixture side to a team id. The key is Ligador's `teamKey()`: trim, collapse whitespace, `toLocaleUpperCase('es')`. The fallback is a logo URL owned by exactly one team.
- **Played matches** are oriented per team, with outcome derived from goals. The sort key is `(jornada.order ?? ∞, date ?? "9999-12-31", game.id)`.
- **Remaining opponents** come from pending games in the same order, deduplicated by linked team id (or by key when unlinked), with counts.
- **Byes** are, for each jornada with at least one assigned game, the teams linked to no game in it.
  - A bye is `past` when every game assigned to that jornada is played, and `upcoming` otherwise. Neither upstream dates nor `current_groupweek_id` (whose meaning is unclear) are consulted.
  - Nothing is derived while jornada assignment is unknown, or for a team linked to no game, which would otherwise look free in every jornada.
  - Checked against the captured data: each of the 15 teams gets exactly one bye, and the past byes belong exactly to the four teams on `PJ=3` (Jornadas 1–4), which is what makes unequal `PJ` legible.
- **The consistency flag** compares played count and W/D/L with `PJ`, `PG`, `PE` and `PP`, as in Ligador D12.

Deriving at read time means a fix to linking or ordering takes effect without touching the snapshot. The cost is trivial: 15 teams × 105 games.

### D8: Match details are on-demand, cached, single-flight, allowlisted and budgeted

`/partido/{id}`, `/partido/{id}?embed=1` and `/api/matches/{id}` all call `MatchDetails.get(id)`:

1. **Allowlist.** `id` must be a played game in the stored fixture. Otherwise the answer is 404 with no upstream call, so the service cannot be used as an open proxy onto arbitrary LigaPro data.
2. **Fresh cache.** A cached entry younger than `MATCH_DETAILS_TTL_MINUTES` (default 15) is returned as-is.
3. **Single flight.** If a retrieval for `id` is already in flight, the call awaits that one promise.
4. **Load guard.** If a backoff is active, or the rolling-minute budget `MATCH_DETAILS_REQUESTS_PER_MINUTE` (default 20) cannot cover the two required requests, the call returns the stale entry (`status: "stale"`) or the fixture-based basic view (`status: "unavailable"`).
5. **Retrieval.** `info` then `events`, each counted against the budget, then `mvps` only if budget remains. A failure in `mvps` is swallowed. Success is stored with `fetchedAt`. Any other failure falls back as in step 4.

When a poll's result diff finds a corrected or cleared result, it calls `invalidate(id)` for that game. The cache lives only in memory and is bounded by the number of played games, so it needs no eviction.

*Why lazy:*

- Polling details for every played match (3 routes × up to 105 games) would dominate upstream load.
- Events keep being filled in after the score is posted, so a one-shot eager fetch would go stale anyway.
- One person opens a handful of matches.

The budget also caps what a crawler hitting `/partido/*` can cause upstream: 20 requests a minute, whatever the traffic.

*Alternatives considered:*

- **Eagerly fetching details when a result first appears, then refreshing "recent" matches.** Upstream dates cannot say what is recent, so this would need our own first-seen timestamps and a second scheduler, for a feature used occasionally.
- **Embedding every match's timeline in the page.** Each match appears in two team panels, and most are never opened. Rejected.

*Trade-off accepted:* the first view of a match waits on upstream, ~0.3–1.4 s measured. Later views within the TTL are instant.

### D9: Event normalization and timeline

- **Kind** comes from `type_id`: `1` goal, `8` assist, `3` yellow card, `4` red card. Anything else is `other`, carrying the normalized `type_name`. Labels are never matched against, since upstream spells the red card "Tarjets Roja".
- **Side** comes from `team_id` compared with `info.local_team.id` and `info.visiting_team.id`, and is unattributed otherwise. Using `info` means attribution never depends on name linking.
- **Period** maps `FIRST_TIME` to `1T` and `SECOND_TIME` to `2T`. Other values keep their raw label and rank after `2T`, alphabetically.
- **Sort key** is `(periodRank, minutes, seconds, kindRank[goal, assist, yellow, red, other], id)`.
- **Reconciliation** is computed per side: `missing = score − goalEvents` when positive. `events.length === 0` produces the "no events recorded" state.
- **Validation.** `events.data` must be an array, or the retrieval fails. An individual event with a missing or invalid `type_id`, `team_id`, `minutes` or `seconds` is dropped and logged, so one bad row does not hide a whole timeline. An empty `player_name` is shown as unknown.
- **Featured players** are every entry in `mvps.data`, at most one per team (three of the four captured matches list two). The route gives no team id, so each is attributed to a side by comparing its `team_logo` with the team logos in `info`, and is shown without a team when neither matches.
- **Display.** Minutes render as `MM'`, or `MM'SS"` when seconds are non-zero. Each kind is an emoji followed by a text label (`⚽ Gol`, `👟 Asistencia`, `🟨 Amarilla`, `🟥 Roja`), so meaning never depends on the symbol alone. The layout is two columns, home left and away right, like LigaPro's own match page, collapsing to one column with a side marker on narrow screens.

### D10: Server-rendered page with inline detail fragments

This follows Ligador D5 and D11: HTML built from memory, one inline `<style>`, one inline script (~120 lines), no external assets, and every upstream string escaped.

- **Tables.** Each standings group is its own `<table>`, sorted by Ligador's delegated script with independent state per table. Each team row moves together with its `<tr class="details">` panel sibling. `<noscript>` shows every panel.
- **Team panel.**
  - A played-matches table (Jornada, Día, L/V, Rival, Resultado, R, Cancha).
  - A past bye is a `<tr class="bye">` at its jornada position: the jornada cell, then one cell spanning the rest that reads *Libre*, with no match link.
  - After the table comes `<details><summary>Le quedan 10 rivales · libre en Jornada 5</summary><p>TFC, Sportivo Malvin, …</p></details>`. The `· libre en …` suffix appears only for upcoming byes. The native disclosure needs no JavaScript and is collapsed by default.
- **Match rows.** The score cell is `<a class="match" href="/partido/{id}" aria-expanded="false" aria-controls="md-{table}-{team}-{id}">`, and the script also forwards clicks anywhere on the row.
  - On first activation the script inserts `<tr class="match-detail">` after the row with a loading state, then fills it from `fetch('/partido/{id}?embed=1')`.
  - Later activations just toggle `hidden`.
  - On failure the row shows a message linking to `/partido/{id}`.
  - Match-detail rows live inside the team panel's inner table, so sorting the standings carries them along.
- **A single renderer** builds the match detail. `?embed=1` returns only that fragment; without it the fragment is wrapped in a small page with the tournament header and a link back to `/`.
- **Header.** Tournament name, `DD/MM/YYYY – DD/MM/YYYY`, "Jornada N de M" derived from `current_groupweek_id` and the jornada list, the freshness line, and a link to `https://www.ligapro.uy/campeonatos/{id}`.
- **Look.** Carried over from Ligador: CSS custom properties, a `prefers-color-scheme: dark` variant, a highlighted `PPerd` column, sticky headers, tabular numbers, and scroll containers so nothing scrolls sideways at 375px.
- **Caching headers.**
  - `/` and `/api/standings`: `public, max-age=30`.
  - Match detail responses: `public, max-age=60` when fresh, `no-store` when stale or unavailable, so a browser never pins a failure.

*Alternative considered:* rendering match details client-side from `/api/matches/{id}` JSON. Rejected: it duplicates the renderer and its escaping in browser code. Fetching server-rendered fragments keeps one renderer.

### D11: In-memory store with a tournament-scoped snapshot

The store holds four `FeedState<T>` values, using Ligador's `{data, fetchedAt, lastAttemptFailed, lastError}` shape: `tournament`, `standings` (groups of rows), `fixture` (games), and `jornadas` (`{list, assignment: Record<gameId, jornadaId>, fixtureIdsAtRefresh}`). Backoff state lives with the poller and is not persisted.

After any poll with at least one success, the snapshot `{version: 1, tournamentId, savedAt, feeds}` is written atomically (temp file, then rename) to `SNAPSHOT_PATH`. At boot:

- a missing or corrupt snapshot means a cold start, with a warning;
- a snapshot whose `tournamentId` differs from the configured one is ignored, so switching tournaments can never produce a cross-tournament diff.

The match-details cache is not persisted.

### D12: Change detection

- **Standings.** The canonical form is rows sorted by team id, each rendered as `id|pj|pg|pe|pp|gf|gc|pts`. When two canonical forms differ, the per-team diff lists added and removed teams (by id) and, for updated teams, the changed fields plus the before and after official `position` and `PPerd`.
- **Results.** Games are compared by id: stored pending or missing to played is **new**; played to played with a different score is **corrected**; played to pending or missing is **cleared**. Date, time, venue and jornada are ignored.
- **Baseline rules** follow Ligador: no baseline (a cold start) means nothing is reported, and a failed or rejected feed contributes nothing.
- Corrected and cleared results call `details.invalidate(id)` (D8).

Jornada labels in messages come from the current assignment. An unknown jornada simply drops the prefix.

### D13: Telegram delivery reused from Ligador

The sender (3 attempts with exponential backoff on 5xx and network errors, fail-fast on 4xx), `packMessages` (splits on entry boundaries, labels parts `(i/n)`, bounded by `TELEGRAM_MAX_MESSAGES_PER_POLL`) and `sendAll` are copied from Ligador D8 and D13. The one addition is logging Telegram's `description` when it refuses a message, so a wrong chat id reads as "chat not found" rather than a bare 400. Only the entries differ:

```
🏆 Cambios · Serie 4 / Divisional B / Clausura 2026
⚽ Jornada 5: Real Rejunte 2-1 Babacar FC
✏️ Resultado corregido — Jornada 2: Babacar FC 1-10 Universidad ORT Uruguay (antes 1-9)
↩️ Resultado anulado — Jornada 2: Babacar FC vs Universidad ORT Uruguay (era 1-9)
📊 Universidad ORT Uruguay: PJ 3→4, PG 2→3, GF 15→19, GC 6→7, Pts 7→10 ⬆️ 4º→1º
📊 Babacar FC: PJ 3→4, PP 3→4, GF 3→4, GC 16→18, PPerd 9→12
```

- Result lines come before standings lines.
- **Result lines never carry scorers** (decided). Notifications therefore stay independent of match details, which the poll never retrieves (D8), and scorers recorded after the score can never delay a result line or send a second one.
- A `<b>group</b>` sub-header is added only when there is more than one group.
- The startup message reads `♻️ prort reiniciado`, followed by the tournament name, the top 3 of each group as `1. Real Rejunte — 10 pts (PPerd 2)`, `actualizado DD/MM HH:MM` in `DISPLAY_TIMEZONE`, and `SITE_URL` when set.
- All text is HTML-escaped for `parse_mode: HTML`.

### D14: Configuration validated once at startup

This follows Ligador D10: `config.ts` is the only reader of `process.env`, and it reports every problem at once. `.env.example` documents every variable.

| Variable | Default | Notes |
| --- | --- | --- |
| `UPSTREAM_BASE_URL` | `https://www.ligapro.uy` | http(s) only; trailing slash stripped |
| `UPSTREAM_TOURNAMENT_ID` | `549` | Positive integer |
| `UPSTREAM_TIMEOUT_MS` | `10000` | Per request |
| `UPSTREAM_USER_AGENT` | `prort/1.0 (+standings mirror; contact: repo owner)` | |
| `POLL_INTERVAL_MINUTES` | `5` | |
| `POLL_JITTER_SECONDS` | `30` | `0` disables |
| `JORNADA_REFRESH_MINUTES` | `60` | Structure refresh cadence (D3) |
| `MATCH_DETAILS_TTL_MINUTES` | `15` | D8 |
| `MATCH_DETAILS_REQUESTS_PER_MINUTE` | `20` | Upstream budget for details (D8) |
| `PORT`, `HOST`, `LOG_LEVEL` | `3000`, `0.0.0.0`, `info` | |
| `DISPLAY_TIMEZONE` | `America/Montevideo` | Validated IANA zone |
| `SITE_URL` | empty | Used in Telegram messages |
| `SNAPSHOT_PATH` | `./data/snapshot.json` | |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | empty | Both or neither |
| `TELEGRAM_MAX_MESSAGES_PER_POLL` | `5` | 1–20 |

### D15: Two kinds of time, handled differently

Ligador's `format.ts` rule carries over.

- **Our own timestamps** (retrieval times, next poll) are UTC ISO strings rendered in `DISPLAY_TIMEZONE`, never the host's zone.
- **Upstream dates and times** are local wall-clock text. They are reformatted as text (`DD/MM` in tables, `DD/MM/YYYY` in match details) and never pass through `Date`, so no zone arithmetic can shift them.
- **The `00:00` placeholder** is dropped at the boundary (D6).

## Risks / Trade-offs

- **[LigaPro changes the routes' shape or removes them]** → Strict validation keeps serving the last good data, the freshness warning surfaces the staleness, and every route shape lives in `upstream.ts`.
- **[Rate limiting tightens, or the host gets blocked]** → Sequential pacing, low steady-state volume, exponential backoff honoring `Retry-After`, and a descriptive `User-Agent`. The interval, the jornada refresh cadence and the detail budget are all env-tunable to back off further.
- **[The CDN starts rejecting non-browser clients]** → Not observed (plain `curl` and Python clients got `200`). `UPSTREAM_USER_AGENT` is configurable, and failures surface on the page and in `/health`.
- **[Dates keep contradicting status]** → Status comes only from scores, and ordering uses jornadas. Dates are displayed as sent, never interpreted.
- **[Jornada labels lag a reschedule by up to `JORNADA_REFRESH_MINUTES`]** → Accepted: labels are presentational, and scores and notifications do not depend on them.
- **[A postponed game moved to another jornada makes both teams look free in the original jornada]** → Accepted: that is what the published assignment says. When the game moves into a team's bye jornada, the usual way to reschedule, the team still shows exactly one bye. A jornada still holding a pending postponed game keeps its byes upcoming until that game is played or moved.
- **[A team is renamed and changes its crest mid-tournament]** → That side goes unlinked. It stays visible under its fixture name, and the team's consistency note flags the missing match, which makes the problem easy to spot. The logo fallback covers renames that keep the crest.
- **[Events are incomplete or recorded late]** → The reconciliation notes say so explicitly, the TTL picks up late entries, and the official match link is always one click away.
- **[A transient empty fixture would mean mass "cleared" notifications]** → An empty fixture is rejected while a non-empty one is stored (D6), and messages per poll are bounded.
- **[A public detail route drives upstream traffic]** → Allowlist, per-minute budget, single flight, TTL and backoff. The worst case is 20 upstream requests a minute.
- **[The first view of a match is slow]** → A loading state is shown. Measured 0.3–1.4 s, and cached afterwards.
- **[`current_groupweek_id` semantics are unclear]** → Shown as upstream's current jornada, without reinterpretation.
- **[The tournament ends and a new one starts under a new id]** → An operator config change plus restart. The tournament-scoped snapshot prevents a bogus cross-tournament diff (D11).
- **[Double round-robins or playoff phases]** → Remaining opponents already deduplicate with counts. Brackets are out of scope.

## Migration Plan

Greenfield: no data to migrate and no existing consumers.

1. Scaffold from Ligador's project files (`package.json` scripts, `tsconfig.json`, `.editorconfig`, `.gitignore`, `.claude/launch.json`), renamed to `prort`. The `Dockerfile` follows at delivery.
2. Capture live payloads as test fixtures, including the edge-case games listed in Context, before implementing parsers.
3. Run locally with Telegram unset. Compare against ligapro.uy: the table, several teams' panels (played matches, byes, remaining opponents), and matches 30237, 30239, 30240, 30258 and 30259.
4. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (Ligador's bot can be reused) and confirm the startup message arrives.
5. Deploy as a single container the same way Ligador is deployed, and set `SITE_URL`. Mount a small volume for `SNAPSHOT_PATH` only if the platform's filesystem is ephemeral and keeping the baseline across deploys matters.
6. Roll back by redeploying the previous image; there is no schema or state to unwind.
