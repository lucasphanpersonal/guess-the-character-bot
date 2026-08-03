# Multiplayer design

Generalising the game from exactly two players to any number, and replacing the
first-correct-guess-wins race with "everyone plays until they get it, ranked by turns taken".

This is a **simplification**, not just a generalisation: the rebuttal rule, the guess counter
and the rematch turn-order swap all disappear, and nothing replaces them.

---

## The rule

Every player is dealt a character they can't see. Players take turns in rotation. On your turn
you ask questions out loud and guess; anyone who can see your character can rule on it.

**When you get your character, you're done** — your character is revealed publicly, and you
drop out of the rotation. Play continues for everyone else. Your score is the number of turns
you took.

**The game ends when nobody is left guessing.** Fewest turns wins; equal turn counts tie.

### Why turn count, and not anything else

The current game stops at the first correct guess, which hands the first mover a turn nobody
else has had — hence the rebuttal special case in `engine.js`. Ranking by *turns taken* rather
than by *who finished first in wall-clock order* removes the advantage at the source: everyone
is racing their own turn count, so going first buys nothing.

That makes today's rebuttal rule a special case of this one. Two players, both playing until
they get it: P1 on turn 3 and P2 on turn 3 tie, P2 on turn 4 loses. Those are exactly the
outcomes the rebuttal branch produces today, with no exception branch to write.

Turn count is also the only score worth keeping, because **it is the only one the bot observes
directly**. The old wrong-guess count only existed if the judge remembered to press ❌ — it
undercounted, and undercounted worst for the players conscientious enough to click. Turns are
counted by the thing that hands them out.

---

## What gets deleted

| Thing | Where | Why it goes |
| --- | --- | --- |
| `recordGuess`, `guessLog`, `turnGuesses`, `guessCountFor` | `Game.js` | No guess counting at all |
| `guessTally`, the "Guesses so far" field, `wrongSoFar` on the ❌ label | `turnBoard.js` | Same |
| `— on guess #4, round 3` | `engine.js` `finalizeGame` | Same |
| `game.rebuttal`, the rebuttal branch in `endTurn`, the "🔁 Rebuttal turn" title | `Game.js`, `engine.js`, `turnBoard.js` | Turn-count scoring removes first-mover advantage |
| Turn-order swap | `rematch.js` | Same — there is no longer a disadvantageous seat |
| `game_results` table | `schema.sql`, `stats.js` | Two hardcoded player columns can't hold N |

### ❌ survives, without the number

The wrong-guess button keeps two jobs that were never about counting:

- it plays the wrong-guess sting in voice (`voice.playWrongSound`), and
- it is the only exit from the amber last-chance state after a turn's timer expires.

It loses its running count, which means mid-turn presses no longer visibly land — the buzzer
becomes the only feedback, and only for players in voice. Accepted.

---

## Turn loop

New state on `Game`:

```js
this.turnsTaken   = new Map();  // playerId -> turns taken so far
this.finishedBy   = new Map();  // playerId -> turns taken when they got it
this.surrendered  = new Set();  // playerId (at most one, see below)
```

`round` and `currentTurnIndex` are replaced by a pointer that walks the rotation skipping
players who are no longer active.

```
active(p)     = !finishedBy.has(p) && !surrendered.has(p)
nextPlayer()  = walk forward from the current index, wrapping, to the first active player
```

- On turn start: `turnsTaken[player] += 1`, then post the board.
- On ✅: record `finishedBy[player] = turnsTaken[player]`, reveal their character publicly,
  play the win sting, advance.
- On ❌ while paused, or ⏭️ Pass with others still active: advance.
- When `nextPlayer()` finds nobody, the game is over.

### "Round N" becomes "your turn N"

A global round counter drifts from the thing being scored as players drop out — once one
player is alone, every turn is a fresh round for them anyway. The board shows the current
player their own turn number, which is the number they are actually racing.

### Judging

`game.judgeId` (`turnOrder.find(id => id !== currentPlayerId)`) becomes "anyone who is not the
current player". The turn board collapses from two rows to a shared judge row plus the
guesser's own control, and the roles line stops naming one judge by mention.

