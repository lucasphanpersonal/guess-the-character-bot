# Architecture

How the repo is laid out, where state lives, and how to work on it. The rules that keep it
that way -- and the bugs that taught them -- are in [CLAUDE.md](../CLAUDE.md).

---

## Project layout

The repo holds **two frontends over one shared core, on top of one compendium**. The layers,
bottom up — each imports only from the ones below it:

- `db/` opens the one SQLite file, and nothing more.
- `compendium/` is the content: every list and character, the scopes that see them, and each
  scope's playable selection ([The compendium](compendium.md#the-compendium-shared-lists-and-scopes)). It
  owns its own tables and knows nothing about games.
- `core/` is the game: rules, turn counts, standings, and the records of finished games.
  Discord-agnostic and frontend-agnostic.
- `discord/` is this bot; `web/` is the party-mode web app
  ([docs/mobile-app-plan.md](mobile-app-plan.md)).

The two rules that keep them untangled: **`core/` never imports from `discord/` or `web/`**,
and **nothing above the compendium queries its tables directly** — content goes through
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

  core/                 Shared, frontend-agnostic. Imports compendium/, never discord/ or web/.
    db/
      connection.js       The game layer's tables, after the compendium's
      schema.sql          games, game_players, active_boards
      activeBoards.js     Which board messages are live right now
      stats.js            Win/loss records and leaderboard
    game/
      GameManager.js      Map<roomKey, Lobby> — one lobby per channel (Discord) / room (web)
      Lobby.js            Pre-game state: host, players, spectators, settings
      lobbySettings.js    Bounds/parsing shared by /lobby create and the settings modal
      Game.js             Active-game state: turn counts, who has finished, standings
      turnRules.js        The turn rules both frontends run: rotation, resolve-once, pass /
                          give up / leave, which controls apply

  discord/              The Discord bot. Imports from core/.
    index.js              Client bootstrap, interaction routing, graceful shutdown
    deploy-commands.js    Registers slash commands (run manually)
    commands/             One file per slash command; each exports { data, execute, autocomplete? }
      actions/            Subcommand implementations for /list and /lobby
    components/
      router.js           Routes button/select/modal events by customId namespace
      lobbyButtons.js     Lobby board button handlers + the settings modal
      turnControls.js     Turn board buttons + the ✅ and Give up confirmations
      voteControls.js     Audience ballot + host close button
      gameOverControls.js Rematch / Leaderboard buttons on the reveal
      listBrowser.js      Paginated category/list/character browsing for /list show
      listFilter.js       Checkbox page for the server's playable list selection
    game/
      engine.js           Turn loop, DMs, confirm/reroll, completion and final scoring
      confirmPhase.js     Confirm/reroll DM flow
      characterDM.js      Composes every message that shows a character
      lobbyBoard.js       Renders the self-updating lobby message
      turnBoard.js        Renders the self-updating turn message
      audienceVote.js     Audience-vote state, ballots, tallying (spoiler-safe board)
      lobbyPool.js        Resolves the `from:` pool selection
      rematch.js          Builds a rematch lobby from a finished one
      turnTimer.js        Turn countdown wrapper
      timerWatchdog.js    Wall-clock backstop for turn/vote deadlines (sleep-safe)
      boards.js           Tracks live button messages and retires them after a restart
      voice.js            Voice-channel join + sound playback (all best-effort)
    util/
      permissions.js      Manage-Server permission checks

  web/                 The web games. Imports from core/ and compendium/. See web/README.md.
    server.js             HTTP(S) + socket.io, static files, /img, browse API, QR; mounts each game
    content.js            The web's view of the compendium (scope 'web', pools, curation, dealing)
    rooms.js, roomAccess.js, publicCharacter.js, imageCache.js   Shared by every web game
    shared/               The computer games' common look and client helpers, at /shared/
    guess/                Guess the Character on the web, however it is played
      gameSetup.js, turnLoop.js   Dealing/confirm and the turn rules (pure, unit-tested)
      service.js, socket.js       The setup service and the room/turn protocol, per variant
    party/                Phones: forehead view, tilt, countdown. At the site root
    desk/                 Computers: board view, typed guesses, rulings. At /desk/
    draw/                 Draw the Character: rules (game.js), protocol + clock (socket.js). At /draw/

scripts/                Content tools (seeding, image fills, select-lists), sounds, the browser
  lib/compendiumArgs.js   Shared argument handling (drops a legacy leading server id)
test/                   Test suite (npm test)
data/
  bot.sqlite            Created on first run (gitignored)
  seed/                 Committed source data for the seed scripts
  sounds/               Generated WAVs (npm run generate:sounds)
```

**State:** the compendium (lists, characters, rerolls, each scope's selection) and game results
are persisted in SQLite, in one file with two owners — `src/compendium/schema.sql` and
`src/core/db/schema.sql`. Active lobby and game
state is deliberately in-memory only — a game in progress does not survive a bot restart.

**Restarts.** Because the game state is gone but its messages aren't, the *messages* are
tracked: `active_boards` holds the channel id, message id and kind of every board currently
carrying buttons (lobby, turn, vote, reveal, and the confirm DMs). A board is untracked the
moment it loses its buttons in normal play, so the table only ever holds live ones. On
startup the bot retires whatever is left: buttons stripped, a short "the bot restarted" note
added, embeds untouched. The reveal keeps its **Leaderboard** button, which reads from SQLite
and never needed the lobby. The same sweep runs on a clean shutdown so boards go quiet
immediately, but the startup pass is the one that matters — a crash or force-kill skips
shutdown entirely, and the rows are still there on the next boot.

**Sleep.** Turn timers, countdown checkpoints and the vote auto-close are `setTimeout`s, and
a sleeping machine doesn't run them. `timerWatchdog.js` re-checks every 5 seconds against the
wall clock and expires anything already past due, so a turn that ran out while the machine
was asleep ends on wake instead of hanging (or firing a burst of stale countdown edits). It's
a backstop: in the normal case the `setTimeout` fires first and the pass finds nothing.

## Development

```bash
npm test                 # the unit suite, no network or Discord needed
npm run generate:sounds  # regenerate the WAV sound effects
```

Tests run against a temporary throwaway database (via the `BOT_DB_PATH` environment
variable), so they never read or modify `data/bot.sqlite`. They cover guess matching,
list/character queries, the lobby/turn/game-over boards with their buttons and modal,
audience-vote mode (including a guard that the public board never leaks a candidate), and
the full game flow —
confirm/reroll, turn rules, turn-count scoring and its tie/win/give-up outcomes, concurrent
lobbies, and rematch —
using fake Discord objects. The restart sweep and the wall-clock timer watchdog are covered
too: the harness hands back fetchable fake messages, so the sweep is driven end to end.

Add a test file as `test/<name>.test.js` exporting named functions; the runner picks it up
automatically.
