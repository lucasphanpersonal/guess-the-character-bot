# Playing on Discord

How the bot runs a game, the rules it enforces, and how to set it up. The content it deals
from -- lists, difficulty, seeding -- is [the compendium](compendium.md); how the code is laid
out is [the architecture](architecture.md).

---

## How a game works

1. **Build a character list** once with `/list create` (tagged with a category, e.g. "Anime"
   or "Video Games") and `/list add`. Or skip this entirely and use the bundled
   seed data — see [Seeding character lists](compendium.md#seeding-character-lists).
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
3. **People join.** Two is the minimum and eight is the maximum. The host doesn't have to be
   one of them. Anyone else can spectate to get every character DMed to them, and anyone
   already sitting in the same voice channel as the players is auto-added as a spectator.
   **Start game** unlocks at two.

   The eight-player cap keeps the roster and boards within Discord's message limits.
   Hand-picking characters remains a smaller host-only surface: a modal holds five inputs, so
   it is available only through five players. Spectator/reference DMs split when necessary,
   and audience ballots page from six players onward.
4. **Optionally hand-pick characters** (host only) instead of leaving every player to chance,
   for up to 5. Two ways to do it, and both let you assign as few or as many players as you
   want — leave the rest to chance:

   - **`/lobby set-characters`** has real autocomplete on every character field, because
     that's a feature of slash-command options that Discord does not extend to modals. It's
     also incremental rather than all-at-once: each call only touches the players you name in
     it, so you can assign one player now and another later without re-typing the first, and
     naming a player with no character clears just that one back to random.
   - **The board's 🎭 Set characters** button opens a modal instead — one box per joined
     player, pre-filled with whatever's already assigned. No autocomplete (Discord can't do
     that inside a modal), so a name has to match exactly; leave a box blank to deal that
     player at random.

   Either way the confirmation is ephemeral, so it can't spoil anything even though you typed
   it in the shared channel.
5. **Hit Start game** on the board (host only; `/lobby start` does the same). Each player gets
   **two DMs**: the character they're *checking*, with the buttons beside it, and a
   component-free list of everyone else's, so they can answer questions about them. Between
   them that's every character but their own. Each comes with the show or film it's from,
   since a name alone is often ambiguous (there's a Ditto in Pokémon *and* Ben 10, an Ed in
   Ed Edd n Eddy *and* Cowboy Bebop).

   It's two messages because Discord renders buttons after *every* embed — in one message the
   controls would sit below a stack of cards with nothing saying which one they act on.

   **You check exactly one character: the next player's, round the rotation.** So every
   character has one person who may reroll it, and at two players that's each other, exactly
   as before. One checker each is what stops two people rejecting the same character at once,
   and stops one player's unfamiliarity overriding everyone who was happy with it. A reroll
   re-renders the copy every *other* player is holding, since characters are shared rather
   than per-viewer. Turn 1 doesn't begin until everyone confirms.

   **Good to go isn't final.** A locked-in player keeps an **↩️ Unlock** button and can go
   back to rerolling right up until the last person is in — the pressure to decide comes from
   everyone waiting, not from the button being a one-way door. The moment play begins those
   buttons are stripped, because an Unlock on a running game would be a lie; the DM stays as
   your reference for the character you'll be answering questions about all game.

   In **audience-vote mode** (see below) this is preceded by a voting round, and the DM has
   no Reroll button — the crowd already decided.
