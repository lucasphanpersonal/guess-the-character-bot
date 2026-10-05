# Web app

Guess the Character in a browser, living **side by side** with the Discord bot in the same repo
without tangling into it. Two ways to play, from one server:

- **Phones** (party mode, the site root): Heads Up–style, below. Full design:
  [docs/mobile-app-plan.md](../../docs/mobile-app-plan.md).
- **Computers** (`/desk/`): every screen shows everyone's character except its owner's.
  Questions are asked out loud or over a call; on your turn you type a name. The compendium's
  guess-checker rules: a clear match is "got it", a clear miss costs nothing (no limit), and a
  close one (a typo, a stripped title, a shared surname) goes to the other players — the first
  to tap Yes or No (or press <kbd>Y</kbd>/<kbd>N</kbd>) settles it. Nobody ruling within 20 s
  (`WEB_DESK_RULING_MS`) counts as a miss, and a turn whose clock runs out mid-ruling waits for
  it. No countdown, no motion sensors. Pick-for-each-other and **I'll pick them** work here too:
  the host fills one slot per player (or leaves it on Random) and watches every character and the
  clock while the players rule on close guesses.
  Each player has notes, shown live under their card to everyone (`desk/notes.js`); a note that
  names a character someone is still guessing is refused with the reason, because notes are the
  one thing a player writes that the others read.

And a second game, **Draw the Character** (`/draw/`). Each round, everyone draws once in seat
order: the drawer picks one of three characters (15 s, else the first) — or asks for three new
ones, as often as they like, each with a fresh 15 s and never repeating a face already offered —
then draws it with the character's picture beside the canvas as a reference only they can see;
everyone else types guesses into the chat. The checker judges them with single words
OFF (people guessing at a drawing type what they see — "Combat" is not "Combat Carl"). A wrong
guess is shown to everyone; a close one is told only to whoever typed it; a right one scores
100–400 by how fast it came, and the drawer gets 60 for each person who gets it. Letters of the
name are revealed at half and three-quarter time, never more than a third of them. The turn ends
when everyone has it or the clock runs out, then a short reveal (`WEB_DRAW_REVEAL_SECONDS`, 6 s).
Once you have it — and for the drawer, always — what you type goes only to the others who know.
The host sets rounds (1–5) and drawing time (60–120 s).

**Sound on the computers** (`shared/sound.js`) is a handful of short, quiet cues, never a bed:
everyone can see the screen, so sound is only for the moments worth looking up for — often from
another tab. Guess the Character: your turn starting, a right guess (yours sounds different), and
— for the guesser alone — a miss or a close call; a call to rule goes only to those who can rule.
Draw the Character: your turn to draw, someone getting it, the last ten seconds (once), and the
reveal. Cues queue rather than overlap. **Sound On / Sound Off** sits beside the title on every
screen, play included; the choice is the phones' own `gtc_muted`, one per browser.

**The home page** (`/`) asks one question first: *Phone* or *Computer* (with a hint from
`pointer: coarse` as to which this is). A phone gets the forehead game's create / join, Browse and
Test Tilt; a computer gets create — choosing *Guess the Character* or *Draw the Character* — join,
and Browse, and is handed off to `/desk/` or `/draw/` (`?create=1&name=` or `?room=CODE&name=`,
wiped from the address once acted on). A computer's join box asks `GET /api/room?code=` which game
a code belongs to; it answers with the game's path and nothing else. A room link or a rejoin skips
the question. Dark mode is a small switch in the corner, hidden during play.

Phone play flow: create/join a room by 4-letter code → host picks a pool + difficulty and deals →
everyone checks/rerolls their assigned character and taps **Good to go** → a grace countdown
("phone on your forehead!") → each phone shows its wearer's character full-screen, landscape,
for the room → on your turn, **tilt up = got it, tilt down / time out = pass** → fewest turns
wins (equal turns: most time left when they got it), and the end screen reveals who everyone was.

**Where the characters come from** is one picker, shared by all three clients
(`shared/pickers.js`): *Surprise Me*, *Everything*, or any number of category chips played together
(`poolType: 'categories'`). A chosen category's lists can be switched off for this room under
*Choose Lists*, one at a time or with All / None (`setup:setLists`, all or nothing); a live line
says how many lists and up to how many characters that leaves. The host's last choice is
remembered on that device.

Or pick for each other: **Pick for each other** on the config screen deals nothing. Each player
chooses the character of the player they check — searched, typed, or **Pick at Random** from the
pool — and cannot lock in until they have. Everyone plays. A pick that clashes with a character
the picker can see is refused; one that clashes only with their *own* (hidden) character is
allowed, because refusing it would tell them who they are.

