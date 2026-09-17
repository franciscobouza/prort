## 1. Project setup

- [x] 1.1 Scaffold from Ligador's project files: `package.json` (name `prort`, `"type": "module"`, Node ≥22, scripts `dev`, `build`, `start`, `test`, `typecheck`), `tsconfig.json`, `.editorconfig`, `.gitignore` and `.claude/launch.json` (design D2, Migration Plan step 1)
- [x] 1.2 Add `fastify` as the only runtime dependency and `typescript`, `tsx`, `@types/node` as dev dependencies; run `npm install`
- [x] 1.3 Create the source layout: `src/config.ts`, `upstream.ts`, `model.ts`, `store.ts`, `aggregate.ts`, `diff.ts`, `poll.ts`, `scheduler.ts`, `details.ts`, `telegram.ts`, `notify.ts`, `format.ts`, `render.ts`, `server.ts`, `index.ts`
- [x] 1.4 Rewrite `README.md` in Spanish, following Ligador's: what the service shows, where the data comes from (route table), how to run it locally, configuration, endpoints, deploy

## 2. Test fixtures

- [x] 2.1 Capture tournament 549 payloads into `test/fixtures/` in one paced session so they are mutually consistent: tournament, positions, groupweeks, the unfiltered games list, and all 15 per-jornada game lists
- [x] 2.2 Capture the flat standings shape (tournament 520 positions) and the empty response returned for a nonexistent tournament
- [x] 2.3 Capture `info`, `events` and `mvps` for games 30237, 30239, 30240, 30248, 30258 and 30259, plus the `404` body returned for an unknown game's `info`
- [x] 2.4 Add `test/fixtures.ts` with a loader and a note of the capture date, as in Ligador

## 3. Configuration

- [x] 3.1 Implement `src/config.ts` with every variable in design D14: defaults, range and format checks (positive tournament id, http(s) base URL, valid IANA timezone, log level), Telegram both-or-neither, and a `ConfigError` listing every problem at once
- [x] 3.2 Write `.env.example` documenting every variable with its default
- [x] 3.3 Unit-test config: defaults applied, invalid tournament id and base URL rejected, half-configured Telegram rejected, invalid timezone rejected

## 4. Domain model and upstream client

- [x] 4.1 Define types in `src/model.ts`: `Tournament`, `TeamRow`, `StandingsGroup`, `Game` with its two sides, `Jornada`, `JornadaState` (list, assignment, fixture ids at refresh), `FeedState<T>`, `SnapshotFile` (version 1 with `tournamentId`), `MatchInfo`, `MatchEvent`, `MatchDetails`, and the derived view types (`StandingRow` with `pperd`, `TeamMatch`, `TeamBye`, `TeamView`)
- [x] 4.2 Implement URL builders in `src/upstream.ts` for tournament, positions, groupweeks, games (unfiltered and `filter[groupweek][0]`), and game `info`, `events` and `mvps`
- [x] 4.3 Implement `fetchJson()` with native `fetch`, an `AbortSignal` timeout and a descriptive `User-Agent`. Map non-2xx to `UpstreamError`, `404` to a not-found error, and `429` to `RateLimitedError` carrying `Retry-After` seconds (design D5)
- [x] 4.4 Implement integer helpers that accept JSON integers or all-digit strings, a signed variant for goal difference, and whitespace normalization for names and venues (design D6)
- [x] 4.5 Implement `parseStandings()`: accept the grouped and flat shapes, normalize names, reject malformed rows, reject zero teams
- [x] 4.6 Implement `parseFixture()`: scores both null or both non-negative integers; `DD/MM/YYYY` checked as a real date, else null; `00:00` time to null; empty or `-` venue to null
- [x] 4.7 Implement `parseJornadas()` and `parseTournament()` with lenient dates and a nullable current jornada
- [x] 4.8 Implement `parseMatchInfo()`, `parseEvents()` (drop and log individually malformed events) and `parseMvps()`
- [x] 4.9 Unit-test every parser against the captured fixtures, plus malformed cases: non-object body, missing key, half-null score, `"12abc"`, negative counter, empty standings, unparseable date, placeholder time, `-` venue, a malformed single event

