## Purpose

The public face of the service: one unauthenticated, fast page that shows the current LigaPro tournament and its sortable standings with Puntos Perdidos. On demand it opens each team's results, byes and remaining opponents, and each match's detail, without leaving the page. It always makes clear how fresh the data is.

## ADDED Requirements

### Requirement: Single public page

The system SHALL serve the tournament page at the root path `/` as a single HTML document, with no authentication, no login and no cookies required. The standings tables and, for every team, its played matches, byes and remaining opponents SHALL be present in the served HTML before any JavaScript runs.

#### Scenario: Anonymous visitor

- **WHEN** a visitor with no credentials requests `/`
- **THEN** the system SHALL respond `200 OK` with the full page

#### Scenario: Content is in the served HTML

- **WHEN** the response body for `/` is inspected without executing JavaScript
- **THEN** every standings row SHALL be present, together with each team's played matches, byes and remaining opponents

#### Scenario: Page never waits on upstream

- **WHEN** `/` is requested while LigaPro is slow or unreachable
- **THEN** the page SHALL be rendered from stored data without contacting upstream

### Requirement: Tournament header

The page SHALL show the tournament's name, its start and end dates, and, when known, the current jornada together with its position among all jornadas. It SHALL link to the tournament's official page on LigaPro.

#### Scenario: Tournament information available

- **WHEN** the stored tournament is "Serie 4 / Divisional B / Clausura 2026", running from 22/08/2026 to 12/12/2026, with Jornada 4 of 15 as its current jornada
- **THEN** the header SHALL show that name, both dates and "Jornada 4 de 15"

#### Scenario: Tournament information never retrieved

- **WHEN** tournament information has never been retrieved but standings exist
- **THEN** the page SHALL still render, with a generic title that includes the configured tournament id in place of the name

### Requirement: Standings tables and columns

The page SHALL render one standings table per group, in upstream order, headed by the group's name when it has one. Each table SHALL show the columns position, team, `PJ`, `PG`, `PE`, `PP`, `GF`, `GC`, `DG`, `Pts` and `PPerd`, with `PPerd` visually distinguished from the other columns. Team names SHALL be shown whitespace-normalized.

#### Scenario: Rendered columns

- **WHEN** the page is rendered with standings available
- **THEN** each table SHALL display every listed column, and a positive `DG` SHALL be shown with an explicit `+` sign

#### Scenario: Several groups

- **WHEN** the standings have two groups
- **THEN** the page SHALL render two tables, each headed by its group name

#### Scenario: No data yet

- **WHEN** standings have never been retrieved
- **THEN** the page SHALL still respond `200 OK` and show an explicit "no data yet" message instead of empty tables

### Requirement: Sortable columns

Every column of every standings table SHALL be sortable by the visitor, ascending and descending, without a page reload and without a server request. Sorting one table SHALL NOT change the order of any other.

#### Scenario: Sorting by a column

- **WHEN** the visitor activates a column header
- **THEN** that table's rows SHALL reorder by that column, and the header SHALL indicate the active direction

#### Scenario: Toggling direction

- **WHEN** the visitor activates the header of the column that is already the active sort
- **THEN** the sort direction SHALL invert

#### Scenario: Default direction per column

- **WHEN** a column is first activated
- **THEN** it SHALL sort descending for `PJ`, `PG`, `PE`, `PP`, `GF`, `GC`, `DG` and `Pts`, ascending for `PPerd` and position, and alphabetically ascending for the team name

#### Scenario: Position column after re-sorting

- **WHEN** rows are reordered by any column
- **THEN** the position column SHALL keep showing each team's official position rather than renumbering

#### Scenario: Keyboard access to sorting

- **WHEN** the visitor focuses a column header and presses Enter or Space
- **THEN** the same sort behavior SHALL apply as for a pointer activation

### Requirement: Team panel

Once the fixture has been retrieved, every team row SHALL be selectable. Selecting it SHALL reveal that team's panel, holding its played matches, byes and remaining opponents, directly below the row, using only data already in the page: no reload and no server request. Selecting the row again SHALL close the panel.

