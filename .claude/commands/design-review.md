---
description: Full design review — game design, UX, architecture, state, data, security, tests, docs, across both frontends
argument-hint: "[optional: focus area, e.g. \"state and concurrency only\"]"
---

Do a full design review of this project — Hedbanz-style "Guess the Character", played
either through a Discord bot or a phone-in-hand party web app, both over one shared core.
Read the code before forming opinions: start with CLAUDE.md, README.md,
docs/multiplayer-design.md, docs/multiplayer-ux.md and docs/mobile-app-plan.md to
understand the intended design, then read src/ in full — src/core/ is shared,
src/discord/game/engine.js is the bot's core (~1000 lines), src/web/ is the web app — and
skim test/ to see what behavior is actually pinned down.

Hold both frontends to the review: a finding that only names the bot when the same flaw
exists in src/web/ (or in the core they share) is half a finding.

Review across all of these axes. For each, tell me what's well-designed and what
isn't — I want the honest version, not a list of compliments.

1. GAME DESIGN
   - Do the rules hold up? Turn order, pass/guess mechanics, the difficulty system
     (README "Difficulty: how obscure a character you'll be dealt"), reroll-teaches-
     the-pool, and audience-vote mode.
   - Where can a game reach a state that is boring, unfair, or unwinnable? Consider
     2 players vs 8, everyone passing, a player going AFK, an audience that doesn't vote.
   - Is judging (who decides a guess is right) sound, or is it exploitable/ambiguous?
   - Does difficulty actually correlate with how hard a character is to guess, or just
     with how obscure the source data says it is?

2. UX AND INTERACTION DESIGN
   - Walk the full flow as a first-time player: /lobby create → join → start → DM
     confirmation → turns → game over → rematch. Where would someone get confused,
     stuck, or not know it's their turn?
   - Split-brain risk between the channel board and the DM confirmation flow.
   - Ephemeral vs public messaging: is anything leaked that shouldn't be (a player
     seeing their own character), or hidden that should be visible?
   - Are button/label/copy choices consistent across lobbyButtons, turnControls,
     voteControls, gameOverControls, listBrowser, listFilter?
   - Accessibility of the boards: do they read sensibly as plain text, and do they
     survive on mobile and in a narrow client?

3. ARCHITECTURE AND CODE DESIGN
   - Is engine.js doing too much? Propose a concrete decomposition if so, with the
     seams you'd actually cut along.
   - Evaluate the layering: commands/ → game/ → db/, plus components/router.js as the
     single customId dispatch point. Where is that layering violated? Separately: does
     anything in src/core/ import from src/discord/ or src/web/? That invariant is what
     keeps the two frontends from fusing.
   - Is Game / Lobby / GameManager the right state model? GameManager holds lobbies in
     a process-local Map keyed by channelId, and deliberately retains FINISHED lobbies
     for /rematch — assess the lifecycle, leak potential, and restart behavior.
   - customId encoding: is the `<namespace>:<...>` scheme robust against Discord's
     100-char limit, stale controls from older deploys, and IDs from a different game?

4. STATE, CONCURRENCY, AND FAILURE
   - All live game state is in memory; only lists/stats/activeBoards are in SQLite.
     What breaks on process restart mid-game, and is data/activeBoards + timerWatchdog
     a real recovery story or a partial one?
   - Race conditions: two players clicking the same button simultaneously, a timer
     firing while a guess modal is open, a rematch starting before the previous game
     finalizes, /lobby end during a turn.
   - Discord-specific failure modes: the 3-second ack window, the 15-minute interaction
     token expiry, message edit failures, rate limits, DMs closed by the user, a player
     leaving the guild mid-game. Which of these are handled and which would crash a game?
   - What happens to an unhandled rejection inside an interaction handler — does it kill
     the game, the channel, or the process?

5. DATA AND DATABASE DESIGN
   - Review src/core/db/schema.sql: normalization, indexes, uniqueness constraints, and
     whether the queries in characterLists.js (560 lines) match how the schema is shaped.
   - better-sqlite3 is synchronous — is any query on a hot path long enough to block
     the event loop while games are running?
   - Multi-tenancy: are per-guild list selections properly scoped, and can one server
     see or mutate another's data?
   - Character images (src/core/util/characterImages.js, scripts/fetch-fandom-images.js,
     clean-character-images.js): how is a bad or hotlink-broken image detected, and what
     does a player see when it fails?

6. EXTERNAL DATA PIPELINE
   - The seeding scripts pull from Wikidata, AniList, Fandom, PokéAPI. Assess rate
     limiting, retries, partial-failure behavior, idempotency on re-run, and whether a
     changed upstream schema fails loudly or silently corrupts the pool.
   - Is data/seed/*.json a cache, a source of truth, or both? Say which it should be.
   - Licensing/attribution obligations for the scraped data and images.

7. SECURITY AND ABUSE
   - Permission model: who can start, end, force-advance, or judge? What can a
     non-host or spectator do that they shouldn't?
   - Untrusted input reaching an embed, a DB query, or a filename — including custom
     list names and guessed text.
   - .env handling and whether anything secret can end up in a log or an error message
     posted to a channel.
   - Griefing: spam-created lobbies, a host who joins and immediately leaves, someone
     mass-adding junk to a shared list.

8. TESTING
   - test/run.js is a hand-rolled runner over a harness that fakes Discord. Assess the
     harness's fidelity — what class of bug can it structurally never catch?
   - Which of the risks you found above have no test, ranked by how bad the failure is.

9. DOCS AND MAINTAINABILITY
   - README.md is 36k and doubles as design doc, setup guide, and reference. Is that
     serving readers, and how would you split it?
   - Do docs/multiplayer-design.md and docs/multiplayer-ux.md still match the code, or
     has the implementation drifted?
   - How hard is it to add a new interactive control or a new game mode today?

OUTPUT
- Lead with the 5 most important problems, ranked by impact, each with the file:line,
  a concrete failure scenario, and the fix you'd make.
- Then the per-axis findings, kept terse.
- Then a short section on what this project gets genuinely right, so I don't refactor
  away something that's working.
- Flag anywhere the code contradicts the README or docs — treat that as a finding.
- Don't change any code. This is a read-and-report pass.

SCOPE
If anything follows this line, it narrows the review to just that — skip the axes it
doesn't touch, and go deeper on the ones it does: $ARGUMENTS