## 5. Store and snapshot

- [x] 5.1 Implement `src/store.ts` holding the tournament, standings, fixture and jornada feeds. Recording one feed's success or failure must not touch any other feed's data or `fetchedAt`
- [x] 5.2 Write the snapshot atomically (temp file, then rename) after every poll with at least one success, including the configured `tournamentId` (design D11)
- [x] 5.3 Load the snapshot at boot. Missing, corrupt or different-tournament snapshots start cold with a warning and never throw
- [x] 5.4 Expose freshness: last success per feed, whether any feed's latest attempt failed, and the most recent live-feed success
- [x] 5.5 Unit-test the store: partial success updates only the successful feed; a corrupt snapshot starts cold; a snapshot from another tournament is ignored

## 6. Aggregation

- [x] 6.1 Implement `pperd = 3 × PP + 2 × PE` and the default order by official position, with the tiebreak for colliding positions (points, goal difference, goals for, name)
- [x] 6.2 Implement `teamKey()` and fixture-side linking: by normalized name first, then by a logo URL owned by exactly one team (design D7)
- [x] 6.3 Implement played matches per team, oriented to that team, with outcome derived from goals, ordered by jornada order, then date, then game id
- [x] 6.4 Implement remaining opponents per team in the same order, deduplicated with counts
- [x] 6.5 Implement byes per team: jornadas with at least one assigned game in which the team has no game, classified past when every game of that jornada is played and upcoming otherwise, ordered by jornada. Derive none while jornada assignment is unknown or for a team linked to no game (design D7)
- [x] 6.6 Implement the consistency flag comparing played count and W/D/L with `PJ`, `PG`, `PE` and `PP`
- [x] 6.7 Unit-test against the fixtures:
  - every one of the 15 teams agrees with its standings row;
  - `PPerd` for DELTA FC is 5 and for Juana Chard is 12;
  - DELTA FC's Jornada 3 game is listed before its Jornada 4 game;
  - Universidad ORT Uruguay's 11 remaining opponents appear in the spec's order;
  - every team has exactly one bye; Universidad ORT Uruguay's Jornada 4 bye is past, and TFC's Jornada 15 bye is upcoming;
  - no byes are derived without jornada assignment, for a jornada with no games, or for an unlinked team;
  - the unlinked-side case, the logo fallback, a synthetic repeated opponent, and colliding positions

## 7. Scheduler and polling

- [x] 7.1 Copy Ligador's `scheduler.ts` and let `run()` return an optional `backoffMs`, so the next delay is `max(jittered delay, backoffMs)` (design D5)
- [x] 7.2 Implement `src/poll.ts` so each request is awaited before the next with a 250 ms gap: standings, then fixture, then the structure refresh (tournament, groupweeks, one request per jornada) when due (design D3, D4)
- [x] 7.3 Implement the refresh-due rules: never succeeded, `JORNADA_REFRESH_MINUTES` elapsed, or a fixture game id absent from the fixture ids recorded at the last successful refresh
- [x] 7.4 Apply the jornada assignment all-or-nothing, and tournament information independently of it
- [x] 7.5 Reject an empty fixture while a non-empty fixture is stored (design D6)
- [x] 7.6 Handle HTTP 429: stop the poll, mark the unsent feeds failed as rate limited, and compute the backoff from consecutive rate-limited polls and `Retry-After`. Record it in a shared rate-limit state read by details, the page and `/health`, and reset it after a clean poll
- [x] 7.7 Wire `src/index.ts` as in Ligador: load config, restore the snapshot, start the server, create the notifier and the details service, start the scheduler, shut down gracefully on SIGTERM and SIGINT
- [x] 7.8 Unit-test polling with a fake `fetch` and fake timers:
  - no two requests of a poll are ever in flight together;
  - each refresh trigger fires, and a game listed under no jornada triggers only one extra refresh;
  - one failing per-jornada request keeps the previous assignment;
  - fixture and standings fail independently;
  - a 429 mid-poll stops the poll, and backoffs run 10, 20, 40 and then 60 minutes;
  - `Retry-After` is honored, and the base interval returns after a clean poll;
  - a due run is skipped while a poll is still in flight

