# Guess the Character Bot

A Discord bot that hosts "Guess the Character" (the Hedbanz-style game from The Best in
Jest): two players are each secretly assigned a character they **can't see themselves**, and
take alternating turns asking yes/no questions out loud in voice chat until someone guesses
who they are.

The bot is the impartial host. It deals characters, DMs each player what they need to know,
runs the turn clock, judges guesses, and keeps score — all the actual questions and answers
happen live between humans in voice.

---

## How a game works

1. **Build a character list** once with `/list-create` (tagged with a category, e.g. "Anime"
   or "Video Games") and `/list-add-character`. Or skip this entirely and use the bundled
   seed data — see [Seeding character lists](#seeding-character-lists).
2. **Open a lobby** with `/create-lobby list:<name>` in the channel you'll play from.
   Comma-separate several lists (`list:Pokemon, Anime`) to draw from a combined pool, or use
   `random:true` instead of `list` for 🎲 category roulette.

   This posts the **lobby board** — a single message with **Join / Leave / Spectate / Start
   game** buttons that updates itself in place as people join. Everything below can be done
   by clicking it; the equivalent slash commands still work and keep the board in sync.
3. **Two people join.** The host doesn't have to be one of them. Anyone else can spectate to
   get both characters DMed to them — and anyone already sitting in the same voice channel
   as the players is auto-added as a spectator. **Start game** stays disabled until exactly
   two players have joined.
4. **Optionally `/set-characters`** (host only) to hand-pick each player's character instead
   of leaving it to chance. The confirmation is ephemeral, so it can't spoil anything even
   though you type it in the shared channel.
5. **Hit Start game** on the board (host only; `/start-game` does the same). Each player
   gets a DM showing the *other* player's character — that's what they'll use to answer
   questions — along with the show or film it's from, since a name on its own is often
   ambiguous (there's a Ditto in Pokémon *and* Ben 10, an Ed in Ed Edd n Eddy *and* Cowboy
   Bebop). Spectators and the final reveal show the same. The DM carries **Good to go** /
   **Reroll** buttons: either player can reroll a character they don't recognize (or think
   the wearer won't). Turn 1 doesn't begin until both confirm.

   In **audience-vote mode** (see below) this is preceded by a voting round, and the DM has
   no Reroll button — the crowd already decided.
6. **On your turn**, a **turn board** appears — one message with a live countdown bar, a
   running tally of your guesses, and **Guess / Pass** buttons. Ask your questions out loud,
   then hit **Guess** (which opens a text box) as often as you like: **a wrong guess does
   _not_ end your turn**. Only **Pass**, or running out of time, hands it over — and when
   the clock hits zero the board turns amber for one final guess rather than ending
   outright. `/guess` and `/pass` still work if you prefer typing.
7. **Winning:** the first correct guess wins — unless it was the player who moved first that
   round, in which case the other player gets one rebuttal turn to even it up (correct on
   rebuttal = tie, wrong = the first player wins). The reveal comes with **Rematch** and
   **Leaderboard** buttons.

`/status` shows whose turn it is and the time left. `/end-game` cancels a stuck game (host
or a server admin). After a game, `/rematch` replays it with the same two players (turn
order swapped) and `/leaderboard` shows the standings.

One lobby/game can be active **per channel** — different channels in the same server can run
their own games concurrently.

### Guess matching

Guesses don't have to be exact. The bot accepts:

- **Case and punctuation differences** — `kaisa` matches `Kai'Sa`.
- **Missing accents** — `Flabebe` matches `Flabébé`, `Pokemon` matches `Pokémon`.
- **Small typos**, scaled to name length (none for names ≤4 characters, 1 edit for 5–7,
  2 edits for 8+).
- **A single well-known word** of a multi-word name — `Shikamaru` matches `Shikamaru Nara`.
  Trivial words (`the`, `of`, `a`, …) don't count on their own.

### Audience-vote mode

Add `audience-vote:true` to `/create-lobby` and the audience decides what both players are
wearing, instead of the bot dealing at random.

A vote board appears with a **Vote** button. Clicking it opens a **private ballot** listing
candidates for each player; you pick one per player and can change your mind until voting
closes. Voting ends on a timer (`vote-seconds`, default 60) or when the host closes it
early, then the plurality winner for each player is locked in — ties break randomly, and if
nobody votes at all a random candidate is used, so the game can never stall.

**The two players can't vote and are never shown the candidates.** The public board only
ever shows the turnout and a countdown — never a character name — because seeing five
options for your own head would collapse the game from a thousand possibilities to five.
`vote-options` (default 5, max 25) sets how many candidates each player gets; the combined
character pool needs at least `vote-options × 2` distinct characters, since the two players
get disjoint sets.

### Sound effects

If both players are in the same voice channel when the game starts, the bot joins and plays
a countdown chime at decreasing intervals, plus stings for correct guesses, wrong guesses,
and the final win. Otherwise everything falls back to the text countdown. The sounds are
short tones synthesized by `npm run generate:sounds` — no audio files are downloaded.

---

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | anyone | Rules and command summary |
| `/list-create` | anyone | Create a character list, tagged with a category |
| `/list-add-character` | anyone | Add a character, optionally with an image URL |
| `/list-set-image` | anyone | Attach/update a character's image |
| `/list-remove-character` | anyone | Remove a character |
| `/list-show` | anyone | Browse categories, lists in a category, or one list's characters |
| `/create-lobby` | anyone | Open a lobby + post the lobby board (`list`, or `random:true`; plus `turn-seconds`, `max-rerolls`, `audience-vote`, `vote-options`, `vote-seconds`) |
| `/join-lobby` / `/leave-lobby` | players | Join or leave the waiting lobby (or use the board's buttons) |
| `/spectate` | anyone | Opt in to a DM revealing both characters (or use the board's button) |
| `/set-characters` | host | Hand-pick both players' characters |
| `/start-game` | host | Deal characters and begin |
| `/guess` / `/pass` | current player | Guess (any time, wrong is free) or end your turn (or use the turn board's buttons) |
| `/status` | anyone | Whose turn, time remaining |
| `/end-game` | host/admin | Cancel a stuck lobby or game |
| `/rematch` | anyone | Replay the last finished game, turn order swapped (or use the reveal's button) |
| `/leaderboard` | anyone | Server standings, or one player's record |

List and character name options have autocomplete — worth leaning on, since the bundled seed
data creates over a thousand lists.

---

## Setup

1. Create an application and bot user at the
   [Discord Developer Portal](https://discord.com/developers/applications). You need:
   - **Bot → Token** (a long value containing two dots — *not* the dot-free "Public Key" on
     the General Information page, which is a different thing entirely).
   - **General Information → Application ID.**

   Invite it with the `bot` and `applications.commands` scopes plus **View Channel**,
   **Send Messages**, **Connect**, and **Speak** (the last two let it join voice to play
   sounds). No privileged intents are required.

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
   ```

   (`3148800` = View Channel 1024 + Send Messages 2048 + Connect 1048576 + Speak 2097152.)

2. Install and configure:

   ```bash
   npm install
   cp .env.example .env    # then fill in DISCORD_TOKEN and CLIENT_ID
   ```

   Set `GUILD_ID` in `.env` to your server's ID while developing — guild-scoped command
   registration is instant, whereas global registration can take up to an hour to propagate.
   (Enable Developer Mode in Discord, then right-click the server icon → Copy Server ID.)

3. Register the slash commands and start the bot:

   ```bash
   npm run deploy-commands
   npm start
   ```

   Re-run `deploy-commands` whenever you add or change a command's name, description, or
   options. The bot must be running for anything to respond; `Ctrl+C` shuts it down cleanly
   (closing voice connections and checkpointing the database).

---

## Seeding character lists

Four bundled importers, all idempotent — re-running only adds what's missing, so they're
safe to run repeatedly.

```bash
npm run seed:pokemon  -- <your-server-id>   # 1,025 Pokémon, with official artwork
npm run seed:lol      -- <your-server-id>   # 173 League of Legends champions, with splash art
npm run seed:wikidata -- <your-server-id>   # Western TV/film casts, one list per show
npm run seed:anilist  -- <your-server-id>   # anime/manga casts, one list per title
```

> **The Character Codex was removed.** It was the original bulk source and a poor fit: it
> carried categories nobody plays with (Blogs, Magazines, Scientific Papers, Research
> Journals), filed authors as characters (Eiichiro Oda under One Piece), and duplicated
> characters under several spellings — One Piece arrived with four Luffys and three
> Choppers, but no Zoro, Nami, Sanji or Usopp. The Wikidata and AniList importers cover the
> same ground with real casts. Use `npm run reset:seeded -- <server-id>` to clear
> seed-created lists before rebuilding from these sources.

- **`seed:pokemon`** and **`seed:lol`** each create a single list, with images pulled from
  the games' own public asset APIs (PokeAPI's sprite repo and Riot's Data Dragon).
- **`seed:anilist`** builds one list per anime/manga title from
  [AniList](https://anilist.co), with artwork on nearly every character. Casts are complete
  rather than sampled — One Piece imports 815 characters. AniList stores names
  first-name-first ("Luffy Monkey"), so they're rebuilt surname-first to give
  "Monkey D. Luffy", "Roronoa Zoro", "Nico Robin".

  AniList files each season separately, so titles differing only by a season or part marker
  are **merged** — otherwise a lobby offers "Attack on Titan" four times. The merge is
  conservative: "Steins;Gate 0" and "Mob Psycho 100" keep their numbers.

  Characters labelled `BACKGROUND` by AniList are skipped (`--include-background` to keep
  them), as is anything flagged adult. `--per-show N` caps each title.
- **`seed:wikidata`** covers Western TV and film, which AniList doesn't touch. It
  builds **one list per show or film** from [Wikidata](https://www.wikidata.org), sweeping
  Cartoon Network, Nickelodeon, Disney Channel/XD, Adult Swim, Fox, the Disney/Pixar/
  DreamWorks film catalogues, and HBO/AMC/Netflix drama.

  Each show is capped at its **30 best-known characters** (`--per-show N` to change it),
  ranked by how many language Wikipedias cover them. The cap is per show rather than a
  single global fame threshold on purpose: every Ed Edd n Eddy character has *zero*
  Wikipedia articles — the whole cast lives on one shared page — so a global cutoff would
  delete Ed, Edd, Eddy, Rolf and Plank while keeping dozens of minor SpongeBob relatives.
  Fame only compares meaningfully within a show. Production bookkeeping ("Incidental 29")
  and self-answering descriptions ("Sandy's cousin") are dropped either way.

  Restrict it with `--group kids-tv|adult-animation|animation-studios|live-action-tv`, and
  preview without writing using `--dry-run`. Wikidata only carries freely-licensed images,
  which rules out most cartoon art, so a lot of these arrive text-only.

Anything still without an image reveals as plain text, which is a supported look — use
`/list-set-image` to fill in any you care about.

`seed:pokemon` and `seed:lol` take an optional list name as a second argument. Combine
anything at game time: `/create-lobby list:Naruto, Scrubs`.

<details>
<summary>Refreshing the AniList and Wikidata caches</summary>

`seed:anilist` reads a committed `data/seed/anilist-characters.json`, so seeding never
touches the network. To rebuild it from AniList:

```bash
npm run fetch:anilist
```

It walks the most popular titles rather than searching by name (AniList's fuzzy search
answers "Demon Slayer" with a game called *Onigiri*), then pages every character of every
title it takes. AniList rate-limits hard, so a full run takes a couple of hours; it's
resumable, and records which titles are fully paged so a re-run only costs the one in
flight. `--pages N` sets the depth and `--type ANIME|MANGA` restricts it.

Likewise `seed:wikidata` reads a committed `data/seed/wikidata-characters.json`. To rebuild
it from Wikidata (a long run — tens of minutes, and the public endpoint rate-limits):

```bash
npm run fetch:wikidata
```

It discovers shows by broadcaster and production company rather than from a hand-written
list, so a cartoon nobody thought to add still lands. It's resumable — the output file
doubles as the progress log, so `Ctrl+C` and re-run only costs the chunk in flight — and it
splits a query in half whenever the endpoint times out, which is what lets a 300-character
series like The Simpsons through without failing the 23 ordinary shows sharing its request.
Add `--group <key>` to sweep one source group, or `--list-groups` to see them.
</details>

---

## Project layout

```
src/
  index.js              Client bootstrap, interaction routing, graceful shutdown
  deploy-commands.js    Registers slash commands (run manually)
  commands/             One file per slash command; each exports { data, execute, autocomplete? }
    lists/              Character-list management commands
  components/
    router.js           Routes button/select/modal events by customId namespace
    lobbyButtons.js     Lobby board button handlers
    turnControls.js     Turn board buttons + the guess modal
    voteControls.js     Audience ballot + host close button
    gameOverControls.js Rematch / Leaderboard buttons on the reveal
  game/
    GameManager.js      Map<channelId, Lobby> — one lobby per channel
    Lobby.js            Pre-game state: host, players, spectators, settings
    Game.js             Active-game state + guess matching
    engine.js           Turn loop, DMs, confirm/reroll, win/rebuttal resolution
    lobbyBoard.js       Renders the self-updating lobby message
    turnBoard.js        Renders the self-updating turn message
    audienceVote.js     Audience-vote state, ballots, tallying (spoiler-safe board)
    rematch.js          Builds a rematch lobby from a finished one
    turnTimer.js        Turn countdown wrapper
    timerWatchdog.js    Wall-clock backstop for turn/vote deadlines (sleep-safe)
    boards.js           Tracks live button messages and retires them after a restart
    voice.js            Voice-channel join + sound playback (all best-effort)
  db/
    connection.js       SQLite setup + lightweight column migrations
    schema.sql          character_lists, characters, game_results, active_boards
    activeBoards.js     Which board messages are live right now
    characterLists.js   List/character queries, random selection, search
    stats.js            Win/loss records and leaderboard
  util/text.js          Shared accent/case normalization
scripts/                One-off seed and sound-generation scripts
test/                   Test suite (npm test)
data/
  bot.sqlite            Created on first run (gitignored)
  seed/                 Committed source data for the seed scripts
  sounds/               Generated WAVs (npm run generate:sounds)
```

**State:** character lists and game results are persisted in SQLite. Active lobby and game
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

---

## Development

```bash
npm test                 # 115 tests, no network or Discord needed
npm run generate:sounds  # regenerate the WAV sound effects
```

Tests run against a temporary throwaway database (via the `BOT_DB_PATH` environment
variable), so they never read or modify `data/bot.sqlite`. They cover guess matching,
list/character queries, the lobby/turn/game-over boards with their buttons and modal,
audience-vote mode (including a guard that the public board never leaks a candidate), and
the full game flow —
confirm/reroll, turn rules, the rebuttal/tie/win outcomes, concurrent lobbies, and rematch —
using fake Discord objects. The restart sweep and the wall-clock timer watchdog are covered
too: the harness hands back fetchable fake messages, so the sweep is driven end to end.

Add a test file as `test/<name>.test.js` exporting named functions; the runner picks it up
automatically.

### Adding an interactive control

Buttons and select menus are namespaced by the first segment of their `customId`
(`lobby:join:<channelId>`). Register the namespace once in `src/components/router.js` and
give it a handler module — no new branch in `src/index.js` is needed. Two rules worth
remembering:

- **Acknowledge within 3 seconds.** If the handler does slow work (sending DMs, starting a
  game), call `deferUpdate()`/`deferReply()` *first*, then do the work, then `followUp()`.
- **Buttons on a shared message can be clicked by anyone**, so each handler authorizes the
  clicking user itself — the lobby board's Start button checks the host, for example.
