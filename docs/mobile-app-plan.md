# Mobile party app: a plan

Taking "Guess the Character" off Discord and onto phones held to foreheads in a circle,
Heads Up–style. Companion to [multiplayer-design.md](multiplayer-design.md) and
[multiplayer-ux.md](multiplayer-ux.md), which this plan assumes throughout — the turn loop,
scoring, difficulty, list curation and reroll rules below are the ones already built, not new
proposals.

**Scope decision going in:** turn-based rotation is kept exactly as it is today (one player
active at a time, everyone else answering/watching), not the simultaneous
everybody-guesses-at-once free-for-all the "grace period, then it pops up" framing might
suggest. That mode is real and worth having later, so the architecture section below is
written to leave room for it without a rewrite — see
[Leaving room for a simultaneous mode](#leaving-room-for-a-simultaneous-mode).

---

## Recommendation: hosted web app, not an app-store app

Build it as a PWA (a web page, installable but not required to be) served from one small
always-on host, not a native iOS/Android app.

**Why this beats native for a party game specifically:**

- **Join has to take ten seconds.** The entire value of the format is spontaneity — five
  people in a room decide to play *now*. "Everyone download this from the App Store first" is
  where that dies. A URL + room code (or a QR code the host's phone displays) gets a guest
  from "let's play" to "in the lobby" without an install, an account, or an app-store rating
  gate.
- **One codebase, both platforms.** A phone-agnostic party will always have a mix of iOS and
  Android. Native means two codebases (or React Native/Flutter, which is a heavier lift than
  this needs for a first version).
- **Tilt detection doesn't need native code.** `DeviceOrientationEvent` /
  `DeviceMotionEvent` are available to mobile browsers on both platforms — this is exactly how
  browser-based Heads Up clones already work. The one wrinkle: iOS Safari requires an explicit
  `DeviceMotionEvent.requestPermission()` call fired from a user tap before it will report
  motion data. That means a real "tap to enable motion" button before a player raises their
  phone — covered in the mechanic spec below, not a blocker.
- **It's the same shape the bot already is.** One authoritative server holding game state,
  thin clients that only render and send intents — that's `GameManager` / `Lobby` / `Game`
  today, keyed by Discord IDs. A phone version keys the same structures by room code and
  device/session ID instead. The server-authoritative model doesn't change.
- **Ships like the bot does.** No app-store review cycle for every fix — deploy the server,
  reload the page. Consistent with how this project is already run (one long-lived process).

**What this costs, honestly:**

- Needs a reachable host (a small cloud box, or a laptop on the same Wi-Fi as the party plus
  something like a QR code pointing at its LAN address). A cloud host removes the "is everyone
  actually on the same network" failure mode and is the better default.
- Phones lock their screens and browsers get backgrounded mid-game far more readily than a
  Discord client goes offline. This needs real reconnect handling — flagged as its own risk
  below, because the Discord bot has almost no equivalent problem to learn from (it assumes a
  server that basically never restarts mid-game; a phone dropping Wi-Fi for three seconds
  mid-party is routine).
- If an app-store presence ever matters (discoverability, feels more "real"), wrap the same
  PWA in Capacitor or a Trusted Web Activity later. The web core doesn't get rebuilt for that.

---

## What's reusable from the current codebase

Worth stating plainly, because it changes how big this project actually is. Having just read
`Game.js`, `GameManager.js` and `engine.js`:

| Layer | Fate | Why |
| --- | --- | --- |
| `db/` (schema, `characterLists.js`, `stats.js`) | **Reusable as-is** | Pure SQLite queries. Nothing in here knows Discord exists. |
| `game/Game.js` | **Reusable almost as-is** | Turn order, `finishedBy`/`surrendered`/`standings()`, `isOutOfContention` — all plain state and arithmetic, no I/O. |
| `game/GameManager.js`, `Lobby.js`, `lobbySettings.js` | **Reusable as-is** | A `Map` keyed by an ID with TTL eviction, and bounds-checking for settings. The key becomes a room code instead of a channel ID; nothing else changes. |
| `util/characterImages.js`, the difficulty cut, reroll recording, list curation, seed scripts, `npm run browse` | **Untouched** | Entirely about content, not delivery. Same lists, same fame-based difficulty, same curation tools, regardless of client. |
| `game/engine.js` | **Rules reusable, I/O rewritten** | The turn-resolution *logic* (the resolved-turns lock, `nextActiveIndex`, pass-vs-give-up, the out-of-contention check) is exactly what a phone version needs too. But every call in it — `channel.send`, `ButtonBuilder`, `users.fetch`, DMs — is Discord API and gets replaced by WebSocket events to specific rooms/sockets. |
| `components/*`, `game/turnBoard.js`, `lobbyBoard.js`, `characterDM.js`, `audienceVote.js` (rendering), `voice.js`, `index.js` | **Replaced** | This is the entire Discord presentation layer: embeds, buttons, DM routing, voice-channel joins. A phone app has its own UI and its own transport (WebSocket, not gateway events), so this layer is rewritten wholesale, not ported. |

So the honest scope is: **the game engine and the content pipeline survive; the entire
interaction surface is new.** That's a smaller project than "rebuild everything," and a bigger
one than "reskin the bot."

---

## Architecture

```
                    ┌─────────────────────────┐
                    │   Node server (host)     │
                    │  - GameManager (rooms)    │
                    │  - turn-loop engine       │
                    │  - SQLite (lists/stats)    │
                    │  - Socket.io               │
                    └─────────────┬─────────────┘
                                  │ WebSocket, per room
        ┌───────────┬────────────┼────────────┬───────────┐
        │            │            │            │           │
   Host phone    Player phone  Player phone  Player phone  (optional)
   (PWA, browser) (PWA)         (PWA)         (PWA)         TV / tablet
                                                             scoreboard view
```

- **One server process, one authoritative game state per room** — the same design the bot
  already has (`GameManager` keyed by channel ID), just keyed by a short room code instead.
- **Clients are thin.** A phone sends intents (`join`, `startGame`, `gotIt`, `pass`,
  `giveUp`, `reroll`) and renders whatever state the server pushes. No client ever decides an
  outcome locally — same principle as today, where the bot is the sole judge of what happened.
- **Identity is per-session, not per-account.** Discord gave the bot free identity (user IDs,
  usernames, a "Manage Server" permission for host-only actions). A phone app has none of
  that. For a first version: a player picks a nickname when they join, gets a session token
  stored in browser storage so a dropped connection can rejoin the same seat, and "host" is
  simply whoever generated the room code. No login required to play. A persistent
  cross-party leaderboard would need *some* identity (even just "remember this nickname/token
  on this device") — worth treating as a v2 feature, not a blocker for v1.

---

## Leaving room for a simultaneous mode

You asked to keep turn rotation for now but not paint the architecture into a corner. The
cleanest seam: keep `Game`'s state (`headByPlayer`, `finishedBy`, `surrendered`, `standings()`)
exactly as it is — it's already mode-agnostic, it just records who has a character, who's done,
and in what order. What's *not* mode-agnostic today is baked into `engine.js`: "exactly one
player may act right now" and "turns are the unit both of pacing and of score."

Isolate that behind a small interface instead of leaving it implicit:

```js
// RoundMode decides who may act and how the game advances. Game itself stays a plain
// record of who has what and who's finished — see Game.js.
interface RoundMode {
  canAct(playerId): boolean;        // is this player allowed to declare "got it" / pass right now?
  onCorrect(playerId): void;        // record the result, advance whatever "advance" means for this mode
  onPass(playerId): void;
  isOver(): boolean;
}
```

- `TurnRotationMode` — today's rules, ported as-is: only `currentPlayerId` can act, "got it"
  and "pass" both advance the rotation, scored by `turnsFor(playerId)`.
- A future `SimultaneousMode` — everyone can act, always; "got it" just records a completion
  timestamp instead of a turn count; ranking becomes "order of self-declared completion"
  instead of "fewest turns." No change to how characters are dealt, how rerolls work, how
  standings render, or how the reveal works — only *who may act* and *how "place" is computed*
  differ.

This is a small amount of extra structure now (one interface, one implementation) in exchange
for the second mode being additive later instead of a rewrite of the turn loop. Worth doing
even if simultaneous mode never ships.

---

## The reveal mechanic — the actual new thing here

This has no Discord equivalent, so it gets its own detailed spec rather than a row in the
mapping table below.

### Phases

1. **Setup (screen in hand, normal use).** Same shape as today's confirm DM: each player is
   shown the character belonging to the next player in rotation (their one designated
   "checker," exactly as `checkTargetOf`/`checkerOf` already define) with **Good to go /
   Reroll / 🚫 Never deal this show**, plus a scrollable reference list of everyone else's
   characters. This is a strictly *better* fit on a phone than in a Discord modal — no 5-input
   cap, real search/autocomplete, no message-splitting logic needed at all, since it's just a
   normal scrolling screen.
2. **Lock-in.** Once everyone taps Good to go, the server starts a synchronized grace-period
   countdown, broadcast to every phone at once: *"Get your phone up! Revealing in 5… 4… 3…"*
   — audio + haptic buzz, since this is the last moment anyone's looking at their own screen
   normally.
3. **Reveal.** At zero, every phone simultaneously switches into **forehead mode**: full-screen
   character card, high contrast, big text, locked orientation, no visible buttons — because
   from this point the player physically cannot see their own screen and must not be able to
   trigger anything by touch. This is the wearer's *own* character, which they never see (same
   secrecy the game has always had — the phone is standing in for the physical card).
4. **Play.** Turn rotation proceeds exactly as today's rules. The room polices correctness the
   same way a physical Hedbanz table always has: everyone can literally see the forehead screen,
   so there's no digital "judge" step to replicate — this is a genuine simplification, not a
   missing feature (more below).
5. **Resolution gestures**, only available to the *current* player, only while in forehead
   mode, both motion-based because they cannot look at or aim for a button:
   - **Tilt up and hold ≈700ms → "Got it!"** Debounced deliberately: a snap-tilt while nodding
     or talking must not register. This mirrors Heads Up's own implementation, and matters more
     here than it does there, because a false positive here isn't just annoying — it ends the
     player's turn and reveals their own character to *themselves* early, which can't be undone
     any more than a Discord `✅` misclick could. The debounce is the guard; there's no digital
     confirmation step to add on top of it, because there's no one to ask — the player is the
     only one who can trigger it.
   - **Tilt down and hold ≈700ms, or lower the phone out of forehead orientation → Pass.**
     Lowering the phone is itself detectable (orientation leaves the "held vertically against a
     forehead" range), and is the natural physical gesture for "I'm done with this one" — no
     button-hunting needed either way.
   - **Give up** isn't a blind gesture, on purpose — it's the one irreversible, one-way-door
     action (same reasoning the bot's `✅` guard already documents: nothing can undo a public
     reveal once it's happened). Lowering the phone fully out of forehead mode exposes a normal,
     tappable screen again, with a **Give up** button that requires a second confirming tap.
     Getting there is deliberately a two-step physical action (take the phone down, then tap
     twice) precisely because it should not be triggerable by accident the way a quick tilt can.
6. **Between turns / not your turn.** Everyone else's phones stay in forehead mode the whole
   game (exactly as in physical Hedbanz — you don't get to peek at your own head between other
   people's turns, or you'd see your own answer). The only thing a non-active player's phone
   needs to do is buzz once, briefly, when it becomes their turn — there is no on-screen "turn
   board" to check, because nobody can see their own screen to check it.

### Why self-declared "got it" is fine here, when the bot deliberately avoided it

The design docs are explicit about *why* Discord moved judging to everyone else: the guesser is
busy talking and racing a clock, self-reporting requires them to stop and interact with a UI,
and the bot has no way to independently verify a guess said out loud. None of that changes here
except one thing — **the gesture requires no attention and no aim.** A tilt is available to a
player who is mid-sentence and not looking at anything. The room is still the actual judge, in
exactly the sense it always was in a physical version of this game: everyone can see the
forehead screen and will yell "no, wait" if someone tilts on a wrong guess. The bot's version
had to replace that social layer with a UI because the crowd couldn't act as a check on
something they weren't all looking at through a screen; the phone-on-forehead format puts the
crowd back in line of sight of the actual answer, so it doesn't need replacing.

### Standings, without a board to check

Nobody is watching a shared screen turn to turn — everyone's phone is on their own forehead.
So standings need a different delivery point than the Discord turn board:

- A short **audio/haptic cue** announces completions to the whole room as they happen ("Kira
  got it in 2!"), mirroring today's public completion message.
- Each player sees the full standings **the moment their own phone leaves forehead mode** —
  on give-up, on finishing, or any time they physically lower it — since that's already the
  moment they're looking at the screen normally.
- Optional and worth prototyping rather than committing to up front: an **ambient scoreboard
  view** — one extra device (a tablet propped up, or a phone cast to a TV) joins the room
  read-only and shows the live standings continuously, for the ambiance a "spectate" role gave
  in Discord, and useful for a non-playing host or someone waiting a round out.

---

## Feature mapping

| Discord version | Phone version | Notes |
| --- | --- | --- |
| `/lobby create`, lobby board with Join/Leave/Spectate/Start | Host phone generates a room + QR code / short code; others join via link + nickname | No Discord identity, so a nickname (plus a color/avatar for quick recognition) replaces username+avatar |
| `from:` picker (random/category/list), `/list select`, `top:N` curation | Same picker, same underlying `characterLists.js` queries, on a normal scrollable screen | Curation tooling (`/list toggle`, the checkbox page) fits better as a small companion admin web view than as something done live in the circle |
| Difficulty cycle button | Same toggle, host settings screen | Untouched logic (`difficulty` cut is per-list, already content-side) |
| `/lobby set-characters`, 🎭 modal (capped at 5 players) | Same feature, no 5-player cap | The cap existed only because of Discord's 5-modal-input limit; a scrolling phone screen has no such ceiling |
| Confirm/reroll DM, one checker per character, "Good to go" | Same screen, same one-checker-per-character rule (`checkTargetOf`/`checkerOf`), normal phone-in-hand UI | Reused rule; new UI (see reveal mechanic above) |
| Turn board (countdown, standings, judge buttons, Pass) | No shared board to look at — audio/haptic cues + the mechanic above | Biggest structural change: the *board* was standing in for physical visibility the phone-on-forehead format restores directly |
| ✅ They got it / ❌ Nope (external judge) | Self-declared tilt-up / tilt-down gestures | Deliberate reversal of the bot's judging model — see rationale above. The race-condition problem the bot's `resolvedTurns` lock exists to solve (multiple judges pressing at once) disappears, since only the current player can ever trigger their own turn's resolution |
| ⏭️ Pass / 🏳️ Give up split, out-of-contention note | Same two controls, same distinction (pass never surrenders you) | Pass = gesture (in forehead mode); Give up = deliberate two-tap action after lowering the phone, matching the one-way-door guard already used for ✅ |
| Turn timer, countdown chime, amber last-chance state | Same timer semantics, per-player local audio/haptic instead of a shared board turning amber | Every player's device can always play sound — the bot's "one voice connection per server" constraint doesn't exist for a phone app at all |
| Public completion reveal | Audio/haptic cue to the room + standings shown to that player on lowering their phone | |
| Fewest-turns scoring, ties, standings | Unchanged (`Game.standings()`, `bestTurnCount`, `isOutOfContention`) | Reused as-is |
| Reroll recording, 🚫 Never deal this show | Unchanged | Server-side, content-side, no client dependency |
| Audience-vote mode | Same feature, opt-in; non-playing phones in the room vote from their own screen | Lower priority — the format already puts the "audience" in the room able to just look, unlike a text channel |
| Sound effects, one voice connection per server | Every phone plays its own local audio, always | Strict improvement — the bot's "text-only fallback for a second concurrent game" limitation has no phone-app equivalent |
| Rematch / Leaderboard buttons | Rematch = redeal same room/roster/settings; leaderboard = TBD scope | See [Identity and leaderboard scope](#identity-and-leaderboard-scope) below |
| `active_boards` restart sweep, timer watchdog for sleep | Reconnect/resume handling | See [Reconnection](#reconnection-matters-more-here-than-it-does-on-discord) below |
| "One game per channel" | "One game per room code" | Direct equivalent, same `GameManager` shape |

---

## New risks that didn't exist on Discord

### Reconnection matters more here than it does on Discord

The bot's restart-resilience code (`active_boards`, `timerWatchdog.js`) exists for a scenario
that's actually rare: the bot process restarting mid-game. On a phone, the equivalent event —
a dropped Wi-Fi packet, a screen lock, the browser backgrounding the tab — is *routine*, not
rare, and will happen constantly across a five-to-eight-person party. This needs to be a first-
class part of the design, not an edge case bolted on:

- A session token per player, stored client-side, so a reconnect resumes the same seat instead
  of the server treating it as a new join.
- The server keeps authoritative state regardless of any one socket's connection status —
  already true of `GameManager`/`Game` today, since they're plain in-memory objects independent
  of the Discord client.
- A turn's countdown must be wall-clock-anchored server-side (as `timerWatchdog.js` already
  does for sleep), not dependent on a client-side timer that a backgrounded tab may throttle or
  pause.
- The **guesser's own reconnect** is the sharp edge: if their phone drops mid-turn, does the
  clock keep running against them, or pause? Worth deciding deliberately rather than by
  accident — probably pause briefly and resume, since a party game shouldn't punish a Wi-Fi
  hiccup the way it might reasonably ignore a distracted player on Discord.

### Motion permission is a real UX step, not a formality

iOS Safari won't hand over tilt data without an explicit permission prompt fired from a tap.
That has to happen *before* a player raises the phone to their forehead — a "tap to enable
motion, then get ready" screen, per player, during setup. Android doesn't need this, so the
flow should skip the step where it isn't required rather than showing a no-op prompt.

### Gesture false-positive/negative tuning needs real playtesting

The 700ms hold-and-tilt threshold above is a starting guess, not a measured number. Heads Up
shipped years of tuning here; expect to spend real playtest time on how sensitive tilt-up/
tilt-down should be, especially since the failure modes are asymmetric — a missed "got it" is
just annoying, a false "got it" spoils the player's own character early and can't be undone.

### Identity and leaderboard scope

Discord gave the bot server-scoped identity for free (a guild's persistent leaderboard, a
Manage Server permission gate). A phone app run from a fresh room code each time has no
natural equivalent of "this server's leaderboard." Options, not yet decided:

- **No persistence, v1.** Leaderboard exists only for the current session/party. Simplest,
  ships fastest, matches "spontaneous party game" framing.
- **Device-local history.** A phone remembers its own past results across parties (browser
  storage), no server-side identity needed.
- **Lightweight named profiles.** A player picks a stable nickname once; the server tracks
  stats against nickname collisions well enough to be useful without real accounts.

Recommend shipping v1 with no persistence and revisiting once people are actually playing —
this mirrors how `/lobby end` recording partial results was explicitly sequenced *after* the
core turn loop in the original multiplayer build, not before.

---

## Build order and status

Each stage leaves something playable, the same discipline
[multiplayer-design.md's implementation sequence](multiplayer-design.md#implementation-sequence)
used. **Stages 1–4 are built and committed** (see `src/web/`, and `src/web/README.md` for how
to run and test). What actually got built matched the plan closely; the notable deviations are
recorded below, since the deviations are the useful part of a status update.

1. **Server skeleton — done.** Room codes + Socket.io join/leave, keyed by a 4-letter room code.
   A web-specific `src/web/rooms.js` holds membership (nickname + live connection flag per seat)
   rather than reusing the Discord `Lobby`, which models neither; seats are keyed by a persistent
   client `playerId` so a reconnect reclaims the same seat.
2. **Setup flow — done.** Pool/difficulty picking, deal, and the confirm/reroll screen, in
   `src/web/guess/gameSetup.js` (pure, content injected) over the real core `Game`. The checker-target
   rule and reroll recording are reused verbatim (rerolls no longer retire anyone -- see the README). The web deals from its own compendium scope
   (`'web'`, or `WEB_SCOPE`) with its own playable selection (`npm run select:lists`). It
   originally auto-resolved to the richest Discord guild, i.e. it played that server's
   selection; the compendium's scopes ended that (see "The compendium" in the README).
3. **Turn loop — done.** `src/web/guess/turnLoop.js` ports `engine.js`'s rules (rotation, fewest-turns
   scoring, pass/give-up, resolve-once, out-of-contention) over the core `Game`, with a
   server-authoritative wall-clock turn timer.
4. **Forehead mode + tilt — done.** Grace countdown → full-screen wearer's card → tilt to answer.
   Deviations from the plan sketch:
   - **Tilt axis.** Screen-normal gravity, not the `beta` angle first imagined — beta alone
     barely moves when the phone is held horizontally on the forehead, which read as "tilt not
     working." It is computed from the orientation angles as `cos(beta)·cos(gamma)`, which works
     in both orientations and means the same on every platform; raw
     `accelerationIncludingGravity.z` is only a fallback, because its sign differs between
     browsers (that swapped up and down for some Android players). The fallback learns its sign
     from taps rather than a manual "flip". Up = got it, down / timeout = pass, debounced. The two
     directions are tuned asymmetrically (up 6.5 / 600ms vs down 5.5 / 450ms) because tilting
     up is the irreversible one.
   - **Always landscape.** iOS gives web pages no way to unlock or force orientation, so the card
     is CSS-rotated to landscape even under a portrait lock, with a ▲ TOP guide during the
     countdown. This replaced an accelerometer-driven auto-rotate that was fussier than it was
     worth.
   - **HTTPS.** Motion sensors need a secure context, so `npm run web:secure` serves HTTPS on
     `:4443` *alongside* HTTP on `:4180` (one Socket.io across both), via a self-signed cert.
   - **Always-on tilt**, requested on the first user gesture — no opt-in button. Tap fallback
     covers refusal / no sensor.
   - **Rerolls are unlimited** in both frontends (the budget was pure friction); the reroll
     button shows no count.
5. **Reconnection hardening — done.** Seats now track a *set* of live socket ids (not a single
   flag), so multi-tab and reconnect-ordering never wrongly mark a player offline. The current
   player dropping **pauses** their turn clock and reconnecting **resumes** it (bounded at 30s so
   a no-show doesn't freeze the game). A 3s wall-clock **watchdog** sweeps turn/countdown
   deadlines so a suspended process doesn't hang a turn — the same role as the Discord bot's
   `timerWatchdog`. Server-restart persistence stays out of scope, the same call the Discord side
   made.

   **Revised: the seat secret is no longer published.** This first shipped with the client
   `playerId` as both the identity AND the id in every roster, on the reasoning that seat-hijacking
   wasn't a realistic threat at a LAN party. Once the site was public that reasoning failed: anyone
   in a room could read the host's id off the roster and connect with it, and on the computers,
   joining as the next player shows you their board -- your own character on it. The browser's id
   is now a secret that only travels in the handshake; seats are keyed by a public id derived from
   it with a server-side key (`src/web/roomAccess.js`), so reconnects still reclaim the exact seat.
   Room-code lookups and failed joins are limited per client address, not per socket.
6. **Polish — mostly done.** Shipped: **rematch** with the same settings (redeal to the same
   roster, straight back to the confirm phase); **QR-code joins** (an `/api/qr` SVG endpoint, a
   scannable code on the lobby); **preferring characters with artwork** (`preferImages` on the
   core draw/reroll, OFF by default and offered as a host toggle -- restricting the draw shrinks
   the pool and biases it toward the better-documented franchises, so it is the host's call);
   light **audio cues** (turn-start / finish / win); and the read-only **character
   compendium** (category -> list -> character, over plain HTTP). Still open: an optional read-only **scoreboard device** (a spectator join that
   shows live standings for a propped-up tablet or a cast TV) and richer haptics.

`RoundMode` (`src/core/game/roundMode.js`) exists as planned even though only `TurnRotationMode`
ships, so a simultaneous mode stays additive.
