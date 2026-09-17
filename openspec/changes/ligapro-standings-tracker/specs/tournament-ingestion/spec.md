## Purpose

Keeps a fresh, validated copy of the configured LigaPro tournament (its identity, standings, fixture with scores, and the jornada each game belongs to) by polling LigaPro's public JSON API on a paced, jittered schedule that stays within the upstream's rate limits.

## ADDED Requirements

### Requirement: Standings retrieval

The system SHALL retrieve the configured tournament's standings from LigaPro's public standings endpoint on every poll, without authentication, without executing page JavaScript and without parsing HTML.

The upstream lists teams either inside named groups or as a single flat list. For every team the system SHALL keep:

- the numeric team id and the official position;
- the name, trimmed and with internal runs of whitespace collapsed;
- the logo URL as given;
- integer values for points, games played, won, drawn and lost, goals for, goals against and goal difference.

Groups SHALL keep their upstream name and order. A flat list SHALL be treated as a single unnamed group.

#### Scenario: Grouped standings

- **WHEN** the standings endpoint returns HTTP 200 with teams inside one or more named groups
- **THEN** the system SHALL store one table per group, in upstream order, with integer values for every counter, and record the retrieval timestamp

#### Scenario: Flat standings

- **WHEN** the standings endpoint returns the teams as a single list without groups
- **THEN** the system SHALL store them as one unnamed table

#### Scenario: Team name with stray whitespace

- **WHEN** a team's name arrives as `"La  Axioneta "`
- **THEN** the stored name SHALL be `"La Axioneta"`

#### Scenario: Negative goal difference

- **WHEN** a team's goal difference is `-29`
- **THEN** the system SHALL accept and store it, since goal difference is the only counter allowed to be negative

#### Scenario: Malformed standings payload

- **WHEN** the response does not have the expected shape, a team lacks an id or a name, a counter other than goal difference is not a non-negative integer, or goal difference is not an integer
- **THEN** the system SHALL reject that payload, keep the previously stored standings, and log the failure

#### Scenario: Empty standings

- **WHEN** the standings endpoint returns HTTP 200 with no teams at all
- **THEN** the system SHALL treat the payload as invalid and keep the previously stored standings, because upstream answers a nonexistent tournament this way while a real tournament lists its teams even before its first match

### Requirement: Fixture retrieval

The system SHALL retrieve the configured tournament's complete fixture on every poll: every scheduled game, played or not, in a single request.

For each game the system SHALL keep the upstream game id, both team names (normalized as for standings), both logo URLs, both scores, the date, the time and the venue.

- A game whose scores are both absent is **pending**. A game whose scores are both non-negative integers is **played**. The system SHALL decide whether a game is played from its scores alone, never from its date.
- Dates arrive as day/month/year and times as hour:minute, both local wall-clock values without a timezone. A date that cannot be parsed as a real calendar date SHALL be kept as unknown rather than failing the payload.
- A time of `00:00` SHALL be treated as not recorded, since upstream uses it as a placeholder for every game.
- A venue that is empty or `-` after trimming SHALL be treated as unknown. Otherwise the venue SHALL be stored trimmed, with internal whitespace collapsed.

#### Scenario: Played and pending games

- **WHEN** the fixture contains one game with scores `1` and `10` and another whose scores are both null
- **THEN** the first SHALL be stored as played with those scores and the second as pending

#### Scenario: Date contradicts status

- **WHEN** a game dated in the future already has both scores, or a game dated in the past has neither
- **THEN** its stored status SHALL follow its scores

#### Scenario: Placeholder time

- **WHEN** a game's time is `00:00`
- **THEN** the system SHALL store the game as having no recorded time

#### Scenario: Unparseable date

- **WHEN** a game's date cannot be parsed
- **THEN** the system SHALL keep the game with its date marked unknown instead of rejecting the payload

#### Scenario: Malformed game

- **WHEN** a game lacks an id or a team name, exactly one of its two scores is present, or a present score is not a non-negative integer
- **THEN** the system SHALL reject the fixture payload, keep the previously stored fixture, and log the failure

#### Scenario: Fixture suddenly empty

