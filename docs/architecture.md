# Architecture

How the repo is laid out, where state lives, and how to work on it. The rules that keep it
that way -- and the bugs that taught them -- are in [CLAUDE.md](../CLAUDE.md).

---

## Project layout

The repo holds **the web games over one shared core, on top of one compendium**. The layers,
bottom up — each imports only from the ones below it:

- `db/` opens the one SQLite file, and nothing more.
- `compendium/` is the content: every list and character, the scopes that see them, and each
  scope's playable selection ([The compendium](compendium.md#the-compendium-shared-lists-and-scopes)). It
  owns its own tables and knows nothing about games.
- `core/` is the game: rules, turn counts, standings. Frontend-agnostic.
- `web/` is the web games -- Guess the Character on phones and on computers (*Who Am I?* on the
  site), and Draw the Character (*Doodle Dash*) ([src/web/README.md](../src/web/README.md); the
  phones' design: [docs/mobile-app-plan.md](mobile-app-plan.md)).

The project also had a Discord bot until November 2026. It was removed so the site is the one
way to play; its game records and its servers' list selections are still in the database.

The two rules that keep the layers untangled: **`core/` never imports from `web/`**, and
**nothing above the compendium queries its tables directly** — content goes through
`src/compendium/characterLists.js`. (The content scripts in `scripts/` are the compendium's
own maintenance tools, and may.)

```
src/
  db/
    connection.js         Opens data/bot.sqlite (or BOT_DB_PATH); applies no schema itself

  compendium/           The content. Imports only db/.
    db.js                 Applies schema.sql + migrates older layouts (guild-scoped lists -> scopes)
    schema.sql            character_lists, characters, character_rerolls, list_selection
    characterLists.js     Scopes, selections, list/character queries, random dealing, search
    answers.js            The guess-checker (correct / close / wrong) and the keys the pool dedupes by
    characterImages.js    Which image sources can be believed to depict the character
    text.js               Shared accent/case normalization

  core/                 Shared, frontend-agnostic. Imports compendium/, never web/.
    db/
      connection.js       The game layer's tables, after the compendium's
      schema.sql          games, game_players: finished games the Discord bot recorded. Nothing
                          writes them now; the content scripts keep their character ids right
    game/
      Game.js             Active-game state: turn counts, who has finished, standings
      turnRules.js        The turn rules: rotation, resolve-once, pass / give up / leave, which
                          controls apply
      seating.js          Each game's order, at random and unlike the last (who goes first,
                          who checks whom)
      limits.js           MAX_PLAYERS and the turn-length bounds, published to every client

  web/                 The web games. Imports from core/ and compendium/. See web/README.md.
    server.js             HTTP(S) + socket.io, static files, /img, browse API, QR; mounts each game
    content.js            The web's view of the compendium (scope 'web', pools, curation, dealing)
    rooms.js, roomAccess.js, publicCharacter.js, imageCache.js   Shared by every web game
    shared/               The common look and client helpers, at /shared/ (the phones load some too)
    guess/                Guess the Character on the web, however it is played
      gameSetup.js, turnLoop.js   Dealing/confirm and the turn rules (pure, unit-tested)
      service.js, socket.js       The setup service and the room/turn protocol, per variant
    party/                Phones: forehead view, tilt, countdown. At the site root
    desk/                 Computers: board view, typed guesses, rulings. At /desk/
    draw/                 Draw the Character: rules (game.js), Telephone (telephone.js), end screen (gallery.js), protocol + clock (socket.js). At /draw/

scripts/                Content tools (seeding, image fills, select-lists), the browser, the launcher
  lib/compendiumArgs.js   Shared argument handling (drops a legacy leading server id)
test/                   Test suite (npm test)
data/
  bot.sqlite            Created on first run (gitignored). The name is historical
  seed/                 Committed source data for the seed scripts
```

**State:** the compendium (lists, characters, rerolls, each scope's selection) is persisted in
SQLite, in one file with two owners — `src/compendium/schema.sql` and `src/core/db/schema.sql`
(the Discord bot's old game records). Rooms and games are deliberately in-memory only — a game
in progress does not survive a server restart.

**Sleep.** Turn clocks are `setTimeout`s, and a sleeping machine doesn't run them. Each game's
socket layer re-checks its deadlines against the wall clock every few seconds, so a turn that
ran out while the machine was asleep ends on wake instead of hanging. It's a backstop: in the
normal case the `setTimeout` fires first and the pass finds nothing.

## Development

```bash
npm test                  # the unit suite, no network needed
npm run check:web-socket  # boots the real web server and plays full games over sockets
```

Tests run against a temporary throwaway database (via the `BOT_DB_PATH` environment
variable), so they never read or modify `data/bot.sqlite`. They cover guess matching,
list/character queries and scopes, dealing and the confirm/reroll rules, the turn rules,
turn-count scoring and its tie/win/give-up outcomes, the web rooms and their protocol, and
Draw the Character.

Add a test file as `test/<name>.test.js` exporting named functions; the runner picks it up
automatically.
