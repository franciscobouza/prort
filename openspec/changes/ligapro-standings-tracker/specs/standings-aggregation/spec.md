## Purpose

Turns the stored standings and fixture into what a player wants to read: a Puntos Perdidos column, the official ordering, and for every team the matches it has played (from its own point of view), the jornadas it sits out, and the opponents it still has to face.

## ADDED Requirements

### Requirement: Puntos Perdidos column

Every standings row SHALL include a derived `PPerd` (Puntos Perdidos) value computed as `3 × PP + 2 × PE`, where `PP` is matches lost and `PE` is matches drawn, as reported by the upstream standings. A won match contributes 0. Lower values are better.

#### Scenario: Team with a win, a draw and a loss

- **WHEN** a row reports `PG=2`, `PE=1`, `PP=1`
- **THEN** its `PPerd` SHALL be `5`

#### Scenario: Team that lost every match

- **WHEN** a row reports `PG=0`, `PE=0`, `PP=4`
- **THEN** its `PPerd` SHALL be `12`

#### Scenario: Undefeated team

- **WHEN** a row reports `PG=3`, `PE=1`, `PP=0`
- **THEN** its `PPerd` SHALL be `2`

#### Scenario: Points adjusted upstream

- **WHEN** a row's upstream points differ from `3 × PG + PE`, for example because of a sanction
- **THEN** the row SHALL keep the upstream points, and its `PPerd` SHALL still be `3 × PP + 2 × PE`

#### Scenario: Column present in every table

- **WHEN** a tournament's standings have more than one group
- **THEN** every row of every group SHALL carry a `PPerd` value

### Requirement: Official values and default ordering

Each standings table SHALL use the upstream official position, points and goal difference unchanged, and SHALL be ordered by official position ascending. The system SHALL NOT recompute positions, points or goal difference, because the official table can apply tiebreakers and sanctions the feed does not expose.

#### Scenario: Several teams tied on points

- **WHEN** six teams have 7 points, with official positions 3 to 8
- **THEN** they SHALL be ordered by official position, whatever their goal difference or goals scored

#### Scenario: Colliding official positions

- **WHEN** two rows carry the same official position
- **THEN** they SHALL be ordered by points descending, then goal difference descending, then goals for descending, then team name ascending, so repeated renders produce identical output

### Requirement: Fixture games linked to standings teams

The system SHALL link each side of every fixture game to a team in the standings. A side links to the team whose name matches after trimming, collapsing internal whitespace and ignoring case. When no name matches, a side links to the team whose logo URL is identical, provided exactly one team has that logo. A side that cannot be linked SHALL keep its fixture name for display and SHALL NOT be attributed to any team.

#### Scenario: Same name, different spacing

- **WHEN** a fixture game names a side `"La  Axioneta "` and the standings list `"La Axioneta"`
- **THEN** that side SHALL be linked to that team

#### Scenario: Renamed team with the same crest

- **WHEN** a side's name matches no team, but its logo URL is identical to exactly one team's logo URL
- **THEN** that side SHALL be linked to that team

#### Scenario: Side that cannot be linked

- **WHEN** neither the name nor a unique logo URL matches any team
- **THEN** that side SHALL NOT count toward any team's matches, and SHALL still appear under its fixture name wherever it is the opponent

### Requirement: Played matches per team

For every team, the system SHALL derive the list of played games that team took part in, each oriented to that team. Each entry SHALL carry the jornada, date, time when recorded, whether the team played at home or away, the opponent, goals for, goals against, outcome and venue. The outcome (won, drawn or lost) SHALL be derived by comparing the goals.

The list SHALL be ordered by jornada order ascending. Games with an unknown jornada come after all games with a known one. Remaining ties are broken by date (unknown dates last), then by game id.

#### Scenario: Home win

- **WHEN** the team was the home side of a game that ended `4-3` in its favor
- **THEN** the entry SHALL show it at home, scored `4-3`, with outcome won

#### Scenario: Away win

- **WHEN** the team was the away side of a game that ended `1-9`
- **THEN** the entry SHALL show it away, scored `9-1` from the team's point of view, with outcome won