Players who have already finished keep judging. They were DM'd every character at the start,
so they remain qualified, and it gives them something to do rather than turning them into
spectators.

### Revealing on completion

A finished player's character is announced in-channel immediately. It spoils nobody: everyone
else already knew it, and the player themselves just guessed it. This gives the game a run of
small payoff moments instead of one reveal at the end.

---

## Pass becomes surrender when you're alone

Once you are the last active player, Pass has nobody to pass to — a press would cycle straight
back to you. The button is therefore free, and becomes **give up**.

Two guards:

- **Relabel it.** While others are active it renders as `⏭️ Pass` in grey; when you are the
  last one it renders as `🏳️ Give up` in red. The board already re-renders on every countdown
  checkpoint, so this costs nothing. Without it, a player who has been passing all game
  forfeits out of muscle memory.
- **It is the only way out.** There is no auto-surrender on repeated timeouts (deliberate).
  A player who stops responding leaves their turn parked in the amber last-chance state
  indefinitely, and the game neither finishes nor records a result.

`/lobby end` is the manual exit for that case. It currently *cancels* — the game is discarded
and nothing is written. It should instead, for a game already in progress, **record the
results of everyone who finished** and mark the rest as gave-up. Nothing becomes automatic; a
human still decides, but deciding no longer throws away a completed game's worth of results.

### Consequence: you can't quit early

Because players only leave the rotation by finishing, surrender is unreachable until everyone
else is done. A player who wants out of a six-way game must keep taking turns until they are
last. Accepted; `/lobby end` is the escape hatch.

---

## Scoring and schema

```sql
CREATE TABLE games (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);

CREATE TABLE game_players (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  -- Turns this player took to get their character. NULL when they never got it: they gave
  -- up, or the game predates turn tracking.
  turns_taken INTEGER,
  outcome TEXT NOT NULL, -- 'won' | 'lost' | 'gave_up'
  PRIMARY KEY (game_id, user_id)
);
```

`outcome` is stored rather than derived from `MIN(turns_taken)` for one reason: the migrated
two-player history has no turn counts, and inventing them would be a lie about the data. With
`outcome` explicit, legacy rows carry a truthful result and a NULL turn count, and the
leaderboard reads the same column for both eras. A tie is simply more than one `'won'` row.

### Migration

`connection.js` already has a migration idiom (`PRAGMA table_info` + `ALTER`), but this is a
table split rather than a column add. Guarded on `game_results` still existing:

```sql
INSERT INTO games (guild_id, player_count, finished_at)
  SELECT guild_id, 2, finished_at FROM game_results;
-- then one row per player, outcome mapped from result, turns_taken left NULL
```

Keep `game_results` in place after the backfill rather than dropping it — it costs nothing and
makes the migration reversible.

### Leaderboard

`getPlayerStats` and `getLeaderboard` in `stats.js` are rewritten against the new tables.
Wins/losses/ties come from `outcome` (a tie being a `'won'` row in a game with more than one).
`AVG(turns_taken)` over won games is now available and worth showing — it is the first honest
"how good are you" number the bot has ever had.

---

## Where the caps actually land

The core loop has no player ceiling. Three peripheral surfaces do, and they are Discord's
limits rather than design choices — so each is gated at its own limit instead of one global cap
on the game.

| Surface | Discord limit | Ceiling | Handling |
| --- | --- | --- | --- |
| Audience-vote ballot (`buildBallotPayload`) | 5 action rows per message; it builds one select per player | **5 players** | Audience-vote mode refuses to start above 5, saying why. Paginating the ballot is possible later. |
| Spectator DM (`sendSpectatorDMs`) | 10 embeds per message | **10 players** | Split across multiple messages past 10. |
| `/lobby set-characters` | 25 options per command; it needs 2 per player | **12 players** | Gate the command above 12. It is a niche host tool. |
| Confirm DM (see below) | 10 embeds per message | **11 players** | Same split. |
| `drawCandidates` | needs `voteOptions × players` distinct characters | pool-dependent | Already reported by the existing error path; just needs the new multiplier. |