## 8. Match details

- [x] 8.1 Implement `MatchDetails.get(id)` in `src/details.ts`: allowlist of played fixture games, TTL cache (`MATCH_DETAILS_TTL_MINUTES`), and a single in-flight retrieval per id (design D8)
- [x] 8.2 Implement the rolling-minute request budget and the backoff check, falling back to a stale entry or the fixture-based basic view with the right status
- [x] 8.3 Implement retrieval as `info`, then `events`, then `mvps` only if budget remains, with an `mvps` failure swallowed. Attribute each featured player to a side by matching its `team_logo` with the logos in `info`
- [x] 8.4 Implement event normalization (kind by `type_id`, side via `info` team ids, period mapping) and the timeline sort key (design D9)
- [x] 8.5 Implement reconciliation: goals without a recorded scorer per side, and the no-events state
- [x] 8.6 Implement `invalidate(id)`
- [x] 8.7 Unit-test with the captured fixtures and a fake `fetch`:
  - 30259's red card is recognized, and 30248's unordered events are sorted;
  - 30239's assists follow their goals, and its yellow cards are counted;
  - 30258 has one goal without a scorer, 30240's away side has two, and 30237 has no events;
  - pending, unknown and non-numeric ids return not found without calling `fetch`;
  - a TTL hit makes no request, and concurrent calls share one retrieval;
  - an exhausted budget and an active backoff each return the correct fallback;
  - an upstream failure returns the stale entry when cached, and the basic view otherwise;
  - 30258's two featured players are each attributed to their own team;
  - an `mvps` failure still yields details, and invalidation forces a refetch

## 9. Change detection and notifications

- [x] 9.1 Implement standings change detection in `src/diff.ts`: a canonical form keyed by team id, and a per-team diff with added and removed teams, changed fields, and the before and after official position and `PPerd` (design D12)
- [x] 9.2 Implement result change detection keyed by game id (new, corrected, cleared), ignoring date, time, venue and jornada changes
- [x] 9.3 Invalidate cached match details for every corrected or cleared result found by a poll
- [x] 9.4 Copy Ligador's `telegram.ts` (sender with retries, `packMessages`, `sendAll`), adding only Telegram's refusal reason to the log
- [x] 9.5 Implement `src/notify.ts` entries in the design D13 format: result lines before standings lines, no scorers in result lines, group sub-headers only for multiple groups, and HTML escaping
- [x] 9.6 Implement the startup message: tournament name, top 3 per group with points and `PPerd`, last retrieval time in `DISPLAY_TIMEZONE`, and `SITE_URL` when set
- [x] 9.7 Suppress change reports when there is no baseline (a cold start, or a snapshot from a different tournament)
- [x] 9.8 Unit-test change detection:
  - a row-order-only difference and a position-only difference are not changes;
  - a new team is a change, and new, corrected and cleared results are changes;
  - a rescheduled game is not a change, and a failed poll reports nothing
- [x] 9.9 Unit-test reporting: a poll with 7 new results and 14 team changes yields messages containing every change exactly once; splitting is labelled and bounded with the omitted count; a corrected result line contains no player names even when that match's details are cached; no secret ever appears in message text; startup is sent once, with and without a change message

## 10. HTTP surface and rendering