#### Scenario: Opening a team's panel

- **WHEN** the visitor selects a team's name
- **THEN** the page SHALL reveal that team's played matches, byes and remaining opponents below its row, without a network request

#### Scenario: Closing the panel

- **WHEN** the visitor selects a team whose panel is open
- **THEN** the panel SHALL close

#### Scenario: Keyboard access to the panel

- **WHEN** the visitor focuses a team's name and presses Enter or Space
- **THEN** the panel SHALL open or close as for a pointer activation, and the control SHALL expose its open or closed state to assistive technology

#### Scenario: Sorting with a panel open

- **WHEN** the visitor sorts a column while a team's panel is open
- **THEN** the panel SHALL remain directly below its own team's row

#### Scenario: Fixture never retrieved

- **WHEN** standings exist but the fixture has never been retrieved
- **THEN** team rows SHALL NOT be presented as selectable, and the standings SHALL still render normally

#### Scenario: JavaScript disabled

- **WHEN** the page is viewed with JavaScript disabled
- **THEN** every team's panel content SHALL be visible without any interaction

### Requirement: Played matches in the team panel

A team's panel SHALL list its played matches as derived by the standings aggregation, in that order. Each match SHALL show the jornada, date, home or away, opponent, the score from the team's point of view, the outcome as won, drawn or lost, and the venue. An unknown jornada, date or venue SHALL be shown as unknown rather than left blank. When the team's matches disagree with its standings row, the panel SHALL show a visible note saying the feeds disagree.

A past bye SHALL appear in the same list at its jornada's position, as an entry showing the jornada and that the team was free (*Libre*), with no date, opponent, score, outcome or match detail.

#### Scenario: Home loss

- **WHEN** the team was the home side of a match that ended `3-4`
- **THEN** its panel SHALL show that match at home, scored `3-4`, with outcome lost

#### Scenario: Past bye in the list

- **WHEN** a team has played Jornadas 1 to 3 and has a past bye in Jornada 4
- **THEN** its panel SHALL list the three matches followed by a *Libre* entry for Jornada 4

#### Scenario: No matches played

- **WHEN** a team has no played matches
- **THEN** its panel SHALL state that it has not played yet, instead of showing an empty list, and SHALL still show any past bye

#### Scenario: Feeds disagree

- **WHEN** a team's played matches do not match its `PJ`, `PG`, `PE` or `PP`
- **THEN** its panel SHALL still list the matches and show the discrepancy note

### Requirement: Remaining opponents in the team panel

A team's panel SHALL show its remaining opponents collapsed by default, displaying how many remain. An upcoming bye SHALL be shown next to that count, naming its jornada, so it is visible while the list is collapsed. Expanding SHALL reveal the opponents' names in order, separated by commas, with an opponent faced more than once followed by its count. Expanding and collapsing SHALL work without JavaScript.

#### Scenario: Collapsed by default

- **WHEN** a team's panel is opened and the team has 11 opponents left
- **THEN** the panel SHALL show that 11 opponents remain, with the names hidden

#### Scenario: Upcoming bye

- **WHEN** a team has 10 opponents left and an upcoming bye in Jornada 5
- **THEN** the collapsed list SHALL show both that 10 opponents remain and that the team is free in Jornada 5

#### Scenario: Expanded

- **WHEN** the visitor expands the remaining opponents
- **THEN** the panel SHALL show the 11 names in jornada order, separated by commas

#### Scenario: Nothing left to play

- **WHEN** a team has no pending games
- **THEN** its panel SHALL state that it has no matches left, and SHALL still show any upcoming bye

### Requirement: Inline match detail

Selecting a played match in a team's panel SHALL reveal that match's details, with the content defined by the match details capability, directly below the match, without leaving the page. Selecting the match again SHALL hide them. While the details load, a loading state SHALL be shown. If they cannot be loaded, a message SHALL be shown with a link to the match's own detail page. Without JavaScript, selecting a match SHALL navigate to its detail page.