- **WHEN** the fixture endpoint returns no games while a non-empty fixture is already stored
- **THEN** the system SHALL reject that payload as invalid and keep the stored fixture

#### Scenario: Tournament without a fixture yet

- **WHEN** no non-empty fixture has ever been stored and the fixture endpoint returns no games
- **THEN** the system SHALL store an empty fixture as a valid result

### Requirement: Jornada assignment

The system SHALL know, for every game, which jornada it belongs to, together with each jornada's id, name, order and listed date. Because the complete fixture does not carry this, the system SHALL obtain it from the tournament's jornada list plus one fixture request filtered to each jornada.

Jornada assignment SHALL be refreshed:

- at startup, and on every poll until a refresh has succeeded;
- once the configured jornada refresh interval has elapsed since the last successful refresh;
- whenever the complete fixture contains a game id that was not in the fixture at the last successful refresh.

A refresh SHALL replace the stored assignment only if the jornada list and every per-jornada request succeed and validate. Otherwise the previous assignment SHALL be kept and the refresh SHALL be retried on the next poll.

#### Scenario: Assignment after startup

- **WHEN** the first poll's jornada refresh succeeds
- **THEN** every game returned by the per-jornada requests SHALL be associated with its jornada's id, name and order

#### Scenario: Game moved to another jornada

- **WHEN** upstream moves an existing game to a different jornada, keeping its game id
- **THEN** the stored assignment SHALL reflect the move no later than the first refresh after the jornada refresh interval elapses

#### Scenario: New game appears in the fixture

- **WHEN** a poll's complete fixture contains a game id that was not in the fixture at the last successful refresh
- **THEN** the system SHALL perform a jornada refresh during that poll

#### Scenario: One per-jornada request fails

- **WHEN** one of the per-jornada requests fails or returns an invalid payload during a refresh
- **THEN** the system SHALL keep the previous assignment in full and retry the refresh on the next poll

#### Scenario: Game with no known jornada

- **WHEN** a game in the stored fixture has no known jornada, because no refresh has succeeded yet or upstream lists it under none
- **THEN** the game SHALL still be stored and served, with its jornada marked unknown

### Requirement: Tournament information retrieval

The system SHALL retrieve the tournament's name, start date, end date and current jornada at startup and on every jornada refresh. A failure SHALL keep the previously stored information and SHALL NOT prevent the jornada assignment or any other feed from being applied.

#### Scenario: Current jornada is known

- **WHEN** the tournament information names a current jornada id that exists in the stored jornada list
- **THEN** consumers SHALL be able to obtain that jornada's name and its order among all jornadas

#### Scenario: Tournament information never retrieved

- **WHEN** tournament information has never been retrieved successfully
- **THEN** standings, fixture and jornada assignment SHALL still be retrieved and served

### Requirement: Independent feeds

Standings, fixture, jornada assignment and tournament information SHALL succeed or fail independently. A failure or invalid payload in one SHALL NOT discard or roll back data from another. A failed feed SHALL keep its last good data and retrieval timestamp and record that its latest attempt failed.

#### Scenario: Fixture fails while standings succeed

- **WHEN** a poll retrieves the standings successfully but the fixture request fails
- **THEN** the system SHALL store the new standings and keep serving the previously stored fixture

#### Scenario: Standings fail while fixture succeeds

- **WHEN** a poll retrieves the fixture successfully but the standings request fails
- **THEN** the system SHALL store the new fixture and keep serving the previously stored standings

#### Scenario: Upstream unreachable

- **WHEN** every upstream request times out, fails to connect or returns a non-2xx status other than 429
- **THEN** the process SHALL keep running, keep serving the last known good data, and log each failure

### Requirement: Paced upstream requests

Within a poll, the system SHALL send upstream requests one at a time, waiting a minimum spacing between the end of one request and the start of the next. It SHALL send a descriptive `User-Agent` and SHALL abandon any request that exceeds the configured timeout.

#### Scenario: Poll that includes a jornada refresh

- **WHEN** a poll performs the standings, fixture, tournament information, jornada list and per-jornada requests
- **THEN** no two of that poll's upstream requests SHALL be in flight at the same time