- [x] 10.1 Set up Fastify in `src/server.ts` with structured logging, request logging disabled, and a graceful close
- [x] 10.2 Render the header for `GET /`: tournament name, date range, "Jornada N de M", official tournament link, a generic fallback title, and the freshness line with stale and backoff warnings
- [x] 10.3 Render one standings table per group with the full column set, a highlighted `PPerd`, signed positive `DG`, `data-sort` and `data-pos` attributes, and the no-data state
- [x] 10.4 Render team rows as toggle buttons (`aria-expanded`, `aria-controls`), each with a hidden panel row. The played-matches table shows unknown values explicitly and past byes as *Libre* rows at their jornada position, plus the no-matches state and the discrepancy note. Rows are not interactive when the fixture was never retrieved
- [x] 10.5 Render remaining opponents as a native `<details>` element, collapsed, showing the count and any upcoming bye's jornada, with names comma-separated and a count suffix for repeated opponents, plus the nothing-left state
- [x] 10.6 Render each played match's score as a link to `/partido/{id}` with `aria-expanded` and `aria-controls`
- [x] 10.7 Implement the single match detail renderer and use it from `GET /partido/:id` (full page with header and back link) and `GET /partido/:id?embed=1` (fragment only). Add the `404` page and cache headers by status (design D10)
- [x] 10.8 Implement `GET /api/standings` (including each team's byes), `GET /api/matches/:id`, `GET /health` (including backoff state and next poll) and `GET /favicon.ico`
- [x] 10.9 HTML-escape every upstream string in every renderer
- [x] 10.10 Test with Fastify `inject`:
  - content, byes included, is present in `/` without JavaScript, and upstream strings are escaped;
  - the fallback title and the no-data state render;
  - `/partido/:id` and `/api/matches/:id` return `404` for unavailable ids without calling `fetch`;
  - the JSON shapes and the cache headers are correct

## 11. Styling and client script

- [x] 11.1 Adapt Ligador's inline styles (custom properties, dark variant, highlighted `PPerd`, sticky headers, tabular numbers, scroll containers) and add match timeline styles: two columns, single column below 480px
- [x] 11.2 Adapt Ligador's sort script: independent state per table, per-column default direction, `aria-sort`, keyboard activation, fixed positions, and team rows carrying their panel rows
- [x] 11.3 Adapt Ligador's panel toggle with `aria-expanded` and no network request
- [x] 11.4 Implement the inline match detail:
  - intercept link and row activation;
  - on first open, insert a detail row with a loading state and fetch `?embed=1` once;
  - toggle `hidden` afterwards;
  - on failure, show a message linking to `/partido/{id}`;
  - keep `aria-expanded` in sync
- [x] 11.5 Add the `<noscript>` rule that shows every team panel

## 12. Verification and delivery

- [x] 12.1 Run typecheck and the full test suite; all green
- [x] 12.2 Run locally with Telegram unset and compare against ligapro.uy:
  - the standings and `PPerd` for at least three teams;
  - three teams' panels, including the order of their remaining opponents;
  - the byes of at least two teams, one past and one upcoming;
  - the details of matches 30237, 30239, 30240, 30258 and 30259
- [x] 12.3 Verify sorting on every column with pointer and keyboard. With JavaScript disabled, confirm panels are visible and match links navigate to `/partido/{id}`
- [x] 12.4 Verify the page at 375px wide, in light and dark schemes, with a team panel and a match detail open, and no horizontal body scroll
- [x] 12.5 Simulate upstream trouble: unreachable host, malformed payload, empty fixture, and HTTP 429 with `Retry-After`. Confirm the last good data is served, the warnings show, and the backoff appears in `/health`
- [ ] 12.6 Configure Telegram and verify the startup message. Then verify a change report by rolling a jornada back to pending in the snapshot, including a report split across several messages
- [ ] 12.7 Add the multi-stage, non-root `Dockerfile` from Ligador and confirm the container builds and runs
- [x] 12.8 Confirm `.env.example` matches the variables `src/config.ts` reads, and that no secret is logged at any level
