## Purpose

Gives every played match of the tournament its own detail view: date, venue and score, a minute-by-minute timeline of goals, assists and cards, and the featured players. Details are retrieved from LigaPro only when someone asks for them, then cached, with upstream load bounded so the service never becomes a heavy client of the API.

## ADDED Requirements

### Requirement: Match detail availability

The system SHALL provide details only for games in the stored fixture of the configured tournament that are played. A request for any other game id SHALL be answered as not found without contacting upstream.

#### Scenario: Played match

- **WHEN** details are requested for a game in the stored fixture that has both scores
- **THEN** the system SHALL serve that match's details

#### Scenario: Pending match

- **WHEN** details are requested for a game in the stored fixture that has no scores yet
- **THEN** the system SHALL answer not found and SHALL NOT contact upstream

#### Scenario: Game outside the tournament

- **WHEN** details are requested for a game id that is not in the stored fixture, or for an id that is not a positive integer
- **THEN** the system SHALL answer not found and SHALL NOT contact upstream

### Requirement: On-demand retrieval and caching

The regular poll SHALL NOT retrieve match details. When a match's details are requested and no cached copy is younger than the configured lifetime (default 15 minutes), the system SHALL retrieve that match's information and events from upstream, cache them, and serve them. It SHALL also retrieve the featured players, but only on a best-effort basis. Concurrent requests for the same match SHALL share a single upstream retrieval. A cached copy SHALL be discarded as soon as a poll detects that the match's result was corrected or cleared.

#### Scenario: First view of a match

- **WHEN** a played match's details are requested and nothing is cached for it
- **THEN** the system SHALL retrieve the match's information and events from upstream, then serve and cache the details

#### Scenario: Repeat view within the lifetime

- **WHEN** the same match's details are requested again before the cached copy reaches the configured lifetime
- **THEN** the system SHALL serve the cached copy without contacting upstream

#### Scenario: Concurrent views

- **WHEN** several requests for the same uncached match arrive at the same time
- **THEN** the system SHALL perform one upstream retrieval and answer all of them from it

#### Scenario: Result corrected upstream

- **WHEN** a poll detects that a cached match's score changed
- **THEN** the next request for that match SHALL retrieve fresh details from upstream

#### Scenario: Featured players unavailable

- **WHEN** the match's information and events are retrieved but the featured players request fails
- **THEN** the details SHALL be served without featured players, and the retrieval SHALL NOT count as failed

### Requirement: Bounded upstream load

Upstream requests made for match details SHALL NOT exceed a configurable number per minute (default 20), whatever the traffic, and SHALL NOT be made while a rate-limit backoff is in effect.

When a retrieval is not allowed or fails, the system SHALL serve the most recent cached details, marked as possibly outdated. When nothing is cached, it SHALL serve the match's basic information from the stored fixture instead: jornada, date, time when recorded, venue, both teams and the score. That basic view SHALL carry a notice that the full detail is temporarily unavailable.

#### Scenario: Request budget exhausted

- **WHEN** the per-minute budget for detail requests has been used up and an uncached match is requested
- **THEN** the system SHALL NOT contact upstream and SHALL serve the match's basic information with the unavailability notice

#### Scenario: Backoff in effect

- **WHEN** a rate-limit backoff is in effect and a match whose cached copy has expired is requested
- **THEN** the system SHALL NOT contact upstream and SHALL serve the expired copy, marked as possibly outdated

#### Scenario: Upstream fails with an expired copy cached

- **WHEN** retrieving a match whose cached copy has expired fails
- **THEN** the system SHALL serve the expired copy, marked as possibly outdated, and a later request SHALL try upstream again

#### Scenario: Upstream fails with nothing cached

- **WHEN** retrieving an uncached match's information or events fails, including when upstream reports the match as not found
- **THEN** the system SHALL serve the match's basic information with the unavailability notice

### Requirement: Event normalization

Each match event SHALL keep its player name, team, kind, period, minute and second. The kind SHALL be determined by the upstream numeric event type, never by its label (upstream misspells the red card label): `1` goal, `8` assist, `3` yellow card, `4` red card. An event of any other type SHALL be kept with its upstream label.

Each event SHALL be attributed to the home or away side by matching its team id against the two teams in the match information. An event whose team matches neither side SHALL be kept unattributed. Periods `FIRST_TIME` and `SECOND_TIME` SHALL be treated as first and second half. Any other period SHALL be kept with its upstream label.