#### Scenario: Slow upstream

- **WHEN** an upstream request does not complete within the configured timeout
- **THEN** that request SHALL be abandoned and treated as a failure of its feed

### Requirement: Rate-limit backoff

When LigaPro answers any request with HTTP 429, the system SHALL send none of that poll's remaining requests and SHALL delay the next poll by a backoff. The backoff SHALL double the base interval for each consecutive rate-limited poll, capped at the larger of 60 minutes and the base interval, and SHALL never be shorter than a `Retry-After` value given in seconds. The first poll that completes without receiving HTTP 429 SHALL restore the base interval. While a backoff is in effect, match details SHALL NOT be requested from upstream.

#### Scenario: Rate limited mid-poll

- **WHEN** the second upstream request of a poll receives HTTP 429
- **THEN** no further upstream requests SHALL be sent in that poll, data from the first request SHALL be kept, and the next poll SHALL be delayed by the backoff

#### Scenario: Consecutive rate-limited polls

- **WHEN** three consecutive polls are rate-limited with a 5-minute base interval and no `Retry-After`
- **THEN** the delays before the following polls SHALL be about 10, 20 and 40 minutes, and no delay SHALL exceed 60 minutes

#### Scenario: Retry-After honored

- **WHEN** a HTTP 429 response carries `Retry-After: 900`
- **THEN** the next poll SHALL NOT start before 900 seconds have elapsed

#### Scenario: Recovery

- **WHEN** a poll completes without any HTTP 429 after one or more rate-limited polls
- **THEN** later polls SHALL be scheduled on the base interval again

### Requirement: Configurable upstream target

The system SHALL build every upstream request from environment configuration, including the API base URL and the tournament id. Moving to another tournament SHALL NOT require a code change.

#### Scenario: Tournament changes

- **WHEN** the operator changes the configured tournament id and restarts the service
- **THEN** subsequent polls SHALL request the new tournament, and the served data SHALL reflect it

#### Scenario: Invalid configuration

- **WHEN** the service starts with a tournament id that is not a positive integer, or a base URL that is not a valid http(s) URL
- **THEN** the service SHALL fail to start and report which configuration value is invalid

### Requirement: Jittered polling schedule

The system SHALL poll on a recurring, environment-configurable base interval (default 5 minutes). Each run SHALL be offset by a random delay drawn uniformly from `[-J, +J]`, where `J` is the environment-configurable maximum jitter (default 30 seconds). Jitter SHALL be redrawn for every run and SHALL never delay a run past the following scheduled run.

#### Scenario: Successive runs are offset differently

- **WHEN** the service polls repeatedly with non-zero jitter configured
- **THEN** the actual start times SHALL vary around the base interval instead of landing on a fixed beat

#### Scenario: Jitter disabled

- **WHEN** the maximum jitter is configured as zero
- **THEN** runs SHALL execute on the base interval with no added offset

#### Scenario: Poll on startup

- **WHEN** the service starts
- **THEN** it SHALL perform a first poll immediately, without waiting for the first interval

### Requirement: Non-overlapping polls

The system SHALL NOT run two polls concurrently. If a poll is still in flight when the next run is due, the due run SHALL be skipped.

#### Scenario: Slow poll overruns its interval

- **WHEN** a poll is still awaiting upstream responses at the moment the next run becomes due
- **THEN** the due run SHALL be skipped and the next run SHALL be scheduled normally

### Requirement: Retrieval freshness is observable

The system SHALL expose to consumers of the stored data: the timestamp of the last successful retrieval for each feed, whether each feed's most recent attempt failed, whether a rate-limit backoff is in effect, and when the next poll is due.

#### Scenario: Consumer reads freshness after a failed poll

- **WHEN** the most recent poll failed but earlier data exists
- **THEN** consumers SHALL see the earlier successful retrieval timestamp together with an indication that the latest attempt failed

#### Scenario: Consumer reads freshness during a backoff

- **WHEN** a rate-limit backoff is in effect
- **THEN** consumers SHALL see that the service is backing off and when the next poll is due
