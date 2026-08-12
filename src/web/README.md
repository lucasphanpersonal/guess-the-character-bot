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
npm run web        # then open http://localhost:4180
```

Dependency-free skeleton (Node's built-in `http`, no socket.io yet). It serves a placeholder
page and two endpoints that prove the core is reachable from this frontend:

- `GET /api/health` — live room count + which round modes are wired.
- `GET /api/categories` — categories from the shared content DB (scoped by `WEB_SCOPE`,
  default `web`; empty until lists are curated under that scope).

## Not done yet (next stages, in order)

1. WebSocket rooms, join by code/QR, nickname identity.
2. Setup flow: list/difficulty picking, confirm/reroll screen.
3. Turn loop ported behind `roundMode.js` (tap-to-confirm placeholder for tilt).
4. Forehead mode + tilt gestures + iOS motion permission.
5. Reconnection (session tokens, wall-clock-anchored timers).
6. Polish: audio/haptic cues, standings, rematch, optional scoreboard view.
