---
description: Full design review — game design, UX, architecture, state, data, security, tests, docs, across every web game
argument-hint: "[optional: focus area, e.g. \"state and concurrency only\"]"
---

Do a full design review of this project — Hedbanz-style "Guess the Character" (on phones held
to foreheads, or on computers with typed guesses) and "Draw the Character", party web games over
one shared core. Read the code before forming opinions: start with CLAUDE.md, README.md,
docs/multiplayer-design.md, docs/multiplayer-ux.md and docs/mobile-app-plan.md to
understand the intended design, then read src/ in full — src/core/ is the shared game rules,
src/compendium/ the content, src/web/ the games (one folder per game, shared pieces at the top)
— and skim test/ to see what behavior is actually pinned down.

Hold every way of playing to the review: a finding that only names the phones when the same flaw
exists on the computers (or in the core they share) is half a finding.

Review across all of these axes. For each, tell me what's well-designed and what
isn't — I want the honest version, not a list of compliments.

1. GAME DESIGN
   - Do the rules hold up? Turn order, pass/guess mechanics, the difficulty system
     (docs/compendium.md "Difficulty"), rerolls, host-picks and pick-for-each-other.
   - Where can a game reach a state that is boring, unfair, or unwinnable? Consider
     2 players vs 8, everyone passing, a player going AFK or losing Wi-Fi.
   - Is judging (who decides a guess is right) sound, or is it exploitable/ambiguous?
     Include the typed-guess checker (src/compendium/answers.js).
   - Does difficulty actually correlate with how hard a character is to guess, or just
     with how obscure the source data says it is?

2. UX AND INTERACTION DESIGN
   - Walk the full flow as a first-time player on each device: create a room → join (QR or
     code) → setup/confirm → turns → results → rematch. Where would someone get confused,
     stuck, or not know it's their turn?
   - Leaks: can any payload reach a player carrying their own character (CLAUDE.md, the
     forehead view vs the board view)?
   - Are button/label/copy choices consistent across the phones, the computers and Draw?
   - Accessibility: reduced motion, contrast through the CRT layer, screen readers, 44px targets.

3. ARCHITECTURE AND CODE DESIGN
   - Is any module doing too much? Propose a concrete decomposition if so, with the
     seams you'd actually cut along.
   - Evaluate the layering: db/ → compendium/ → core/ → web/. Where is that layering violated?
     Does anything in src/core/ import from src/web/, or anything above the compendium query
     its tables?
   - Is Game plus the web's Room the right state model? Rooms live in a process-local registry
     with an abandoned-room sweep — assess the lifecycle, leak potential, and restart behavior.
   - The socket protocols: are events versioned against stale clients, and are a client's
     claims (seat, host, turn) always checked server side?

4. STATE, CONCURRENCY, AND FAILURE
   - All live game state is in memory; only the compendium is in SQLite. What breaks on a
     server restart mid-game, and how do players find out?
   - Race conditions: two players acting on the same turn at once, a clock firing while a
     ruling is pending, a rematch starting before the previous game finalizes, the host
     leaving mid-turn.
   - Network failure modes: a phone sleeping, a socket reconnecting with a stale view, the
     Cloudflare tunnel caching assets. Which of these are handled and which would stall a game?
   - What happens to an unhandled rejection inside a socket handler — does it kill the game,
     the room, or the process?

5. DATA AND DATABASE DESIGN
   - Review src/core/db/schema.sql: normalization, indexes, uniqueness constraints, and
     whether the queries in characterLists.js match how the schema is shaped (and
     src/compendium/schema.sql alongside it).
   - better-sqlite3 is synchronous — is any query on a hot path long enough to block
     the event loop while games are running?
   - Scopes: are list selections properly scoped, and can one room or scope change what
     another is dealt?
   - Character images (src/compendium/characterImages.js, src/web/imageCache.js, scripts/fetch-fandom-images.js,
     clean-character-images.js): how is a bad or hotlink-broken image detected, and what
     does a player see when it fails?

6. EXTERNAL DATA PIPELINE
   - The seeding scripts pull from Wikidata, AniList, Fandom, PokéAPI. Assess rate
     limiting, retries, partial-failure behavior, idempotency on re-run, and whether a
     changed upstream schema fails loudly or silently corrupts the pool.
   - Is data/seed/*.json a cache, a source of truth, or both? Say which it should be.
   - Licensing/attribution obligations for the scraped data and images.

7. SECURITY AND ABUSE
   - Permission model: who can start, end, remove players, or rule? What can a
     non-host do that they shouldn't? Is the seat secret ever published?
   - Untrusted input reaching HTML, a DB query, or a filename — including list names,
     nicknames, notes, chat and guessed text.
   - .env handling and whether anything secret can end up in a log or a client payload.
   - Griefing: room-code guessing, spam-created rooms, flooding a room with seats.
     (src/web/rateLimit.js, roomAccess.js)

8. TESTING
   - test/run.js is a hand-rolled runner over pure modules, and scripts/check-web-socket.js
     drives the real server over sockets. What class of bug can neither ever catch?
   - Which of the risks you found above have no test, ranked by how bad the failure is.

9. DOCS AND MAINTAINABILITY
   - README.md, docs/ and src/web/README.md: do they serve readers, and does each say
     one thing in one place?
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