Or the host picks: choosing **I'll pick them** on the config screen lets the host choose each
player's character — searched from the library, or any name typed in — and sit the game out,
watching everyone's characters, the turn and the clock. Anyone left blank is dealt at random
from the pool. Rerolls are off (they would undo the host's choice), and it needs at least two
players besides the host.

## How the repo is split

```
src/
  db/          Opens the SQLite file.
  compendium/  The content: lists, characters, scopes, selections.
  core/        Shared, frontend-agnostic game state.
  discord/     The Discord bot. Imports from core and compendium.
  web/         <- you are here. The web games. Import from core and compendium.
```

`src/web/` itself is split the same way: what every web game shares, and one folder per game.

```
web/
  server.js            HTTP(S) + the one socket.io, static files, /img, browse API, QR, health.
                       Mounts each game.
  content.js           The web's view of the compendium: its scope ('web'), pools, per-room
                       curation, dealing. Games use this, never the compendium directly.
  rooms.js             The room registry -- one for every game, so a code means one room.
  roomAccess.js        Identifying, creating and joining, with the limits on strangers.
  shared/              The computer games' look (theme.css), seasonal switch, client helpers and
                       sound (sound.js), served at /shared/ so /desk/ and /draw/ cannot drift
                       apart. pickers.js (the pool picker and character search) is loaded by the
                       phones too.
  publicCharacter.js   A character as clients see it (artwork through /img).
  imageCache.js        The local read-through artwork cache behind /img.
  guess/               Guess the Character on the web, however it is played.
    gameSetup.js         Dealing and the confirm/reroll screen (pure, unit-tested).
    turnLoop.js          Turns, standings, the clock, results (pure, unit-tested).
    service.js           The setup service both ways of playing drive.
    socket.js            The room/setup/turn protocol, parameterised by a VARIANT.
  party/               Phones: the forehead variant. Served at the site root and on the default
                       socket.io namespace, because the links and QR codes out there point there.
    index.js             The variant: forehead view, a grace countdown, the tilt event.
    view.js              The forehead view -- the one view that carries your OWN character.
    public/              The phone client: index.html, app.js, tilt.js.
  desk/                Computers: the board variant. Served at /desk/, namespace /desk.
    index.js             The variant: board view, no countdown, guess + ruling events.
    guessing.js          Typed guesses and the other players' rulings (pure, unit-tested).
    view.js              The board: everyone's character but yours.
    public/              The computer client.
```

**Two ways of playing one game.** Phones and computers deal, check, take turns and score by
exactly the same rules (`guess/`); a variant supplies only what genuinely differs — what a
player sees, the events that answer a turn, whether there is a countdown. The variant's VIEW is
the dangerous part: the forehead view sends each phone its own character on purpose, and the
same field on a computer would show you your answer. `test/desk.test.js` and the socket check
both search every payload a computer receives for its own character.

Rooms carry a `kind` (`party` / `desk`) and each protocol only joins its own, so a phone can
never be dealt into a game its client cannot draw. One registry still holds them all, so a code
means one room either way.

```
  draw/                Draw the Character -- a different game, sharing nothing of guess/.
    game.js              The rules: choosing, guesses, hints, scoring, rounds (pure, unit-tested).
    socket.js            The protocol and the clock: one timer per room aimed at whatever is due
                         next, a watchdog for sleeping laptops, strokes checked and relayed.
    public/              The drawing client.
```

A different game goes in a folder of its own beside these, with its own client path and
namespace, and gets rooms, pools and images from the shared files above. Anything it would copy
out of a game folder is the signal to move that piece up a level instead -- which is how
`roomAccess.js` and `shared/` came to exist when Draw arrived. Draw's own leak to guard is the
answer reaching a guesser early, through the view, the drawer's choices or an insider's chat
line; `test/draw.test.js` and the socket check search whole payloads for it.

The rule that keeps it clean: **`core/` never imports from `discord/` or `web/`.** Both
frontends depend on the core; the core depends on neither. The codemod that created this split
verified there are no `core -> frontend` requires, and the test suite (`npm test`) still passes
unchanged, which is what proves the Discord bot didn't move logically — only physically.

## What's shared vs. new

- **Reused verbatim:** the content/difficulty/curation logic from `src/compendium/` (the web
  app plays as its own compendium scope, `'web'`, with its own playable selection -- see
  "The compendium" in the top-level README), and the pure game state from core
  (`core/game/Game.js`, `GameManager.js`, `Lobby.js`, `lobbySettings.js`).
- **New here:** the transport (WebSocket rooms instead of Discord's gateway), the UI, and the
  forehead-mode tilt mechanic — none of which the Discord bot has an equivalent of.
- **The seam for a future simultaneous mode:** `core/game/roundMode.js`. Only
  `TurnRotationMode` ships (today's rules); a simultaneous free-for-all plugs in later without
  touching the turn loop.

## Run it

```bash
npm run start:all -- --secure --tunnel   # everything: web + Discord bot + a public URL
npm run web              # HTTP on :4180 — browsing only; tilt (and so play) needs HTTPS
npm run web:secure       # HTTP on :4180 AND HTTPS on :4443 (self-signed) — HTTPS enables tilt
npm run check:web-socket # end-to-end socket check (rooms, setup, countdown, full game -- both ways)
```

The computer version needs no HTTPS (it uses no sensors): `http://<host>:4180/desk/` works.

`start:all` runs both frontends (and optionally a Cloudflare tunnel) in one terminal with
per-process prefixes, and stops them together on Ctrl+C. Flags: `--secure`, `--tunnel`,
`--no-web`, `--no-discord`. A child exiting never takes its siblings down — a bad Discord token
should not close a game in progress.

`--tunnel` prefers the **named** tunnel configured in `~/.cloudflared/config.yml`, so the address
is the same every launch (`https://guess-the-character.com`). With no config it falls back to a
quick tunnel, which mints a throwaway random hostname each time. If cloudflared is already
running that tunnel as a Windows service, `--tunnel` says so and starts nothing — a second
connector for the same tunnel works but doubles the logs and makes "I stopped the tunnel and the
site is still up" a puzzle.

**HTTPS also keeps the screen on.** The Screen Wake Lock API needs a secure context too, and
without it a phone auto-locks mid-game — nobody is touching it once it's on a forehead. Over
plain HTTP the game warns the player to set auto-lock to Never instead.

**Why HTTPS for tilt:** browsers only expose the motion/orientation sensors (`DeviceMotion` /
`DeviceOrientation`, and iOS's `requestPermission`) in a *secure context* — HTTPS or localhost.
A phone hitting `http://<LAN-ip>` is not a secure context, so the sensors are simply unavailable
there. `web:secure` serves HTTPS on `:4443` alongside the plain HTTP on `:4180`, using a cached
self-signed cert (covering localhost + LAN IPs, gitignored under `data/dev-tls.*`).

**Tilt is required to play.** It is the only control surface once a phone is on a forehead, so
readiness is gated on the sensor being live: the setup screen holds back "Good to go" until it
is, and names the actual problem (an insecure link, a device with no sensor, a refused
permission — three different fixes). The host can remove a player who cannot get it working, so
one laptop cannot hold up a room. There is no button fallback: pressing on-screen controls means
holding the phone where you can see it, and it is showing your own character.

**Testing tilt on a phone:** run `npm run web:secure`, open the printed `https://<LAN-ip>:4443`
on the phone, and accept the one-time self-signed-cert warning. Tilt is **always on** — the
first tap (create/join) requests motion access, so on iOS you just grant it when asked; there's
no separate enable step. The landing screen has a **Test tilt** button to calibrate direction
(a "flip" toggle) and sensitivity. Without motion (plain HTTP, or permission refused) the game
still plays fully via on-screen buttons.

Open the page on two phones (or two browser tabs): one taps **Create a room**, the other
enters the 4-letter code (or opens `/?room=CODE`). The roster updates live, offline players
show a grey dot, and closing/reopening a tab reclaims the same seat.

Endpoints that prove the shared core is reachable from this frontend:

- `GET /api/health` — live room count, round modes, and image-cache size.
- `GET /img/<characterId>` — character artwork, served from a local read-through cache
  (`src/web/imageCache.js`). Phones fetch from this server; the server fetches each image from
  its CDN once. That matters because Wikimedia Commons throttles by IP and a party shares one,
  so ~4,600 Real People images could otherwise start failing mid-game. A miss that can't be
  filled redirects upstream, so the cache can never break a game. Cached files live in
  `data/image-cache/` (gitignored, refills itself).
- `GET /api/browse/categories|lists|characters` — the **compendium**: read-only browsing of the
  whole library, category → list → character. Plain HTTP rather than socket events, so it never
  contends with game traffic and the browser can cache it (60s). Ordered the way the game orders
  things — lists by popularity, characters by fame — and paginated, since one list runs to 1,212
  rows. Thumbnails go through `/img/<id>`, so browsing warms the same cache a game uses.

## Stage status

- **1. Rooms + membership — done.** `rooms.js` (transport-agnostic, unit-tested in
  `test/web-rooms.test.js`) + `socket.js` (socket.io wiring) + a mobile lobby client in
  `public/`. Create/join by code, live roster, nickname identity, and seats keyed by a
  persistent client `playerId` so a dropped connection reclaims its seat. Codes are 4 chars
  from an unambiguous alphabet (no O/0, I/1).
- **2. Setup flow — done.** Host picks a pool (random category / everything / a category) and
  difficulty; the server deals via the shared core, then each player gets a confirm/reroll
  screen showing the one character they check (unlimited rerolls, demotion) plus everyone else's as
  reference — never their own. `gameSetup.js` is pure and unit-tested in
  `test/web-setup.test.js`; content is injected so it needs no DB. The pool is the web's own
  compendium scope (`'web'`, or `WEB_SCOPE`), curated with `npm run select:lists`. It used to
  auto-resolve to the richest Discord guild, which meant playing -- and risking writing -- that
  server's selection.
  **Host-picks mode:** `dealWithPicks` validates the host's picks (ids scope-checked, duplicates
  judged with the guess-checker's `identityKeys`) and random-fills the rest; the sitting-out host gets
  `host:state` views, which hold every character and so go to that host alone —
  `check-web-socket` records every event every player receives and asserts none is one.
  Picker search is `GET /api/browse/search?q=`.
- **3. Turn loop — done.** `turnLoop.js` ports the engine.js rules (rotation, fewest-turns
  scoring, pass/give-up, resolve-once, out-of-contention) over the core Game. Server-authoritative
  turn clock; per-player views; reveal/over broadcasts; leaving mid-game forfeits.
- **4. Forehead mode + tilt — done.** A synchronized grace countdown ("phone on your
  forehead!"), then each phone shows its wearer's character full-screen for the room, with a
  turn-start chime + buzz and a bright border on your turn.
  - **Tilt** reads `DeviceMotion.accelerationIncludingGravity.z` (the screen-normal axis, which
    is what tilting up/down changes whether the phone is portrait or landscape): tilt up = Got
    it, tilt down / clock runs out = Pass, debounced, with no on-screen controls during play.
    The two directions are tuned **asymmetrically** (`TILT_TH_UP` 6.5 / `HOLD_UP_MS` 600 vs
    `TILT_TH_DOWN` 5.5 / `HOLD_DOWN_MS` 450 in `party/public/tilt.js`): tilting up is irreversible — it
    ends the turn and publishes the character — and is also what ordinary nodding produces by
    accident, so it asks for a firmer, slightly longer tilt. Direction is calibrated by the
    Test-tilt screen's "flip" toggle, which is persisted.
  - **Always landscape:** the card is CSS-rotated to landscape even under an iOS portrait lock
    (iOS gives web pages no way to unlock orientation). A ▲ TOP bar during the countdown tells
    players which edge is up before they raise the phone, then hides.
  - **Always on:** motion is requested on the first gesture; there's no opt-in button. Falls
    back to on-screen tap buttons when motion is unavailable.
  - **End screen** reveals every player's character alongside the final standings.
- **5. Reconnection hardening — done.** Seats track a *set* of live sockets, so a second tab or
  a reconnect whose new socket arrives before the old one's disconnect never flips a player
  offline. If the **current** player drops, their turn clock **pauses** (everyone sees "waiting
  for X to reconnect") and **resumes** when they return — bounded, so a player who never comes
  back doesn't freeze the game (after 30s the clock resumes and the turn eventually passes). A
  wall-clock **watchdog** re-checks turn/countdown deadlines every 3s so a suspended server
  doesn't hang a turn on wake (mirrors the Discord bot's `timerWatchdog`).
- **6. Polish — in progress.** Done: **rematch** with the same settings (redeal + straight back
  to confirm, no reconfiguring); **QR-code joins** (`GET /api/qr?room=CODE` renders an SVG of the join URL, built
  server-side from the request's own host -- it takes a room code, never arbitrary text); an optional **prefer characters with artwork** toggle on the host's
  config screen (OFF by default -- restricting to image-having characters shrinks the pool and
  biases it toward better-documented franchises, so it is the host's call; via
  `getRandomCharacters(..., { preferImages })`); and light **audio cues** (turn-start chime,
  finish/give-up chime, win sting). Not yet: an optional read-only **scoreboard device**
  (spectator join) and any richer haptics.
