## Purpose

Tells the operator over Telegram, within one poll, whenever a result is posted, corrected or cleared and whenever the standings move, reporting every change a poll found, and confirms after every restart that the service is alive, so the LigaPro site never has to be checked speculatively.

## ADDED Requirements

### Requirement: Standings change detection

After each successful standings retrieval, the system SHALL compare the new standings with the previously stored standings. It SHALL classify them as changed when the set of teams (identified by team id) differs, or when any team's `PJ`, `PG`, `PE`, `PP`, `GF`, `GC` or `Pts` differs.

Differences only in row order, official position, team name or logo SHALL NOT count as a change on their own. A failed or rejected retrieval SHALL NOT count as a change.

#### Scenario: A result is reflected in the table

- **WHEN** a poll returns standings where one team's `PJ` and `Pts` have increased
- **THEN** the system SHALL classify the standings as changed

#### Scenario: Identical data re-fetched

- **WHEN** a poll returns standings identical to the stored ones, possibly in a different row order
- **THEN** the system SHALL classify the standings as unchanged and SHALL NOT notify

#### Scenario: New team appears

- **WHEN** a poll returns standings containing a team id that was not previously present
- **THEN** the system SHALL classify the standings as changed

### Requirement: Result change detection

After each successful fixture retrieval, the system SHALL compare every game, identified by game id, with the previously stored fixture, and classify:

- a **new result** when a game that was pending or previously unknown now has scores;
- a **corrected result** when a played game's scores differ from the stored scores;
- a **cleared result** when a previously played game is pending again or no longer in the fixture.

Changes to a game's date, time, venue or jornada, and the appearance of new pending games, SHALL NOT count as result changes.

#### Scenario: A result is posted

- **WHEN** a game stored as pending is returned with scores `2` and `1`
- **THEN** the system SHALL classify it as a new result

#### Scenario: A score is corrected

- **WHEN** a game stored with the score `1-9` is returned with the score `1-10`
- **THEN** the system SHALL classify it as a corrected result

#### Scenario: A score is cleared

- **WHEN** a game stored as played is returned without scores
- **THEN** the system SHALL classify it as a cleared result

#### Scenario: A game is rescheduled

- **WHEN** a pending game's date changes or it moves to a different jornada, with no change to its scores
- **THEN** the system SHALL NOT classify any result change and SHALL NOT notify

### Requirement: Notification on change

When a poll detects standings or result changes, the system SHALL notify the configured Telegram chat, describing:

- each new result: jornada when known, home team, score, away team;
- each corrected result: new score and previous score;
- each cleared result: the score it previously had;
- for each affected team: the standings values that moved with their previous and new values, including `PPerd` when it moved, plus any change in official position.

Result lines SHALL NOT include goal scorers or any other match event, even when the match's events are already recorded upstream.

#### Scenario: Result and table move together

- **WHEN** a poll detects a new result and the resulting standings changes for both teams
- **THEN** the notification SHALL include the result line and both teams' standings changes

#### Scenario: Result lines carry no scorers

- **WHEN** a poll reports a new or corrected result, whether or not that match's events are recorded or its details are cached
- **THEN** the result line SHALL show the jornada when known, both teams and the score, and SHALL contain no player names

#### Scenario: New result without standings movement

- **WHEN** a poll detects a new result while the standings are unchanged, because upstream has not recomputed them yet
- **THEN** the new result SHALL still be reported

#### Scenario: Standings change while the fixture fails

- **WHEN** the standings changed but that poll's fixture retrieval failed
- **THEN** the standings change SHALL still be reported, without result lines

#### Scenario: Repeat polls after a change

- **WHEN** a change has been notified and subsequent polls return the same data
- **THEN** no further messages SHALL be sent, and the same change SHALL NOT be reported again

### Requirement: Every detected change is reported

The messages sent for a poll SHALL account for every change that poll detected: every new, corrected and cleared result and every affected team, none omitted and none duplicated. The system SHALL NOT report only the first change or only the most significant one. When the tournament has more than one standings group, each standings change SHALL be attributed to its group.