`SLOTS = ['1', '2']` in `audienceVote.js` becomes a slot per player throughout — the vote board
adds one embed field per player, which is fine to 25.

---

## The confirm/reroll DM

The largest genuinely new design question, because the existing shape depends on an assumption
that N players break.

**Characters are shared, not per-viewer.** There is one set of N assignments, and each player
sees the N−1 they aren't wearing. At two players that makes a reroll *private* — P1 rerolls
P2's character and P1 is the only person who can see it, so nothing else needs updating. At
four, P1 rerolling P3's character invalidates what P2 and P4 are looking at.

### One checker per character

**Each player checks the character of the next player around the rotation** — P1 checks P2's,
P2 checks P3's, … PN checks P1's. That player, and only that player, may reroll it or hit
`🚫 Never deal this show` on it.

At N=2 this *is* the current behaviour, bit for bit: P1 checks P2's, P2 checks P1's. Which is
the argument for it — the same argument that made turn-count scoring beat the rebuttal rule.

It also removes two problems rather than solving them:

- **No conflicts.** With any viewer able to reroll, two people can hit reroll on the same
  character within a second of each other and the second press clobbers a replacement nobody
  objected to. One authority per character makes the race unrepresentable.
- **No churn.** `maxRerolls` is budgeted per player, which bounds nothing per character — six
  players with two each could dump twelve rerolls on one character, each one making it *less*
  likely everybody knows the result. One checker means one person's budget per character, with
  no extra cap needed.

The cost: if P4 doesn't recognise a character P1 already approved, P4 has no recourse. That is
the right trade at N players, because the burden of answering questions is now spread across
N−1 people — one person not knowing the character matters far less than it does at two, where
they are the only answerer.

### Rerolls still have to fan out

This is the price of shared visibility, and no choice of checker avoids it. When P1 rerolls
P2's character, every *other* player's DM is showing the old one and must be re-rendered.

That includes players who have already confirmed. Their DM has had its buttons stripped to
`✅ Locked in!`, but they still need the new character to answer questions about it — so the
fan-out updates content and embeds on confirmed DMs too, just without restoring any controls.

The reroll button's customId is currently `reroll:${channelId}`, which carries no target. It
needs the character it is replacing, so a press that arrives after a fan-out can be answered
with "that one's already been rerolled" instead of silently rolling the fresh one.

### Layout