#### Scenario: Opening a match inline

- **WHEN** the visitor selects a played match in a team's panel
- **THEN** that match's details SHALL appear directly below it, and the rest of the page SHALL keep its state

#### Scenario: Closing a match

- **WHEN** the visitor selects a match whose details are shown
- **THEN** the details SHALL be hidden

#### Scenario: Reopening a match

- **WHEN** the visitor reopens a match whose details were already loaded on this page
- **THEN** they SHALL be shown again without another request

#### Scenario: Details cannot be loaded

- **WHEN** the request for a match's details fails
- **THEN** the page SHALL show a message with a link to `/partido/{id}` in place of the details

#### Scenario: JavaScript disabled

- **WHEN** the visitor selects a match with JavaScript disabled
- **THEN** the browser SHALL navigate to `/partido/{id}`

#### Scenario: Keyboard access to a match

- **WHEN** the visitor focuses a match and presses Enter
- **THEN** its details SHALL open or close as for a pointer activation, and the control SHALL expose its open or closed state to assistive technology

### Requirement: Freshness indicator

The page SHALL show when the data was last retrieved successfully and how often the service polls. It SHALL show a visible warning when the most recent poll failed, when a rate-limit backoff is in effect (saying when the next attempt is due), or when no successful retrieval has happened within two poll intervals.

#### Scenario: Data is current

- **WHEN** the last poll succeeded
- **THEN** the page SHALL show the time of that retrieval and the polling cadence

#### Scenario: Data is stale

- **WHEN** the last poll failed, or no successful retrieval has happened within two poll intervals
- **THEN** the page SHALL show a visible staleness warning alongside the last successful retrieval time

#### Scenario: Backing off

- **WHEN** a rate-limit backoff is in effect
- **THEN** the page SHALL show that LigaPro is limiting requests and when the next attempt is due

#### Scenario: Host in a different timezone

- **WHEN** the service runs on a host whose clock is not in the configured display timezone, for example a container in UTC
- **THEN** retrieval times SHALL still be shown in the configured timezone, which defaults to Uruguayan local time

#### Scenario: Upstream dates are not converted

- **WHEN** the page shows a match date or time sent by upstream as a local wall-clock value
- **THEN** it SHALL be displayed as sent, without timezone conversion

### Requirement: Standings available as JSON

The system SHALL expose an unauthenticated `GET /api/standings` endpoint returning, as JSON:

- the tournament information and freshness data;
- every standings group with its rows, including `PPerd`;
- for every team, its played matches, byes (each with its jornada and whether it is past or upcoming), remaining opponents and discrepancy flag.

#### Scenario: Machine-readable access

- **WHEN** `GET /api/standings` is requested
- **THEN** the system SHALL respond `200 OK` with the tournament information, every group's rows with their `PPerd` values, and each team's played matches, byes and remaining opponents

### Requirement: Health endpoint

The system SHALL expose an unauthenticated `GET /health` endpoint returning JSON that reports process liveness, each feed's last successful retrieval and whether its latest attempt failed, whether a rate-limit backoff is in effect, and when the next poll is due.

#### Scenario: Health check while running

- **WHEN** `GET /health` is requested on a running service
- **THEN** it SHALL respond `200 OK` with the status of each feed and of the rate-limit backoff

### Requirement: Lightweight and responsive presentation

Every page the service serves SHALL be styled and scripted without any external network dependency: no CDN stylesheets, fonts, scripts or remote images, and so no team crests. Pages SHALL support light and dark color schemes following the visitor's preference. They SHALL remain readable at phone width, with tables scrolling horizontally inside their own container rather than making the page scroll sideways.

#### Scenario: External hosts blocked

- **WHEN** the page loads with every host other than this service blocked
- **THEN** it SHALL render fully styled, sort every column, open every team panel, and load inline match details

#### Scenario: Narrow viewport

- **WHEN** the page is viewed 375px wide with a team panel and a match detail open
- **THEN** the content SHALL remain legible, and the page body SHALL NOT scroll horizontally