6. **On your turn**, a **turn board** appears — one message with a live countdown bar, the
   standings so far, and two rows of buttons, one per player. It mentions you in the message
   itself rather than only inside the embed, because Discord doesn't send a notification for
   an embed mention, and with several players there can be minutes between your turns:

   - **Everyone else judges.** They can all see your character, so when you say a name out
     loud whoever is paying attention hits **✅ They got it** or **❌ Nope** — first press
     decides. That's how a turn resolves, because guesses get called out in voice and never
     reach a bot that only sees typing. Players who've already finished keep judging: they
     were told every character at the start, so they stay useful instead of becoming
     spectators.

     **✅ asks to confirm; ❌ doesn't.** The two sit side by side and only one is reversible —
     a stray ❌ costs nothing, while a stray ✅ ends the turn *and* publishes the character
     you're wearing, which no undo can retract once you've seen it. ✅ lands once per player
     per game, so the extra tap is cheap where it matters.
   - **You get ⏭️ Pass**, and nothing else. There is deliberately no way to submit a written
     guess: the judge's ✅ already answers *was that right?*, and a second control for the
     same question would mean two authorities on it.

   **A wrong guess does _not_ end your turn**, and costs you nothing at all — it isn't
   counted anywhere. Only **Pass**, or running out of time, hands the turn over, and when
   the clock hits zero the board turns amber for one final guess rather than ending outright.
   `/pass` also works as a command.

   The board's **Standings** field is the score: who has got theirs and on which turn.

   Each turn posts a fresh board and **deletes the one before it**, so the channel holds
   exactly one and it's always at the bottom. A board per turn is fine for a short two-player
   game and becomes a wall of dead greys at five. What survives a game is the completion
   messages and the final result — the parts worth scrolling back to.

   The board also carries **👁 Spectate**, for anyone who wandered in after the game started.
   It's here rather than only on the lobby board because the lobby board loses its buttons the
   moment play begins and is buried up the channel by turn three — this is the one message
   reliably at the bottom. Its audience is exactly the people the other buttons refuse.

   #### Why everyone else does the clicking

   The person guessing is thinking, talking, and racing a clock. Everyone listening has
   nothing to do and already knows the answer — in the physical game they're the judges
   anyway. Asking the busy player to report their own guesses meant most guesses never
   reached the bot at all, which is half the reason nothing is scored on them any more.
   Moving the input to the idle player also retires fuzzy matching from that path entirely —
   a human deciding whether "Shikamaru" counts beats Levenshtein deciding it.
7. **Winning: fewest turns.** Getting your character doesn't end the game — it ends *your*
   involvement. Your character is revealed then and there, you drop out of the rotation, and
   everyone else plays on until they get theirs. The player who needed the fewest turns wins.
   An equal count goes to whoever had more time left on the turn they got it (every earlier
   turn cost the full clock, since a pass counts as the whole turn), and only players level
   to the second too are tied. Both frontends score this way; it lives in `Game.standings()`.

   The end-of-game message carries **Rematch** and **Leaderboard** buttons, and shows only the
   characters *nobody* saw yet — in practice the one belonging to the last player, who gave up
   rather than being told. Everyone who finished, and anyone who left mid-game, had theirs
   revealed at the time, and printing them again put the same name and artwork in the channel
   twice running.

   Nobody is removed for going quiet: a turn that runs out just passes. But a game where
   *everyone* has gone quiet (two full rounds of turns timing out with nobody pressing
   anything) ends itself, as `/lobby end` would. Anyone who already finished keeps that result.

   **⏭️ Pass** always just hands the turn on, and never removes you — even once you can no
   longer win, so you can play on for placement (or wait the game out) instead of being pushed
   out. **🏳️ Give up** is a separate red button that bows you out: it drops you from the
   rotation and reveals what you were wearing right then, since you never got to work it out. It
   shows up once bowing out is a sensible option — when you're **out of contention for the win**
   (you get both Pass and Give up then), or when you're the **last** player still guessing (just
   Give up, since there's nobody to pass to, and here it ends the game).

   **`/lobby leave` also works mid-game**, and is the way out for anyone still in contention who
   nonetheless has to go: same result as Give up — no turn count, recorded as having given up,
   character revealed as you go — but reachable off-turn too. It asks first, since it can't be
   undone. Everyone else plays on — one person having to go shouldn't end a six-player game, and
   until now the host cancelling it for everybody was the only way out.

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

## Who decides a guess is right