**Two DMs per player** — see [multiplayer-ux.md](multiplayer-ux.md#split-the-confirm-dm-into-two-messages)
for the reasoning:

- **"The character you're checking"** — one embed, with `[Good to go] [Reroll] [🚫 Never deal
  this show]` beneath it. Identical to today's two-player DM.
- **"Everyone else's characters"** — the other N−2 embeds, no components.

Discord renders components after *all* embeds, so a single message would strand the button row
four images away from the character it acts on, with nothing on screen saying which embed it
belonged to. Splitting restores the adjacency and confines the 10-embed ceiling to the message
that has no buttons.

2N DMs per game — nowhere near the rate limits that rule out the per-character variant (N−1
separate DMs each with their own button row, which is N×(N−1), or 90 at ten players).

`Good to go` keeps its current meaning of "I've read all of these and I'm happy with mine",
and play still begins once every player has pressed it.

Rerolls remain budgeted per player (`maxRerolls`).

---

## Implementation sequence

Each stage leaves the bot shippable, and two-player games working throughout.

Stages 1–3 are **done** — the live bot now scores on turns at two players, and the rebuttal
rule is gone. Everything from stage 4 on is the actual multiplayer work.

1. ~~**Strip the guess counter.**~~ Done. `recordGuess`/`guessLog`/`turnGuesses`/
   `guessCountFor`, the tally field, the ❌ label count and the `on guess #N` clause are gone.
2. ~~**New schema + stats rewrite,**~~ Done. `games` + `game_players`, with the backfill in
   `connection.js` renaming `game_results` to `game_results_legacy` on the way through. Verified
   against the old algorithm on a copy of the live database: 15 games migrated, 6 player records
   cross-checked, no difference in wins/losses/ties.
3. ~~**Turn loop generalisation.**~~ Done. `turnsTaken`/`finishedBy`/`surrendered`, the skipping
   rotation, per-completion public reveals, Pass-as-surrender, and ranking by fewest turns.
   The standings field came forward from
   [multiplayer-ux.md](multiplayer-ux.md#put-standings-on-the-board) with it, because the
   scoring is otherwise invisible. Still capped at 2 players. See
   [What "reproduces the old outcomes" does and doesn't mean](#what-reproduces-the-old-outcomes-does-and-doesnt-mean)
   for how the tests were framed — winners match, end conditions deliberately don't.
4. **Lift the lobby cap.** `Lobby.addPlayer`, the `!== 2` guards in `startGameFromLobby` and
   the board's Start button, `getRandomPair` → `getRandomCharacters(n)`, the confirm/spectator
   DM rework, the shared judge row.
5. **Pass-as-surrender,** including the relabel, and `/lobby end` recording partial results.
6. **Audience vote for N,** with the 5-player gate.
7. **README.** The rules, the scoring, the reveal-on-completion behaviour, and why the
   rebuttal rule is gone.

Stage 3 is the one worth writing tests for first — with the caveat immediately below.

### What "reproduces the old outcomes" does and doesn't mean

At two players the new rule produces **the same winner in every case**, which is the check
worth running. It does **not** produce the same *end condition*, and conflating the two will
produce a wrong test.

| Situation | Old rule | New rule | Winner |
| --- | --- | --- | --- |
| P1 correct on turn k, P2 correct on their turn k | rebuttal → tie | both finish on k | tie — same |
| P1 correct on turn k, P2 fails turn k | rebuttal squandered → P1 wins | P2 plays on, finishes ≥ k+1 | P1 — same |
| P2 correct on turn k (P1 already failed turn k) | ends immediately, no rebuttal | **P1 plays on** | P2 — same |

The third row is the one that changes visibly, and it is the most common way a game ends today.
`'the second player winning ends the game immediately (no rebuttal owed)'` in
`game-flow.test.js` asserts `status === 'FINISHED'` right after that judgement, and that
assertion becomes false — the game is still running, with P1 alone. The test should be rewritten
to assert the eventual winner, not the immediate stop.

### The loser now plays an epilogue, and it's dead time unless framed

Follow the third row through. P2 finished on turn k; P1 used turn k and failed it, so P1's next
turn is k+1 and **P1 can no longer tie**. They are mathematically out the moment P2 finishes,
and every turn after that changes nothing about the result.

This generalises: you are eliminated once `min(finished turn counts) < your next turn number`.
Being alone and being eliminated are different conditions — in a five-way game the last player
alive may still be playing for second place — but **in 1v1 they coincide exactly**, so the most
common game in the bot is also the one where the epilogue is most obviously pointless.

Two ways to read that, and it should be a deliberate choice rather than a side effect:

- **As a feature.** You still get to find out who you were by working it out, rather than being
  told. `🏳️ Give up` is right there when you'd rather not. The board should say which it is:
  "Sam finished on turn 3 — you can't catch them, but you can still get yours."
- **As a wart.** The game used to end crisply on the winning guess, and now it trails off.

The first is cheap and needs only the context line already specified in
[multiplayer-ux.md](multiplayer-ux.md#smaller-items). Worth trying before adding any rule to
end the game early, which would reintroduce a special case of exactly the kind this design
deleted.

---

## Open assumptions

Flagged rather than decided, because they only matter once it's being played:

- **Turn length probably wants to fall as players finish.** A six-way game at 60s is a
  six-minute cycle; by the time two players are left it is two minutes and the pace changes
  character. Left alone for now — the host can already change `turn-seconds` from the board.
- **A disconnected player parks the game.** No auto-surrender is deliberate, so `/lobby end` is
  the answer, and stage 5 makes it a non-destructive one.
- **Ties are common at small turn counts.** Two players getting it on turn 2 is unremarkable,
  and there is deliberately no tiebreaker. If that turns out to feel flat, the tiebreaker
  people will reach for is wall-clock time within the round — which is available for free and
  requires no button presses.
