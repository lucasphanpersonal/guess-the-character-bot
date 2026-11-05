# Working notes for Claude

Conventions and hard-won rules for this repo. README.md and docs/ are the reference (the README
maps them: discord.md, compendium.md, architecture.md, plus src/web/README.md); this file is the
part that is easy to get wrong twice. Every rule below is here because something broke.

## Shape of the repo

```
src/db/          Opens the SQLite file. No tables of its own.
src/compendium/  The content: lists, characters, scopes, each scope's selection. Own schema.
src/core/        Frontend-agnostic game state + the games' records.
src/discord/     The Discord bot.
src/web/         The web games: shared server/rooms/content, one folder per game.
  guess/           Guess the Character's web rules + room protocol, shared by both ways below.
  party/           Phones (forehead view, tilt). Owns the site root + default namespace.
  desk/            Computers (board view, typed guesses, rulings). /desk/ + namespace /desk.
  draw/            Draw the Character -- a separate game. /draw/ + namespace /draw.
  shared/          What the games share, at /shared/: the look (retro.css on every page, theme.css on
                   the computers) and client helpers. Change the look HERE.
```

**The forehead view and the board view are opposites, and only one may carry your own
character.** `party/view.js` sends each phone its wearer's character on purpose; on a computer
the same field shows you your answer. When adding to either view -- or to any per-player event
-- ask which device receives it. The desk leak check searches whole payloads, because the
dangerous field is never the one named "character".

**A web game gets content through `src/web/content.js`, and rooms through `src/web/rooms.js`.**
Shared web pieces sit at `src/web/`; a game's own rules, protocol and client sit in its folder.
When a second game wants something from `party/`, move it up a level rather than importing
across or copying -- copies are how two games end up disagreeing about the same rule.

**Moving a served file breaks the live server, not just the next one.** The web server reads
the client from disk on every request, so `git mv` of `public/` 404'd the live site until it
restarted on the new path. Bridge a move like that (a directory junction from the old path)
until the live process has restarted, then remove the bridge.

**`core/` never imports from `discord/` or `web/`.** Both frontends depend on the core; the
core depends on neither. This is the one invariant that keeps two frontends from fusing.

**Nothing above the compendium queries its tables.** Content goes through
`src/compendium/characterLists.js`; `compendium/` imports only `db/`, never `core/`. That is
what keeps the content separable from any one game -- and more games are coming. The content
scripts in `scripts/` are the compendium's own tools and are the one exception.

**Every content read is through a scope's eyes.** A scope is anything that plays: a Discord
guild id, or `'web'`. It sees the shared lists (`owner_scope IS NULL`: everything seeded and
everything from `/list create`) plus its own private ones, and `enabled` on any returned row
means *that scope's* selection
(`list_selection`). Pass the scope you are acting for -- never borrow another's. The web app
once played as the richest Discord guild and so read that server's selection, and the shared
`enabled` column it replaced meant a web host unticking a list would have changed what the
server got dealt. Per-room exclusion sets (`Room.excludedListIds`) still exist so one party
cannot reshape the web's selection for the next. The null scope is the compendium itself:
shared lists only, no selection -- it is what the content scripts work against.