The player who *can see* your character. There is no text matching anywhere in the bot (or on
the phones): guesses are called out in voice, and the other player hits **✅ They got it** or
**❌ Nope**. Only the computer games, where guesses are typed, have a checker -- see
[Checking a typed guess](compendium.md#checking-a-typed-guess).

That's the same thing a human does at a real table, and it beats what the bot used to do —
normalise, fold accents, and allow a Levenshtein distance scaled to name length. All of that
existed only to compensate for the bot judging something it couldn't hear. A person deciding
whether "Shikamaru" counts for "Shikamaru Nara" needs no algorithm.

The consequence is that the bot never learns what was guessed — so it doesn't count guesses at
all, and remembering that you already tried Levi is the other player's job.

## Audience-vote mode

Add `audience-vote:true` to `/lobby create` — or hit the **🗳️ Audience vote** toggle on the
lobby board — and the audience decides what every player is wearing, instead of the bot
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

**Players can't vote and are never shown the candidates.** The public board only
ever shows the turnout and a countdown — never a character name — because seeing five
options for your own head would collapse the game from a thousand possibilities to five.
`vote-options` (default 5, max 25) sets how many candidates each player gets; the combined
character pool needs at least `vote-options × players` distinct characters, since every
player gets a disjoint set.

**The ballot pages for six to eight players.** It needs one select menu per player and Discord
allows five action rows per message, so past five the fifth row becomes Prev/Next and four
players ride on each page — with a running "X of Y players picked" count, since a single page
can no longer show you whether you are done. Five or fewer renders exactly as it always did.

## Sound effects

If the players share a voice channel when the game starts, the bot joins and plays
a countdown chime at decreasing intervals, plus stings for correct guesses, wrong guesses,
and the final win. Otherwise everything falls back to the text countdown. The sounds are
short tones synthesized by `npm run generate:sounds` — no audio files are downloaded.

**One game at a time gets the sound.** A bot holds exactly one voice connection per server, so
if a second game starts in another channel it plays text-only and says so — rather than
dragging the bot out of the first game's channel, which is what used to happen. The countdown
on the board is the fallback and it works. If you want two games with sound at once you need a
second bot application with its own token; one bot cannot be in two voice channels at once.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/help` | anyone | Rules and command summary |
| `/list create` | Manage Server | Create a character list, tagged with a category |
| `/list add` | Manage Server | Add a character, optionally with an image URL |
| `/list image` | Manage Server | Attach/update a character's image |
| `/list remove` | Manage Server | Remove a character |
| `/list show` | anyone | Browse categories, lists in a category, or one list's characters |
| `/list select` | Manage Server | Tick which lists the server plays with; `top:<n>` re-cuts to the N best-known |
| `/list toggle` | Manage Server | Switch one named list in or out of the pool |
| `/lobby create` | anyone | Open a lobby + post the lobby board (`from` picks the pool; plus `difficulty`, `turn-seconds`, `audience-vote`, `vote-options`, `vote-seconds` — all editable afterwards from the board). Rerolls are always unlimited |
| `/lobby join` / `/lobby leave` | anyone | Join or leave the lobby — two minimum, eight maximum. Mid-game, `leave` forfeits after a confirmation |
| `/lobby spectate` | anyone | Opt in to a DM revealing every character (or the 👁 button on the lobby *or* turn board) |
| `/lobby set-characters` | host | Hand-pick any number of players' characters, up to 5 — with autocomplete (the board's 🎭 button covers the same range without it) |
| `/lobby start` | host | Deal characters and begin |
| `/pass` | current player | End your turn (or use the turn board's button) |
| `/lobby status` | anyone | Whose turn, time remaining, who has already finished |
| `/lobby end` | host/admin | Cancel a stuck lobby or game |
| `/rematch` | that game's players | Replay the last finished game with the same players (or use the reveal's button) |
| `/leaderboard` | anyone | Server standings, or one player's record |

List and character name options have autocomplete — worth leaning on, since the bundled seed
data creates over two thousand lists.

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

## Adding an interactive control

Buttons and select menus are namespaced by the first segment of their `customId`
(`lobby:join:<channelId>`). Register the namespace once in `src/discord/components/router.js`
and give it a handler module — no new branch in `src/discord/index.js` is needed. Two rules worth
remembering:

- **Acknowledge within 3 seconds.** If the handler does slow work (sending DMs, starting a
  game), call `deferUpdate()`/`deferReply()` *first*, then do the work, then `followUp()`.
- **Buttons on a shared message can be clicked by anyone**, so each handler authorizes the
  clicking user itself — the lobby board's Start button checks the host, for example.