#### Scenario: A whole jornada lands at once

- **WHEN** a single poll detects seven new results and changes for fourteen teams
- **THEN** all seven results and all fourteen teams SHALL be reported, split across several messages if one cannot hold them all

#### Scenario: Results and standings changes in one poll

- **WHEN** a poll detects a corrected result and, separately, several standings changes
- **THEN** the messages for that poll SHALL contain the corrected result and every standings change

### Requirement: Notification on startup

The system SHALL send exactly one Telegram message on startup, after its first poll completes. The message SHALL state that the service restarted and include the tournament name, the top of each standings table (position, team, points and `PPerd`), the time of the last successful retrieval in the configured display timezone, and the site URL when one is configured.

#### Scenario: Service restarts

- **WHEN** the service starts and completes its first poll
- **THEN** exactly one startup message SHALL be sent

#### Scenario: Restart with an identical snapshot

- **WHEN** the service restarts with a stored snapshot and the first poll returns data identical to it
- **THEN** the startup message SHALL be sent, and no change message SHALL be sent

#### Scenario: Restart after upstream moved

- **WHEN** the service restarts with a stored snapshot and the first poll returns results or standings that differ from it
- **THEN** both the startup message and a change message SHALL be sent

#### Scenario: Cold start without a snapshot

- **WHEN** the service starts with no usable snapshot
- **THEN** the startup message SHALL be sent, and the first poll SHALL NOT report the whole table or fixture as changed

#### Scenario: Restart after switching tournaments

- **WHEN** the service restarts configured for a different tournament id than the one in the stored snapshot
- **THEN** the snapshot SHALL NOT be used as a baseline, and no change message comparing the two tournaments SHALL be sent

### Requirement: Notification delivery is non-blocking

A failure to deliver a Telegram message SHALL NOT fail a poll, discard retrieved data or crash the process, and SHALL be logged. Transient failures SHALL be retried a bounded number of times. A message the Telegram API rejects as invalid SHALL NOT be retried.

#### Scenario: Telegram API unavailable

- **WHEN** the Telegram API returns a server error or times out while a message is being sent
- **THEN** the retrieved data SHALL still be stored and served, the send SHALL be retried a bounded number of times, and the failure SHALL be logged

#### Scenario: Message rejected

- **WHEN** the Telegram API rejects a message with a client error, for example because the chat id is wrong
- **THEN** the system SHALL log the rejection and SHALL NOT retry that message

### Requirement: Notifications are optional

The system SHALL run with notifications disabled when neither the Telegram bot token nor the chat id is configured, serving the site normally and logging once that notifications are off. Configuring only one of the two SHALL be reported as invalid configuration at startup.

#### Scenario: Telegram not configured

- **WHEN** the service starts without a Telegram bot token and chat id
- **THEN** it SHALL start, serve the page and send no messages

#### Scenario: Half-configured Telegram

- **WHEN** the service starts with a bot token but no chat id, or a chat id but no bot token
- **THEN** it SHALL fail to start and report that both values must be set together

### Requirement: Message content limits

Notification messages SHALL identify the service and the tournament, and SHALL NOT include any secret such as the bot token. When a poll's changes do not fit in one message, the system SHALL split them on change boundaries across as many messages as needed, each within Telegram's size limit, sent in order and labelled with its position in the sequence.

The number of messages per poll SHALL be bounded by a configurable maximum. When the bound is reached, the final message SHALL state how many changes it could not include and point to the site.

#### Scenario: Report larger than one message

- **WHEN** a poll's changes exceed what one Telegram message can carry
- **THEN** the system SHALL send several messages, each within the size limit and labelled with its position, that together cover every change, with no change cut in half

#### Scenario: Splitting is bounded

- **WHEN** reporting a poll's changes would need more messages than the configured maximum
- **THEN** the system SHALL send only the maximum, and the last message SHALL state the number of changes left out and point to the site