#### Scenario: Misspelled red card label

- **WHEN** an event has type `4` and label `"Tarjets Roja"`
- **THEN** it SHALL be treated as a red card

#### Scenario: Unrecognized event type

- **WHEN** an event has a type other than `1`, `3`, `4` or `8`
- **THEN** it SHALL be kept in the timeline and shown with its upstream label

#### Scenario: Event attributed to a side

- **WHEN** an event's team id equals the away team's id in the match information
- **THEN** the event SHALL be attributed to the away side

#### Scenario: Malformed single event

- **WHEN** one event in an otherwise valid events payload lacks a type or has a negative minute
- **THEN** that event SHALL be left out and logged, and the remaining events SHALL be kept

### Requirement: Timeline order

The timeline SHALL be ordered by period (first half, second half, then any other period), then minute, then second. Events at the same instant SHALL be ordered goals first, then assists, then yellow cards, then red cards, then any other kind, with remaining ties broken by upstream event id. The system SHALL NOT rely on the order in which upstream returns events.

#### Scenario: Upstream returns events out of order

- **WHEN** upstream returns a goal at 27' of the first half, then one at 5' of the first half, then one at 10' of the second half
- **THEN** the timeline SHALL list the 5' first-half goal, then the 27' first-half goal, then the 10' second-half goal

#### Scenario: Goal and its assist

- **WHEN** a goal and an assist for the same side share period and minute
- **THEN** the goal SHALL be listed immediately before the assist

### Requirement: Recorded goals reconciled with the score

For each side, the system SHALL compare the number of recorded goal events with that side's score. When fewer goals are recorded than scored, the details SHALL state how many of that side's goals have no recorded scorer. When a match has no events at all, the details SHALL state that no events were recorded, rather than showing an empty timeline.

#### Scenario: One goal without a scorer

- **WHEN** a match ended `1-9` and the winning side has eight recorded goal events
- **THEN** the details SHALL state that one of that side's goals has no recorded scorer

#### Scenario: One side recorded nothing

- **WHEN** a match ended `2-2`, the home side has two recorded goals and the away side has none
- **THEN** the details SHALL state that two of the away side's goals have no recorded scorer, and SHALL add no note for the home side

#### Scenario: Match without events

- **WHEN** a match ended `3-0` and upstream returns no events for it
- **THEN** the details SHALL show the score and state that no events were recorded

### Requirement: Match detail content

A match's details SHALL show:

- the tournament name and the jornada;
- the date, and the time only when one is recorded;
- the venue, or that it is unknown;
- both teams with the score;
- the timeline, where each event shows its minute, kind (as a symbol plus a text label), player name and side;
- the featured players when known, each next to their team. Upstream lists at most one per team and identifies the team only by its logo URL, so a featured player whose logo matches neither team SHALL be shown without a team;
- a link to the match's official page on LigaPro.

#### Scenario: Featured player of each team

- **WHEN** upstream lists a featured player for each of the two teams
- **THEN** the details SHALL show both, each attributed to its own team

#### Scenario: Placeholder time

- **WHEN** the match's upstream time is `00:00`
- **THEN** the details SHALL show the date without a time

#### Scenario: Event minute

- **WHEN** an event occurred at minute 5, second 0 of the first half
- **THEN** it SHALL be shown under the first half as `05'`

#### Scenario: Official link

- **WHEN** a match's details are shown
- **THEN** they SHALL include a link to that match's page on `https://www.ligapro.uy/juego/{id}`

### Requirement: Match detail addresses

Every played match SHALL have a stable page at `/partido/{id}` that renders its details completely without JavaScript, and a JSON representation at `/api/matches/{id}`. Both SHALL follow the availability, caching and load rules above, and both SHALL respond `404` for a game that is not available.

#### Scenario: Detail page

- **WHEN** a visitor requests `/partido/{id}` for a played match
- **THEN** the system SHALL respond `200 OK` with a complete HTML page showing that match's details and a link back to the standings

#### Scenario: Detail JSON

- **WHEN** `/api/matches/{id}` is requested for a played match
- **THEN** the system SHALL respond `200 OK` with the match's basic information, its ordered timeline, the per-side counts of goals without a recorded scorer, the featured players when known, when the details were retrieved, and whether they are possibly outdated or unavailable

#### Scenario: Unknown match

- **WHEN** either address is requested for a game that is not available
- **THEN** the system SHALL respond `404` without contacting upstream
