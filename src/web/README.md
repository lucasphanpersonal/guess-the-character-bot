# Web app (party mode) — skeleton

The phone-in-hand, Heads Up–style frontend, living **side by side** with the Discord bot in
the same repo without tangling into it. Full design: [docs/mobile-app-plan.md](../../docs/mobile-app-plan.md).

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
npm run web              # then open http://localhost:4180
npm run check:web-socket # end-to-end socket check (create/join/reconnect/host handoff)
```

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
  screen showing the one character they check (reroll budget, demotion) plus everyone else's as
  reference — never their own. `gameSetup.js` is pure and unit-tested in
  `test/web-setup.test.js`; content is injected so it needs no DB. `WEB_SCOPE` auto-resolves to
  the richest seeded scope so a phone test deals real characters immediately.
- **3. Turn loop** ported behind `core/game/roundMode.js` (tap-to-confirm placeholder for tilt).
  _next_
- **4. Forehead mode** + tilt gestures + iOS motion permission.
- **5. Reconnection hardening** — wall-clock-anchored turn timers, resume mid-turn.
- **6. Polish** — audio/haptic cues, standings, rematch, optional scoreboard view, QR codes.