**The live database is migrated by whichever new process opens it first** (`compendium/db.js`
on require). A running process on the old code then reads a layout it does not understand.
Rehearse a schema change on a copy (`BOT_DB_PATH`, taken with better-sqlite3's `.backup()`),
and restart every live process together when it ships.

## Verifying a change

```bash
npm test                  # unit suite, no network, no Discord
npm run check:web-socket  # boots the real web server, drives a full game over sockets
```

Both must pass before a commit. Beyond that:

- **Touching anything under `core/`? Boot the Discord bot**, don't just run tests:
  `node src/discord/index.js` and confirm `Logged in as … Loaded 7 commands.` "The tests pass"
  and "the bot still starts" are different claims.
- **Changing web UI? Measure it in a browser.** Read back computed styles and
  `getBoundingClientRect()` — don't eyeball a screenshot and don't assume a CSS rule applied.
  Several bugs here (the sheared card, the sideways pan, the tilt alternation) were invisible
  in description and obvious in numbers.
- **Page URLs are fixed; asset URLs are versioned by the server.** `/`, `/desk/` and `/draw/`
  keep their URLs forever (links and QR codes point at them). `Cache-Control: no-cache` alone did
  NOT keep players fresh: through the tunnel, Cloudflare rewrites it on .js/.css to
  `max-age=14400`, so a player got today's HTML with a script up to 4 hours old -- a Dark Mode
  button that rendered and did nothing. So `server.js` stamps every local script/stylesheet a
  page loads with its file's mtime (`app.js?v=…`). Write plain `src="app.js"` in HTML; never
  hand-version. Test through the public URL (`curl -I https://guess-the-character.com/app.js`)
  when caching is the question -- localhost has no Cloudflare in the way. Your own test tab can
  still hold a stale page: navigate with a cache-buster (`/?cb=2`).
- **A check that only works once is not a check.** `check-web-socket` used to die on the
  second run against its own leftover seed DB. Make fixtures idempotent.
- **Two sessions running `check:web-socket` at once collide.** Both use the same temp DB and
  port; on Windows the first run's open handle leaves the file "delete pending", so the second's
  unlink fails silently and it seeds on top of leftovers ("UNIQUE constraint failed" at seeding,
  nothing to do with your change). Give a concurrent run its own `BOT_DB_PATH` (a fresh path)
  and `WEB_PORT`.
- **Run a check several times before believing it.** The same script failed one run in seven
  because an assertion kept its own hand-written copy of the fixture's cast list, and the
  fixture had grown a character. Derive expectations from the fixture, never restate them --
  and when something is random (a deal, a shuffle), a single green run proves little.
- **Never leave a detached server running.** Each `nohup`/background restart of the launcher
  *adds* a stack rather than replacing one. Four accumulated over one session: one held :4180
  so the user's own launcher could not bind, and three extra Discord bots stayed logged in, so
  every slash command was handled four times. When finished, kill what you started.
- **Never kill a process by port alone.** "Kill whatever holds :4180" cannot tell your leftovers
  from the user's live session, and it took out their running web server twice in one morning --
  while their launcher and tunnel stayed up, leaving a tunnel fronting a dead port. Identify the
  process and its start time first, and only kill ones you can account for starting:

  ```
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select ProcessId,CreationDate,CommandLine
  ```

  Better still, don't compete for the port: `preview_start` with `.claude/launch.json` runs the
  server under the tool's own lifecycle, and `preview_stop` ends it.
- **Bind address and dial address must agree.** The server binds `0.0.0.0`, which is IPv4 only,
  while `localhost` resolves to `::1` first on Windows. Point local clients (the tunnel) at
  `127.0.0.1` explicitly. The failure reads "the target machine actively refused it", which
  blames the server for being down rather than the address for being wrong.
- **Assert positively.** A test that only asserts a 404 passes even when the route is deleted,
  because the static handler 404s too. That is how a deleted `/img` route once shipped green.

## Web client: the design language

Retro arcade: pixel chrome on a starfield, cream panels, four paired colours. All of it is
`shared/retro.css`, loaded first on every page. Kept deliberately consistent — new UI should look
like it was always there.

- **Pixels are for the UI layer only.** Type, frames, buttons, icons. Character art, the drawing
  canvas and the QR code stay at full resolution, framed but never pixelated.
- **Three faces, each with a job.** Press Start 2P (`--font-arcade`) for the title, room code,
  countdown, clock and scores: wide, so short strings only, and crisp only at multiples of 8px, so
  sized in px. Pixelify Sans (`--font-display`) for buttons, labels, headings. `--font-name` for
  sentences and anything a person typed or the library holds: names need accents and scripts no
  pixel font has, and small pixel type blurs together.
- **Frames are shadows, no radius.** `--frame` is four offset shadows, which leaves the corners
  missing — that is what reads as a pixel corner. Not `clip-path`, which would cut off the focus
  ring. No `border-radius` anywhere but the brush-size dot, which pictures a round brush.
- **A button is a face, a lower edge and a press-down.** That edge *is* the feel. Set `--face` and
  `--deep`, never a background alone (a bare one keeps the default blue edge: Enable Motion came
  out amber-on-blue that way). Small controls set `--px:2px`. They work per element because
  `--frame` is declared on `*`: a custom property holding `var()` resolves where it is declared.
- **Colour is never the only signal.** Choice rows pair a colour with a shape (▲ ◆ ● ■), and chosen
  is a mark inside as well as a heavier frame.
- **3D is decoration, and the game never waits for it** (`shared/fx3d.js`, `shared/voxels.js`). A
  `.fx3d` box has a fixed height and a flat sprite from the start; the renderer loads only after the
  page settles, and if it fails or the device is slow the sprite just stays. No box on any play
  screen, so nothing renders during a game. It never receives a character, and it never reads device
  tilt: iOS asks for motion once per site, and the game needs that answer for itself.
- **Flybys are rare, behind everything, and off the phones during play** (`shared/flybys.js`). One at a time,
  30-90s apart, on a fixed layer at z-index -1 with no pointer events. Nothing runs while the tab is
  hidden, and none fly for reduced motion or under `body.at-play`. Keep them rare: the bar is a nice
  surprise now and then, not something moving in the corner of every turn.
- **Motion is stepped, and all of it sits in one guarded block** (retro.css, *motion*). `steps()`,
  not easing. A screen change slides and never fades: a stalled animation that starts at opacity 0
  leaves the whole game invisible, which is what a hidden page does. A roster is rewritten whole on
  every state push, so anything that pops only for what is new goes through `GTC.isNewSeat`.
- **`GTC.flash` covers the screen, so it has rules** (common.js): one per event, low opacity, at most
  one in 800ms, nothing under reduced motion. Never during the forehead view, which it would show
  over (`main` is its own stacking context). In a game of fast guesses, a miss shakes the box instead.
- **Everything a thumb aims at is 44px.** Grow the control, or where the row has no room (Draw's
  palette holds the canvas on screen) give it a transparent `::before` hit area out to 44px. Both
  live in retro.css under *fingers*.
- **The forehead overlay opts out of all of it.** Black, white, huge, plain. It is read across
  a dim room by other people, not admired up close. Do not decorate it.
- **Sound sits under the room, not over it.** The turn bed runs for a full minute at a time,
  several turns a game, with a party talking through it. The bar is "something you notice
  stopping", not something anyone raises their voice against — and because only the current
  player's phone plays it, the sound is also how the room knows whose head to look at. Anything
  continuous needs an off switch (`gtc_muted`, honoured inside `tone()` so nothing can dodge it).
  The voice is a chip's, pulse and triangle. A pulse is far louder than a sine at the same gain, so an
  unnamed voice is scaled by `PULSE_LEVEL`. Off by default on the computers, where everyone can see
  the screen; on by default on the phones, where the wearer hears the clock or does not know it.
- **The CRT screen is one fixed layer over the page, never a transform of it** (retro.css, *the CRT
  screen*). It lies over the cream panels people read, so it stays faint: raise the scanlines'
  alpha and body text is what pays. Shared CSS names no game's elements: a page sets `data-plain`
  on `<html>` while a display surface is up (the forehead view: it sits in `main`'s stacking
  context, so only `display:none` can clear the glass), and a screen marked `data-play` sets
  `data-playing`, which stills the flicker. Art, drawings and the QR code stay under it alike (the
  QR was decoded through it); lifting only the canvas striped the same drawing in one place and not
  another. Glow goes on dark surfaces only; on cream it is just blur.
- **No emoji in UI copy.** Text-presentation glyphs (✓ ✗ ▲ ‹ › ✕ →) are typography and are
  fine. Anything with Emoji_Presentation (⏭, most pictographs) renders in colour on iOS and
  looks pasted in next to plain-text buttons. The favicon is the one deliberate exception.
- **Escape every interpolated value**, including URLs going into a `src` attribute. The one
  place that lapsed was an image URL, reachable whenever a row falls back to an upstream URL.
- **Every surface colour is a token, because dark mode redefines them.** `--paper`, `--ink`,
  `--soft`, `--input`, `--frame-ink` and the field `--brand` change under
  `:root[data-theme="dark"]`, in `shared/retro.css` and nowhere else; a new rule with a hard-coded
  cream is a bright slab in the dark. The exceptions are deliberate: the forehead overlay (always
  black and white), the QR code (a scanner needs it white), the canvas (paper, so a drawing looks
  the same on every screen) and the high-score table (an arcade screen in both themes).
- **Button labels are Title Case.** Every word capitalised except a, an, the, and, or, but, of,
  to, in, on, at, by, for, as (unless first); no full stops; " — " is the one separator. Rows
  that list characters, lists or categories are content and keep their own case.
- **Publish constants, don't re-declare them.** The client had its own copy of "8" for the
  roster cap while `MAX_PLAYERS` lived in core. Send it in room state instead.

## Web client: CSS traps already hit here

- **`transform: rotate()` displaces a box by `height · sin θ`.** Nothing on a short card,
  ~120px sideways on the compendium's ~20,000px list — it sheared off-screen. The old tilted cards
  are gone, but never rotate anything that can get long. `.flat` still marks the long cards.
- **`:nth-of-type` counts siblings by TAG, not by class.** A non-card div between two cards ate a
  slot and threw off a per-card alternation. Set anything that alternates from JS.
- **A frame sticks out past its box.** Shadows are clipped by any scrolling ancestor, so a scroll
  box holding framed things needs padding of at least `--px` (and three times that underneath).
- **A `--outline` set on a panel is inherited by what is inside it.** The ruling panel's amber
  frame turned its Yes and No buttons amber too. Reset it on the children (`--frame-ink`).
- **Full-bleed by negative margin equal to the container's padding — never viewport units.**
  `left:-50vw; right:-50vw` made the document twice the viewport wide and the whole page
  draggable sideways.
- **`overflow-x: hidden` on `body` alone does not stop iOS panning the document.** Clip the
  root too, and use `clip` rather than `hidden` there: `hidden` creates a scroll container,
  which breaks `position: sticky`.
- **`backdrop-filter` under a `mask-image` is unreliable in WebKit** — it can paint the blur
  unmasked, i.e. exactly the hard edge you were trying to soften. A colour fade alone is safer.
- **Reserve space for async images with a FIXED height, not `max-height`.** `max-height`
  reserves nothing until the image lands, so the card snaps open and shoves whatever is below
  it. Controls that a thumb aims at go *above* anything that can change size.
- **Per-character inline-blocks remove word-boundary line breaking.** `wobble()` (one colour per
  letter now, no angles) wraps each word in a `nowrap` span, or headings break mid-word (a lone "r" on line two).
- **Without `touch-action: manipulation`, two quick taps are a zoom.** That is ordinary use in a
  party game. Decline that one gesture rather than reaching for `user-scalable=no`, which takes
  pinch-zoom away from everyone. Pull-to-refresh needs declining too (`overscroll-behavior-y:
  contain`): a reload is not neutral here, because tilt is off on every fresh page load.
- **`show()` does not run for the screen that is active in the markup.** Anything `show()`
  initialises must also be initialised once at boot, or the first screen anyone sees is the
  odd one out.

## Rules that came from real bugs

**State and protocol**

- *An object existing is not a phase being active.* `room.game` is built during the reroll
  screen with `currentTurnIndex` already 0, so a `game:gotit` that only checked `r.game`
  finished player 0 with zero turns when a phone tilted during setup. Check `status`.
- *Clear per-phase client state on every screen change.* The same bug had a second half: a
  finished game's `lastPlayView` was still lying around for the tilt handler to act on.
- *Always surface the server's error string.* The Rematch button "did nothing" for a whole
  playtest because the client discarded `res.error` — the server had been explaining itself
  the entire time.
- *State taken for one turn must be dropped with that turn.* The disconnect pause freezes the
  current player's clock, and only their return ever cleared it -- so another player leaving
  re-armed the clock while the game still called itself paused, and removing the paused player
  advanced the turn but left a guard armed to rewrite the NEXT player's deadline 30s later. When
  something is taken on behalf of one phase, name what ends it in the same breath as what starts
  it, and give that one owner.
- *A "no-op" result is not the same as an advance.* `forfeit` returns without a `nextPlayerId`
  when the player who left wasn't the guesser. Treating every non-gameover result as an advance
  restarted a turn clock that was still running.
- *An id you publish cannot also be the credential.* The web seat was keyed by the browser's
  own `playerId`, and that same id was in every roster -- so anyone in a room could connect as
  the host, or as the next player on a computer and read their board, which shows your own
  character. The browser's id is now a secret that only rides the handshake; everything
  published uses the public id derived from it (`roomAccess.publicIdOf`). Limits on what a
  stranger can do in bulk are per client address (`rateLimit.js`), never per socket: a new
  socket is free.
- *Behind a TLS-terminating proxy, `req.socket.encrypted` is false.* Trust
  `X-Forwarded-Proto`/`-Host` when present. Getting this wrong made the join QR encode
  `http://`, which silently disabled motion sensors for everyone who scanned it while anyone
  following a pasted link was fine.

**Sensors and devices**

- *Pick the axis from the physical gesture, not the API's default framing.* Tilt first used
  portrait `beta`, which barely moves when a phone is held flat on a forehead — it read as
  "tilt is broken".
- *Absolute thresholds beat calibrated baselines.* Snapshotting a "neutral" reading at turn
  start meant a phone still flat on the table poisoned the baseline and fired gestures
  instantly and repeatedly, burning whole turns.
- *A sensor's sign is a browser convention, not physics.* `accelerationIncludingGravity.z` reads
  face-up as negative on iPhone and positive on Chrome for Android, so "got it" and "pass" were
  swapped for some Android players -- with a manual flip on a screen nobody opened. Prefer
  quantities the platforms agree on (orientation angles), and where you can't, learn the sign
  from something the user does anyway (a tap means the screen faces up) rather than asking.
- *Asymmetric costs deserve asymmetric thresholds.* Tilting up is irreversible and publishes
  your character; tilting down only passes. Up asks for a firmer, longer hold.

**Data and destructive operations**

- *Classify three ways: ok / dead / unknown.* A link checker that treated any non-success as
  dead reported 60 of 66 images as rot; all were HTTP 429. With `--fix` it would have wiped
  ~4,600 working images. Only 404/410 is dead, and a destructive flag must never act on
  "unknown".
- *Dedupe with the same key the judge compares with.* The draw dropped duplicate names using a
  plain lowercase key, so "Spider-Man" and "Spiderman" were two draws from two lists -- and two
  players wore one character. If the judge accepts either spelling as one answer, the pool has to
  treat them as one character. The judge is now `src/compendium/answers.js`, and its
  `identityKeys` are the test: the pool dedupe, the in-play exclusion and the host-picks check all
  use them. **Widen the checker and you widen the dedupe** -- they must move together, which is
  why they live in one file. Measured on the live compendium when they did: the checker accepts no
  character's full name for a different character, and the keys merged 89 of 20,749.
- *Sample what a pattern actually matched before quoting a number or deleting rows.* A regex
  for "credit extras" matched Kay/O, K/DA and AC/DC; the claimed 65 was really 13.
- *Commons throttles by IP, and a party shares one.* That is why `/img/<id>` reads through a
  local disk cache — the server fetches each image once.

**Making something mandatory**

- *A gate needs an override, or it is a deadlock with extra steps.* Requiring a working motion
  sensor before a player could confirm was right; shipping it with no way past was not. The game
  starts only when everyone confirms, so one person on a laptop could hold a room of eight
  forever -- and re-dealing walked into the same wall. Whenever a precondition becomes mandatory,
  ask in the same breath who can proceed without it and how.
- *Do not spend a one-shot permission on the least-informed tap.* iOS prompts for motion once per
  origin, ever. Priming it on "Create a room" -- before a word explains why a party game wants
  the accelerometer -- earned reasonable refusals that later became unplayable. Ask where the
  reason is on screen, and only prime silently on platforms that need no prompt.
- *Count, then name.* "Waiting on 1 more" tells a room of eight nothing they can act on. A name
  tells them whose phone to go and look at.

**Deleting a code path**

- *Inventory what the path was the only renderer of.* Removing the tap fallback also removed the
  only place `outOfContentionNote` was displayed, so a player who could no longer win was never
  told and the game quietly stopped mattering for them. Before deleting a branch, grep every
  field it read; the server keeps computing them and nothing complains.
- *A field with no reader is not automatically dead.* `wearing` renders nowhere, and I proposed
  deleting it -- but `wearing === null` for the guesser is the assertion pinning down the one
  leak that would ruin the game, held by both the unit tests and the socket check. Check who
  asserts on a thing before calling it unused.

**Accessibility**

- *Guard the animation that can hurt before the animation that delights.* Every decorative idle
  animation sat behind `prefers-reduced-motion` while a full-screen 2Hz flash did not -- exactly
  backwards. When adding motion, ask which of these a person with vestibular sensitivity or
  photosensitivity would most want stopped, and guard that one first. Keep a non-moving carrier
  for the same information (here, the clock bar's colour).

**Tooling and self-verification**

- *Never rewrite a file by index/offset splicing.* An index-based splice silently deleted
  everything between two landmarks, including the whole `/img` route. Use exact-match edits.
- *Don't chain shell commands with `&&` when a zero-match is an expected outcome* — `grep`
  exiting 1 short-circuits the rest of the line and the edit never runs, silently.
- *Never report a change you have not made.* "I've added a note about this" was said about a
  file that was never edited. If a fix is worth mentioning, make it in the same turn and check
  it is there -- a stated intention reads to everyone else as a completed change.
- *Verify the edit landed* (grep it back) before reporting it done, especially through
  heredocs where quoting can mangle the payload.

## Comments and docs

Comments here explain **why**, and specifically the constraint that makes the obvious
implementation wrong. That style is load-bearing — keep it — but it rots loudly:

- **Update the module header in the same commit as the feature.** Four files still announced
  "stages 1-2, no turn loop yet" long after the turn loop shipped.
- **A comment naming a specific mechanism must be re-read when that mechanism changes.** One
  cited a `max-height` cap that had become a fixed height; another referenced a `ttBaseline`
  that no longer existed.
- **Treat code contradicting the docs as a defect.** `README`/`docs/mobile-app-plan.md` had
  prefer-images on by default when it ships off, and documented a `/api/qr?text=` parameter
  that had been removed on purpose for security.
