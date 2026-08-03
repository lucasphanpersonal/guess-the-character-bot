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

1. **Build a character list** once with `/list create` (tagged with a category, e.g. "Anime"
   or "Video Games") and `/list add`. Or skip this entirely and use the bundled
   seed data — see [Seeding character lists](#seeding-character-lists).
2. **Open a lobby** with `/lobby create` in the channel you'll play from. Bare, it rolls a
   random category. The `from:` option picks what to draw from — one autocompleted field
   offering 🎲 random, 🌍 everything, 🗂️ any category, or 📋 list names (comma-separate to
   combine several).

   Picking a category from `from:` pools every enabled list in it, which naming lists
   individually can't do: Discord caps an option value at 100 characters. The bundled seed
   data fills six categories: Anime, Manga, Video Games, Cartoon, Television Shows and
   Movies.

   The four options this replaces (`list`, `category`, `everything`, `random`) were mutually
   exclusive, which Discord can't express — so the command advertised no required options and
   then rejected both giving none and giving two. One field makes exclusivity structural, and
   makes the modes discoverable: they now appear in the picker instead of being buried at
   option four.

   This posts the **lobby board** — a single message with **Join / Leave / Spectate / Start
   game** buttons that updates itself in place as people join. Everything below can be done
   by clicking it; the equivalent slash commands still work and keep the board in sync.

   The host also gets **⚙️ Settings** and a **🗳️ Audience vote: on/off** toggle on the board,
   so turn length, rerolls and the vote tuning can all be changed after the lobby is open —
   nothing has to be decided up front on the `/lobby create` line. Settings lock once the
   game starts.
3. **Two people join.** The host doesn't have to be one of them. Anyone else can spectate to
   get both characters DMed to them — and anyone already sitting in the same voice channel
   as the players is auto-added as a spectator. **Start game** stays disabled until exactly
   two players have joined.
4. **Optionally `/lobby set-characters`** (host only) to hand-pick each player's character instead
   of leaving it to chance. The confirmation is ephemeral, so it can't spoil anything even
   though you type it in the shared channel.
5. **Hit Start game** on the board (host only; `/lobby start` does the same). Each player
   gets a DM showing the *other* player's character — that's what they'll use to answer
   questions — along with the show or film it's from, since a name on its own is often
   ambiguous (there's a Ditto in Pokémon *and* Ben 10, an Ed in Ed Edd n Eddy *and* Cowboy
   Bebop). Spectators and the final reveal show the same. The DM carries **Good to go** /
   **Reroll** buttons: either player can reroll a character they don't recognize (or think
   the wearer won't). Turn 1 doesn't begin until both confirm.

   In **audience-vote mode** (see below) this is preceded by a voting round, and the DM has
   no Reroll button — the crowd already decided.
6. **On your turn**, a **turn board** appears — one message with a live countdown bar, the
   standings so far, and two rows of buttons, one per player:

   - **The other player judges.** They can see your character, so when you say a name out
     loud they hit **✅ They got it** or **❌ Nope**. That's how a turn resolves, because
     guesses get called out in voice and never reach a bot that only sees typing.
   - **You get ⏭️ Pass**, and nothing else. There is deliberately no way to submit a written
     guess: the judge's ✅ already answers *was that right?*, and a second control for the
     same question would mean two authorities on it.

   **A wrong guess does _not_ end your turn**, and costs you nothing at all — it isn't
   counted anywhere. Only **Pass**, or running out of time, hands the turn over, and when
   the clock hits zero the board turns amber for one final guess rather than ending outright.
   `/pass` also works as a command.

   The board's **Standings** field is the score: who has got theirs and on which turn.

   #### Why the other player does the clicking

   The person guessing is thinking, talking, and racing a clock. The person listening has
   nothing to do and already knows the answer — in the physical game they're the judge
   anyway. Asking the busy player to report their own guesses meant most guesses never
   reached the bot at all, which is half the reason nothing is scored on them any more.
   Moving the input to the idle player also retires fuzzy matching from that path entirely —
   a human deciding whether "Shikamaru" counts beats Levenshtein deciding it.
7. **Winning: fewest turns.** Getting your character doesn't end the game — it ends *your*
   involvement. Your character is revealed then and there, you drop out of the rotation, and
   everyone else plays on until they get theirs. The player who needed the fewest turns wins,
   and an equal count is a tie with no tiebreaker. The reveal comes with **Rematch** and
   **Leaderboard** buttons.

   Once you're the last player still guessing there's nobody to pass to, so **⏭️ Pass**
   becomes **🏳️ Give up** — relabelled and red, rather than quietly changing meaning under
   someone who's been passing all game out of habit. It's the only way to end a game early.

   #### Why turns, and not guesses

   Scoring on turns is what lets the game run to a natural end for everybody instead of
   stopping the moment one person gets lucky. It's also the only score the bot can *observe*:
   it hands the turns out itself. The wrong-guess count it used to keep depended on a judge
   remembering to press ❌, so it undercounted — and undercounted worst for the players
   conscientious enough to click.

   It also retired a rule. The bot used to stop at the first correct guess and hand the other
   player a "rebuttal" turn if the first mover won, because otherwise they'd won on a turn
   their opponent never had. Racing your own turn count makes going first worth nothing, so
   the exception is gone and rematches no longer swap the seating.

`/lobby status` shows whose turn it is, the time left, and who's already finished. `/lobby end`
cancels a stuck game (host or a server admin). After a game, `/rematch` replays it with the
same players and `/leaderboard` shows the standings.

One lobby/game can be active **per channel** — different channels in the same server can run
their own games concurrently.

### Who decides a guess is right

The player who *can see* your character. There is no text matching anywhere in the game:
guesses are called out in voice, and the other player hits **✅ They got it** or **❌ Nope**.

That's the same thing a human does at a real table, and it beats what the bot used to do —
normalise, fold accents, and allow a Levenshtein distance scaled to name length. All of that
existed only to compensate for the bot judging something it couldn't hear. A person deciding
whether "Shikamaru" counts for "Shikamaru Nara" needs no algorithm.

The consequence is that the bot never learns what was guessed — so it doesn't count guesses at
all, and remembering that you already tried Levi is the other player's job.


### Difficulty: how obscure a character you'll be dealt

Curating lists can't fix being handed somebody nobody recognises, because the obscurity is
*inside* the list. Attack on Titan is on everyone's shortlist and its cast still runs from
Eren (36,038 favourites) down to bit parts with three. So difficulty cuts each **cast** by
fame rather than cutting the list:

| | Keeps | Attack on Titan yields |
| --- | --- | --- |
| **Easy** | best-known quarter of each cast | 38 — Levi, Eren, Mikasa, Armin, Hange… |
| **Normal** (default) | skips the deepest cuts | 91 |
| **Everything** | every character | 151 — down to Abel and Dennis Aiblinger |

Set it with `/lobby create difficulty:` or the **🎚️ Difficulty** button on the lobby board,
which cycles and tells you the resulting pool size. It's a per-lobby setting on purpose:
the list selection says which franchises this server likes, difficulty says how deep tonight's
players want to go, and those change on different schedules.

The cut is applied **per list**, which matters because the two fame scales are incomparable
(AniList favourites in the thousands, Wikipedia sitelinks in the tens). A pool-wide threshold
would quietly delete every Wikidata-sourced character. Per-list also gives the better rule:
keep the leads of every show, rather than every character of the best-documented shows. A
list with no fame data passes through untouched — unranked is not the same as unpopular.

### Character images, and which ones can be believed

Anime and Manga characters carry AniList art — drawn from the work, per character, 100%
coverage. Everything else came from Wikidata, whose image property is not "a picture of this
character" but "an image associated with this item", which for a fictional character
routinely resolves to the actor, a cosplayer, a wax figure, or a period illustration:

| Character | Wikidata gave us |
| --- | --- |
| Jack Bauer | Kiefer Sutherland at a premiere |
| Cruella de Vil | a Flickr convention photo |
| Woody | a Toy Story Land mascot, photographed |
| Santa Claus | an 1837 painting |

The rule (`src/util/characterImages.js`) is about **medium**, not about guessing which files
are bad: for live action a photo of the actor genuinely is the character's canonical look, so
it stays; for animation and games no photograph can be right, so Commons images are dropped
there outright. It costs some legitimate Commons-hosted game art, which is the accepted price
of having no false positives — and a missing image costs little, while a wrong one actively
misleads whoever is answering questions.

The seeder applies it going forward. For a database seeded before it existed:

```bash
node scripts/clean-character-images.js <guildId> --dry-run
```

### Rerolls teach the pool

Two things happen when somebody rerolls, both aimed at making the next game better than the
last:

**The bot remembers.** Once `REROLL_DEMOTE_THRESHOLD` (3) *different* people have rerolled
the same character, it stops being dealt. Rows are per (character, user), so one person
rerolling the same unlucky draw twice isn't mistaken for a consensus, and deleting from
`character_rerolls` undoes it completely.

**🚫 Never deal this show** sits next to Reroll on the confirmation DM. It drops that list
from the server's selection *and* rerolls, in one press — the alternative is rerolling now
and remembering to curate later, which nobody does. It costs a reroll (because it is one),
refuses if dropping would leave the lobby nothing to deal from, and `/list toggle` undoes it.

### Choosing which lists you play with

The seed data runs to ~2,000 lists, and most of them are obscure enough that being dealt one
is a wasted turn — the reroll button was doing the job a filter should. `/list select` is
that filter: a page of checkboxes (multi-select menus, 75 per page) covering every list,
with a running count of what's on.

**Setup enables the top 100 of each category**, so a server starts with a sensible pool
rather than an empty one. That happens in `npm run backfill:popularity`, which ranks lists
by fame and then switches on the best-known 100 per category (`--top=N` to move the line,
`--no-enable` to rank without touching the selection). The ranking reads the seed files —
AniList audience size for Anime and Manga, summed Wikipedia sitelinks across the cast for
everything else. Unranked lists sort last and still work.

From there curation is exceptions, and there are three ways to do it, in rough order of how
often you'll want them:

| | Best for |
| --- | --- |
| `/list toggle <list>` | One list in or out. Autocomplete finds it in three keystrokes and shows ✅/⬜ for its current state. |
| `/list select top:<n>` | Moving the cut line wholesale — `top:200` for every category, or with `category:` for one. **Exact**: anything below the line is switched off. |
| `/list select` | The checkbox page, for browsing and bulk work. Sorted best-known first, 75 checkboxes a page, with Enable/Disable page and Disable all. |

The page is the fallback, not the main event: once the default is sensible, hunting a single
show across six pages is worse than naming it.

The selection governs **pooled draws only** — `category`, `everything` and `random`. Naming a
list outright (`/lobby create list:Naruto`) always works, enabled or not, because asking for
one by name is already a deliberate choice. Lists made by hand with `/list create` are
enabled on creation for the same reason.

### Audience-vote mode

Add `audience-vote:true` to `/lobby create` — or hit the **🗳️ Audience vote** toggle on the
lobby board — and the audience decides what both players are wearing, instead of the bot
dealing at random.

A vote board appears with a **Vote** button. Clicking it opens a **private ballot** listing
candidates for each player; you pick one per player and can change your mind until voting
closes — the ballot confirms each change, so a second pick visibly replaces the first rather
than looking like it stacked. Voting ends on a timer (`vote-seconds`, default 90), when the
host closes it early, or later if the host presses **⏱️ +30s** (presses accumulate). Then
the plurality winner for each player is locked in — ties break randomly, and if nobody votes
at all a random candidate is used, so the game can never stall.

The public board reports the **shape** of each tally — "unanimous so far", "5 votes across 3
characters — leader has 2", "currently tied" — which is the drama of a vote without any of
its content. The full breakdown, with names, waits for the end-of-game reveal, where it's
finally safe to show: *"unanimous, 4 of 7"*, or *"tied on 2, settled by coin flip"*.

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
| `/list create` | anyone | Create a character list, tagged with a category |
| `/list add` | anyone | Add a character, optionally with an image URL |
| `/list image` | anyone | Attach/update a character's image |
| `/list remove` | anyone | Remove a character |
| `/list show` | anyone | Browse categories, lists in a category, or one list's characters |
| `/list select` | anyone | Tick which lists the server plays with; `top:<n>` re-cuts to the N best-known |
| `/list toggle` | anyone | Switch one named list in or out of the pool |
| `/lobby create` | anyone | Open a lobby + post the lobby board (`from` picks the pool; plus `difficulty`, `turn-seconds`, `max-rerolls`, `audience-vote`, `vote-options`, `vote-seconds` — all editable afterwards from the board) |
| `/lobby join` / `/lobby leave` | players | Join or leave the waiting lobby (or use the board's buttons) |
| `/lobby spectate` | anyone | Opt in to a DM revealing both characters (or use the board's button) |
| `/lobby set-characters` | host | Hand-pick both players' characters |
| `/lobby start` | host | Deal characters and begin |
| `/pass` | current player | End your turn (or use the turn board's button) |
| `/lobby status` | anyone | Whose turn, time remaining, who has already finished |
| `/lobby end` | host/admin | Cancel a stuck lobby or game |
| `/rematch` | anyone | Replay the last finished game with the same players (or use the reveal's button) |
| `/leaderboard` | anyone | Server standings, or one player's record |

List and character name options have autocomplete — worth leaning on, since the bundled seed
data creates over two thousand lists.

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
npm run seed:wikidata -- <your-server-id>   # Western TV/film/game casts, one list per title
npm run seed:anilist  -- <your-server-id>   # anime/manga casts, one list per title
```

> **The Character Codex was removed.** It was the original bulk source and a poor fit: it
> carried categories nobody plays with (Blogs, Magazines, Scientific Papers, Research
> Journals), filed authors as characters (Eiichiro Oda under One Piece), and duplicated
> characters under several spellings — One Piece arrived with four Luffys and three
> Choppers, but no Zoro, Nami, Sanji or Usopp. The Wikidata and AniList importers cover the
> same ground with real casts. Use `npm run reset:seeded -- <server-id>` to clear
> seed-created lists before rebuilding from these sources.

- **`seed:pokemon`** and **`seed:lol`** each create a single list under **Video Games**, with
  images pulled from the games' own public asset APIs (PokeAPI's sprite repo and Riot's Data
  Dragon).
- **`seed:anilist`** builds one list per anime/manga title from
  [AniList](https://anilist.co), with artwork on nearly every character. AniList stores names
  first-name-first ("Luffy Monkey"), so they're rebuilt surname-first to give
  "Monkey D. Luffy", "Roronoa Zoro", "Nico Robin".

  AniList files each season separately, so titles differing only by a season or part marker
  are **merged** — otherwise a lobby offers "Attack on Titan" four times. The merge is
  conservative: "Steins;Gate 0" and "Mob Psycho 100" keep their numbers.

  Characters labelled `BACKGROUND` by AniList are skipped (`--include-background` to keep
  them), as is anything flagged adult.

  Each title is then cut to the characters people have actually heard of. AniList records a
  **favourites** count per character, and the cut is *relative to each show's own best-known
  member*: keep anyone with at least 2% of the top character's favourites, cap 30. A flat
  rank cut can't work here, because fame falls off at completely different rates —

  | | #1 | #10 | #30 |
  | --- | --- | --- | --- |
  | One Piece | 36,038 | 5,815 | 1,486 |
  | Cowboy Bebop | 14,830 | 75 | 3 |

  so "top 30" means Silvers Rayleigh in one show and a walk-on three people have heard of in
  the other. The relative floor gives One Piece its full 30 and Cowboy Bebop the six people
  who are actually in Cowboy Bebop. `MAIN` characters are kept whatever their favourites (the
  show's own billing outranks a popularity vote), and a title that would be trimmed below
  three keeps its top three rather than disappearing.

  This takes the anime import from 26,778 characters to 7,930, median cast 22 → 8. Tune it
  with `--fame-floor PERCENT` — `1` is looser (9,522), `3` stricter (7,048), `0` turns the
  floor off and leaves only the cap (16,293) — and with `--per-show N`.
- **`seed:wikidata`** covers Western TV, film and video games, which AniList doesn't touch.
  It builds **one list per show, film or game** from [Wikidata](https://www.wikidata.org),
  sweeping Cartoon Network, Nickelodeon, Disney Channel/XD, Adult Swim, Fox, the
  Disney/Pixar/DreamWorks film catalogues, HBO/AMC/Netflix drama, and every title Wikidata
  types as a video game — roughly 1,100 playable lists in total.

  Each title is capped at its **30 best-known characters** (`--per-show N` to change it),
  ranked by how many language Wikipedias cover them. The cap is per title rather than a
  single global fame threshold on purpose: every Ed Edd n Eddy character has *zero*
  Wikipedia articles — the whole cast lives on one shared page — so a global cutoff would
  delete Ed, Edd, Eddy, Rolf and Plank while keeping dozens of minor SpongeBob relatives.
  Fame only compares meaningfully within a show. Production bookkeeping ("Incidental 29")
  and self-answering descriptions ("Sandy's cousin") are dropped either way.

  Games are found by *being* games rather than by publisher. A hand-written list of 34 major
  studios was the original approach and it reached 670 titles; asking Wikidata for "anything
  typed as a video game with a character" sweeps 6,400 candidates, of which 3,100 turn out to
  have a cast. Indie and older titles stop depending on whether their studio was famous
  enough for someone to think of.

  Animated shows are filed under **Cartoon** and live action under **Television Shows**, so
  "any TV show" can't hand you SpongeBob when you wanted Breaking Bad. The split comes from
  Wikidata's own typing of each series, not from the broadcaster that found it — Fox and
  Adult Swim both carry live action, so grouping by source would have filed Firefly as a
  cartoon. Anime is dropped here rather than categorised, since AniList already supplies it
  with better names, images and ranking.

  Restrict it with
  `--group kids-tv|adult-animation|animation-studios|live-action-tv|video-games`, and preview
  without writing using `--dry-run`. Wikidata only carries freely-licensed images, which rules
  out most cartoon art, so a lot of these arrive text-only.

Anything still without an image reveals as plain text, which is a supported look — use
`/list image` to fill in any you care about.

`seed:pokemon` and `seed:lol` take an optional list name as a second argument. Combine
anything at game time: `/lobby create list:Naruto, Scrubs`.

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

It discovers shows by broadcaster and production company — and games by being games — rather
than from a hand-written list, so a cartoon or an indie title nobody thought to add still
lands. It's resumable — the output file doubles as the progress log, so `Ctrl+C` and re-run
only costs the chunk in flight — and it splits a query in half whenever the endpoint times
out, which is what lets a 300-character series like The Simpsons through without failing the
23 ordinary shows sharing its request.
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
    lobbyButtons.js     Lobby board button handlers + the settings modal
    turnControls.js     Turn board buttons + the guess modal
    voteControls.js     Audience ballot + host close button
    gameOverControls.js Rematch / Leaderboard buttons on the reveal
    listBrowser.js      Paginated category/list/character browsing for /list show
    listFilter.js       Checkbox page for the server's playable list selection
  game/
    GameManager.js      Map<channelId, Lobby> — one lobby per channel
    Lobby.js            Pre-game state: host, players, spectators, settings
    lobbySettings.js    Bounds/parsing shared by /lobby create and the settings modal
    Game.js             Active-game state: turn counts, who has finished, standings
    engine.js           Turn loop, DMs, confirm/reroll, completion and final scoring
    lobbyBoard.js       Renders the self-updating lobby message
    turnBoard.js        Renders the self-updating turn message
    audienceVote.js     Audience-vote state, ballots, tallying (spoiler-safe board)
    rematch.js          Builds a rematch lobby from a finished one
    turnTimer.js        Turn countdown wrapper
    timerWatchdog.js    Wall-clock backstop for turn/vote deadlines (sleep-safe)
    boards.js           Tracks live button messages and retires them after a restart
    voice.js            Voice-channel join + sound playback (all best-effort)
  util/
    characterImages.js  Which image sources can be believed to depict the character
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
npm test                 # 132 tests, no network or Discord needed
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

### Adding an interactive control

Buttons and select menus are namespaced by the first segment of their `customId`
(`lobby:join:<channelId>`). Register the namespace once in `src/components/router.js` and
give it a handler module — no new branch in `src/index.js` is needed. Two rules worth
remembering:

- **Acknowledge within 3 seconds.** If the handler does slow work (sending DMs, starting a
  game), call `deferUpdate()`/`deferReply()` *first*, then do the work, then `followUp()`.
- **Buttons on a shared message can be clicked by anyone**, so each handler authorizes the
  clicking user itself — the lobby board's Start button checks the host, for example.
