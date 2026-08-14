# Working notes for Claude

Conventions and hard-won rules for this repo. README.md is the reference; this file is the
part that is easy to get wrong twice. Every rule below is here because something broke.

## Shape of the repo

```
src/core/     Shared, frontend-agnostic: db + content pipeline + pure game state.
src/discord/  The Discord bot.
src/web/      The party-mode web app (phones, forehead mode, tilt).
```

**`core/` never imports from `discord/` or `web/`.** Both frontends depend on the core; the
core depends on neither. This is the one invariant that keeps two frontends from fusing.

Anything shared between them lives in core and is changed with *both* callers in mind. The
`enabled` column on a list is the clearest trap: it is the Discord bot's playable pool, so a
web host unticking a list must never write to it. Per-room exclusion sets exist for exactly
that reason (`Room.excludedListIds`).

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
- **The web client is unversioned.** `index.html` and `app.js` keep their URLs forever, so a
  browser can serve you a stale copy while you test a fix. Navigate with a cache-buster
  (`/?cb=2`) when verifying. The server sends `Cache-Control: no-cache` for html/js/css so
  players don't hit this; your test tab still can.
- **A check that only works once is not a check.** `check-web-socket` used to die on the
  second run against its own leftover seed DB. Make fixtures idempotent.
- **Run a check several times before believing it.** The same script failed one run in seven
  because an assertion kept its own hand-written copy of the fixture's cast list, and the
  fixture had grown a character. Derive expectations from the fixture, never restate them --
  and when something is random (a deal, a shuffle), a single green run proves little.
- **Never leave a detached server running.** Each `nohup`/background restart of the launcher
  *adds* a stack rather than replacing one. Four accumulated over one session: one held :4180
  so the user's own launcher could not bind, and three extra Discord bots stayed logged in, so
  every slash command was handled four times. Before starting a server, kill whatever holds the
  port; when finished, kill what you started. `netstat -ano | grep ':4180.*LISTENING'` names the
  holder, and `Get-Process node,cloudflared` shows the rest.
- **Bind address and dial address must agree.** The server binds `0.0.0.0`, which is IPv4 only,
  while `localhost` resolves to `::1` first on Windows. Point local clients (the tunnel) at
  `127.0.0.1` explicitly. The failure reads "the target machine actively refused it", which
  blames the server for being down rather than the address for being wrong.
- **Assert positively.** A test that only asserts a 404 passes even when the route is deleted,
  because the static handler 404s too. That is how a deleted `/img` route once shipped green.

## Web client: the design language

Game-show look: saturated violet field, white slabs, four paired colours. Kept deliberately
consistent — new UI should look like it was always there.

- **Chunky tactile buttons.** Hard bottom shadow (`box-shadow: 0 6px 0 …`) plus a press-down
  on `:active`. That shadow *is* the feel; a flat button reads as a different app.
- **Colour is never the only signal.** Choice rows pair a colour with a shape (▲ ◆ ● ■).
- **Hand-set type.** `wobble()` gives big headings a per-character angle; cards sit at faint
  alternating angles. Body copy stays plain — the whimsy is decoration on the large type only.
- **The forehead overlay opts out of all of it.** Black, white, huge, plain. It is read across
  a dim room by other people, not admired up close. Do not decorate it.
- **No emoji in UI copy.** Text-presentation glyphs (✓ ✗ ▲ ‹ › ✕ →) are typography and are
  fine. Anything with Emoji_Presentation (⏭, most pictographs) renders in colour on iOS and
  looks pasted in next to plain-text buttons. The favicon is the one deliberate exception.
- **Escape every interpolated value**, including URLs going into a `src` attribute. The one
  place that lapsed was an image URL, reachable whenever a row falls back to an upstream URL.
- **Publish constants, don't re-declare them.** The client had its own copy of "8" for the
  roster cap while `MAX_PLAYERS` lived in core. Send it in room state instead.

## Web client: CSS traps already hit here

- **`transform: rotate()` displaces a box by `height · sin θ`.** Nothing on a short card,
  ~120px sideways on the compendium's ~20,000px list — it sheared off-screen. Long-scrolling
  cards must carry `.flat` to opt out of the decorative tilt.
- **`:nth-of-type` counts siblings by TAG, not by class.** A non-card div between two cards
  ate a slot and left both neighbours leaning the same way. The alternation is set per card by
  `retilt()` in JS for this reason.
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
- **Per-character inline-blocks remove word-boundary line breaking.** `wobble()` wraps each
  word in a `nowrap` span, or headings break mid-word (a lone "r" on line two).
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
- *Asymmetric costs deserve asymmetric thresholds.* Tilting up is irreversible and publishes
  your character; tilting down only passes. Up asks for a firmer, longer hold.

**Data and destructive operations**

- *Classify three ways: ok / dead / unknown.* A link checker that treated any non-success as
  dead reported 60 of 66 images as rot; all were HTTP 429. With `--fix` it would have wiped
  ~4,600 working images. Only 404/410 is dead, and a destructive flag must never act on
  "unknown".
- *Sample what a pattern actually matched before quoting a number or deleting rows.* A regex
  for "credit extras" matched Kay/O, K/DA and AC/DC; the claimed 65 was really 13.
- *Commons throttles by IP, and a party shares one.* That is why `/img/<id>` reads through a
  local disk cache — the server fetches each image once.

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