#### Scenario: Draw

- **WHEN** a game ended with both sides on the same number of goals
- **THEN** the entry SHALL have outcome drawn

#### Scenario: Order follows the jornada, not the date

- **WHEN** a team's Jornada 3 game is dated 28/11/2026 and its Jornada 4 game is dated 29/08/2026
- **THEN** the Jornada 3 game SHALL be listed before the Jornada 4 game

#### Scenario: Pending games excluded

- **WHEN** a team has games in the fixture with no scores yet
- **THEN** those games SHALL NOT appear among its played matches

### Requirement: Remaining opponents per team

For every team, the system SHALL derive the opponents of its pending games, in the same order as played matches. An opponent faced in more than one pending game SHALL be listed once, at its first position, together with the number of pending games against it.

#### Scenario: Mid-season remaining opponents

- **WHEN** a team has 11 pending games, whose opponents by jornada are TFC, Sportivo Malvin, Ligamentos Cruzeiro, La Axioneta, Montevinas FC, C.A.Ankara, DELTA FC, Real Rejunte, Carechimba FC, Juana Chard and Inter Mitente FC
- **THEN** its remaining opponents SHALL be those 11 teams in that order, even when a later jornada's game carries an earlier date

#### Scenario: Opponent faced twice

- **WHEN** a team has two pending games against the same opponent
- **THEN** that opponent SHALL be listed once, with a count of 2

#### Scenario: No games left

- **WHEN** a team has no pending games
- **THEN** its remaining opponents SHALL be empty

### Requirement: Byes per team

For every team, the system SHALL derive its byes: the jornadas, among those with at least one game assigned, in which the team has no game. Each bye SHALL carry the jornada's name and order. A bye SHALL be **past** when every game assigned to that jornada has been played, and **upcoming** otherwise. Byes SHALL be ordered by jornada order.

Byes SHALL NOT be derived while jornada assignment is unknown, nor for a team that is not linked to any fixture game. Byes SHALL NOT count as played matches and SHALL NOT affect the consistency check.

#### Scenario: Past bye

- **WHEN** a team has no game in Jornada 4, and every game assigned to Jornada 4 has been played
- **THEN** the team SHALL have a past bye in Jornada 4

#### Scenario: Upcoming bye

- **WHEN** a team has no game in Jornada 15, and the games assigned to Jornada 15 are still pending
- **THEN** the team SHALL have an upcoming bye in Jornada 15

#### Scenario: Partially played jornada

- **WHEN** a team has no game in a jornada where some games have been played and at least one is still pending
- **THEN** that bye SHALL be upcoming

#### Scenario: Byes explain unequal games played

- **WHEN** a 15-team single round-robin has played its first four jornadas completely, and the four teams with `PJ=3` each had no game in one of them
- **THEN** exactly those four teams SHALL have a past bye, one each, in Jornadas 1 to 4, and every other team SHALL have exactly one upcoming bye

#### Scenario: Jornada assignment unknown

- **WHEN** no jornada refresh has ever succeeded
- **THEN** no team SHALL have any bye

#### Scenario: Jornada without games

- **WHEN** a jornada in the list has no games assigned
- **THEN** it SHALL NOT be a bye for any team

#### Scenario: Team without linked games

- **WHEN** a standings team is not linked to any fixture game
- **THEN** that team SHALL have no byes, rather than one in every jornada

### Requirement: Consistency with the standings row

For every team, the system SHALL compare the number of its played matches with its `PJ`, and its won, drawn and lost counts with its `PG`, `PE` and `PP`. Any difference SHALL be flagged so it can be shown.

#### Scenario: Feeds agree

- **WHEN** a team's derived played matches number 3, with 2 won, 1 drawn and 0 lost, and its standings row reports `PJ=3`, `PG=2`, `PE=1`, `PP=0`
- **THEN** no discrepancy SHALL be flagged for that team

#### Scenario: Feeds disagree

- **WHEN** a result has been recorded in the fixture but the standings row does not yet include it
- **THEN** a discrepancy SHALL be flagged for each team whose counts no longer match
