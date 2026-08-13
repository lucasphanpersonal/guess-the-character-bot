# Web app (party mode)

The phone-in-hand, Heads Up–style frontend, living **side by side** with the Discord bot in
the same repo without tangling into it. Full design: [docs/mobile-app-plan.md](../../docs/mobile-app-plan.md).

Play flow: create/join a room by 4-letter code → host picks a pool + difficulty and deals →
everyone checks/rerolls their assigned character and taps **Good to go** → a grace countdown
("phone on your forehead!") → each phone shows its wearer's character full-screen, landscape,
for the room → on your turn, **tilt up = got it, tilt down / time out = pass** → fewest turns
wins, and the end screen reveals who everyone was.

## How the repo is split

```
src/
  core/      Shared, frontend-agnostic. db + content pipeline + pure game state.
  discord/   The Discord bot. Imports from core.
  web/        <- you are here. The web app. Imports from core.
```

The rule that keeps it clean: **`core/` never imports from `discord/` or `web/`.** Both
frontends depend on the core; the core depends on neither. The codemod that created this split
verified there are no `core -> frontend` requires, and the test suite (`npm test`) still passes
unchanged, which is what proves the Discord bot didn't move logically — only physically.

## What's shared vs. new

- **Reused verbatim from core:** the SQLite layer (`core/db`), the content/difficulty/curation
  logic, and the pure game state (`core/game/Game.js`, `GameManager.js`, `Lobby.js`,
  `lobbySettings.js`).
- **New here:** the transport (WebSocket rooms instead of Discord's gateway), the UI, and the
  forehead-mode tilt mechanic — none of which the Discord bot has an equivalent of.
- **The seam for a future simultaneous mode:** `core/game/roundMode.js`. Only
  `TurnRotationMode` ships (today's rules); a simultaneous free-for-all plugs in later without
  touching the turn loop.

## Run it

```bash
npm run web              # HTTP on :4180 — tap fallback only (tilt sensors need HTTPS)
npm run web:secure       # HTTP on :4180 AND HTTPS on :4443 (self-signed) — HTTPS enables tilt
npm run check:web-socket # end-to-end socket check (rooms, setup, countdown, full game)
```

**Why HTTPS for tilt:** browsers only expose the motion/orientation sensors (`DeviceMotion` /
`DeviceOrientation`, and iOS's `requestPermission`) in a *secure context* — HTTPS or localhost.
A phone hitting `http://<LAN-ip>` is not a secure context, so the sensors are simply unavailable
there. `web:secure` serves HTTPS on `:4443` alongside the plain HTTP on `:4180`, using a cached
self-signed cert (covering localhost + LAN IPs, gitignored under `data/dev-tls.*`).

**Testing tilt on a phone:** run `npm run web:secure`, open the printed `https://<LAN-ip>:4443`
on the phone, and accept the one-time self-signed-cert warning. Tilt is **always on** — the
first tap (create/join) requests motion access, so on iOS you just grant it when asked; there's
no separate enable step. The landing screen has a **📱 Test tilt** button to calibrate direction
(a "flip" toggle) and sensitivity. Without motion (plain HTTP, or permission refused) the game
still plays fully via on-screen buttons.

Open the page on two phones (or two browser tabs): one taps **Create a room**, the other
enters the 4-letter code (or opens `/?room=CODE`). The roster updates live, offline players
show a grey dot, and closing/reopening a tab reclaims the same seat.

Endpoints that prove the shared core is reachable from this frontend:

- `GET /api/health` — live room count + which round modes are wired.
- `GET /api/categories` — categories from the shared content DB (scoped by `WEB_SCOPE`,
  default `web`; empty until lists are curated under that scope).

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
  `test/web-setup.test.js`; content is injected so it needs no DB. `WEB_SCOPE` auto-resolves to
  the richest seeded scope so a phone test deals real characters immediately.
- **3. Turn loop — done.** `turnLoop.js` ports the engine.js rules (rotation, fewest-turns
  scoring, pass/give-up, resolve-once, out-of-contention) over the core Game. Server-authoritative
  turn clock; per-player views; reveal/over broadcasts; leaving mid-game forfeits.
- **4. Forehead mode + tilt — done.** A synchronized grace countdown ("phone on your
  forehead!"), then each phone shows its wearer's character full-screen for the room, with a
  turn-start chime + buzz and a bright border on your turn.
  - **Tilt** reads `DeviceMotion.accelerationIncludingGravity.z` (the screen-normal axis, which
    is what tilting up/down changes whether the phone is portrait or landscape): tilt up = Got
    it, tilt down / clock runs out = Pass, held ~450ms and debounced. No on-screen controls
    during play. Thresholds (`TILT_TH` / `TILT_HOLD_MS` in `public/app.js`) and direction (the
    Test-tilt "flip", persisted) still want in-person tuning.
  - **Always landscape:** the card is CSS-rotated to landscape even under an iOS portrait lock
    (iOS gives web pages no way to unlock orientation). A ▲ TOP bar during the countdown tells
    players which edge is up before they raise the phone, then hides.
  - **Always on:** motion is requested on the first gesture; there's no opt-in button. Falls
    back to on-screen tap buttons when motion is unavailable.
  - **End screen** reveals every player's character alongside the final standings.
- **5. Reconnection hardening** — wall-clock-anchored turn timers, resume mid-turn. _next_
- **6. Polish** — richer audio/haptic cues, rematch with same settings, scoreboard view, QR
  codes, preferring characters that have artwork.
