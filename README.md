# Guess the Character Bot

A Discord bot that hosts "Guess the Character" (the Hedbanz-style game from The Best in
Jest): every player is secretly assigned a character they **can't see themselves**, and they
take turns asking yes/no questions out loud in voice chat until they work out who they are.
Two to eight people can play.

The bot is the impartial host. It deals characters, DMs each player what they need to know,
runs the turn clock, judges guesses, and keeps score — all the actual questions and answers
happen live between humans in voice.

> **It also runs in a browser, two ways — no Discord needed.** Both share this project's game
> core and content, and run from one web server (`npm run web:secure`, see
> [src/web/README.md](src/web/README.md)):
>
> - **On phones** (the site root): Heads Up–style. Each player holds a phone to their forehead,
>   showing their character to the room, and tilts to answer. Design:
>   [docs/mobile-app-plan.md](docs/mobile-app-plan.md).
> - **On computers** (`/desk/`): every screen shows everyone's character but its owner's.
>   Questions go out loud or over a call; on your turn you **type** who you think you are. A
>   clear match counts and a clear miss is just a miss (as many as you like); anything close —
>   a typo, a nickname — goes to the other players to rule on with one tap. See
>   [Checking a typed guess](#checking-a-typed-guess). Each player keeps notes on what they've
>   worked out, shown live on their card to everyone; a note naming someone else's character is
>   refused, so nobody can be handed their answer.
>
> Every web page has a **Dark Mode** toggle (remembered per browser; until it's pressed, the
> device's own setting decides).
>
> And a second game on the same server: **Draw the Character** (`/draw/`). One player draws a
> character they picked from three; everyone else types guesses. Everyone sees what kind of work
> the character is from ("Anime") from the start and the work itself from half time, with any word
> of it that names the character blanked. Letter blanks fill in as hints, faster guesses score
> more, and the drawer scores for everyone who gets it.
>
> Everything below this point describes the Discord bot.

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

### Who decides a guess is right

The player who *can see* your character. There is no text matching anywhere in the bot (or on
the phones): guesses are called out in voice, and the other player hits **✅ They got it** or
**❌ Nope**. Only the computer games, where guesses are typed, have a checker -- see
[Checking a typed guess](#checking-a-typed-guess).

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

The rule (`src/compendium/characterImages.js`) is about **medium**, not about guessing which files
are bad: for live action a photo of the actor genuinely is the character's canonical look, so
it stays; for animation and games no photograph can be right, so Commons images are dropped
there outright. It costs some legitimate Commons-hosted game art, which is the accepted price
of having no false positives — and a missing image costs little, while a wrong one actively
misleads whoever is answering questions.

The seeder applies it going forward. For a database seeded before it existed:

```bash
node scripts/clean-character-images.js --dry-run
```

### Rerolls, and dropping a show

**A reroll is recorded, and that is all.** Each one is kept per (character, person) in
`character_rerolls`, so the browse tool can sort by **Most rerolled** and `/character` can say how
many people have rerolled someone -- a hint for whoever curates. It never stops a character being
dealt. It used to: three different people rerolling a character retired it from every random
draw. But a reroll says *this table didn't know them*, not *nobody should get them*, and one
party's skip is another's favourite -- so whether a character stays in play is a person's call,
made with the tools below, not a counter's.

**🚫 Never deal this show** sits next to Reroll on the confirmation DM. It drops that list
from the server's selection *and* rerolls, in one press — the alternative is rerolling now
and remembering to curate later, which nobody does. It costs a reroll (because it is one),
refuses if dropping would leave the lobby nothing to deal from, and `/list toggle` undoes it.
Because this changes the shared pool, it requires the **Manage Server** permission.

### Choosing which lists you play with

The seed data runs to ~2,000 lists, and most of them are obscure enough that being dealt one
is a wasted turn — the reroll button was doing the job a filter should. Server managers use
`/list select` for that filter: a page of checkboxes (multi-select menus, 75 per page)
covering every list, with a running count of what's on.

**Every server has its own selection.** The lists themselves are one shared compendium (see
[The compendium](#the-compendium-shared-lists-and-scopes)), but which of them a server plays
with is that server's alone — and the web app has a separate one again. Ticking a list here
changes nothing anywhere else.

**Setup enables the top 100 of each category**, so a server starts with a sensible pool
rather than an empty one. That happens in `npm run backfill:popularity -- <server-id>`, which
ranks the shared lists by fame and then switches on the best-known 100 per category for that
server (`--top=N` to move the line, `--no-enable` to rank without touching the selection; with
no id it only ranks). The ranking reads the seed files — AniList audience size for Anime and
Manga, summed Wikipedia sitelinks across the cast for everything else. Unranked lists sort last
and still work.

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
enabled on creation for the same reason — in the server that made them **and on the web**.
They are shared, so every other server can see them too, and switch them on with `/list
toggle`.

### The compendium: shared lists and scopes

Every list and character lives in one **compendium** (`src/compendium/`), and anything that
plays reads it as a **scope**: a Discord server is a scope (its guild id), and so is the web
app (`'web'`, or `WEB_SCOPE` if set). A scope sees:

- the **shared** lists — everything the seed scripts create and everything made with `/list
  create`, visible to every scope; and
- its **own private** lists, which nobody else sees. Nothing creates these today except the
  migration below, for a second server's lists; the slot exists for anything a scope should
  keep to itself.

Each scope also keeps its **own playable selection**. That used to be a single `enabled` flag
on each list, shared by everyone — so the web app was quietly playing (and could have been
rewriting) one Discord server's choices. Now a server's `/list select` and the web's selection
are independent.

The Discord commands that edit a list's characters (`/list add`, `/list remove`, `/list
image`) work on any list the server can see, shared ones included, and still need **Manage
Server**. An edit to a shared list is an edit for everyone who plays it — fine for one owner's
servers, and the thing to revisit before the bot is shared more widely.

The web app's selection has no admin screen; set it from the command line:

```bash
npm run select:lists                                       # show the web's selection
npm run select:lists -- --top=100                          # exactly each category's top 100
npm run select:lists -- --add="Naruto" --remove="Bleach"   # one list at a time
npm run select:lists -- --copy-from=<server-id>            # copy a Discord server's selection
npm run select:lists -- --scope=<server-id>                # any other scope instead of the web
```

Databases from before scopes are migrated automatically the first time the new code opens
them: every list of the server with the most content becomes shared — its hand-made ones too,
because the web app could already see them — while any other server's lists stay private to
it. Every server keeps exactly the selection it had, and the web app starts with a copy of that
server's selection, so it deals what it dealt before.

### Checking a typed guess

The Discord bot and the phones leave guesses to the people at the table. Games played on a
computer can't, so the compendium has a checker (`src/compendium/answers.js`) with three
verdicts:

| Verdict | For |
| --- | --- |
| **correct** | The name however it's typed (`spiderman`, `uzumaki naruto`); without a qualifier or a leading "The"; a quoted nickname alone (`Tails`) or the name without it; the part before a describing comma (`Catherine`). And — only if the game turns it on — one word of a two- or three-word name when nobody else in the pool has it (`Sasuke`). |
| **close** | Something a person should look at: a title stripped off (`Leia` for Princess Leia, but also `America` for Captain America), a word other characters share (`Uzumaki`), a typo or two, or the right name with extra words. |
| **wrong** | Everything else. |

Run against every character in the compendium, it never accepts one character's full name for a
different character's. The same rules decide which two names are one character when a game is
dealt, so nobody is dealt "Noelle Silva" while somebody else wears "Silva Noelle".

### Audience-vote mode

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

### Sound effects

If the players share a voice channel when the game starts, the bot joins and plays
a countdown chime at decreasing intervals, plus stings for correct guesses, wrong guesses,
and the final win. Otherwise everything falls back to the text countdown. The sounds are
short tones synthesized by `npm run generate:sounds` — no audio files are downloaded.

**One game at a time gets the sound.** A bot holds exactly one voice connection per server, so
if a second game starts in another channel it plays text-only and says so — rather than
dragging the bot out of the first game's channel, which is what used to happen. The countdown
on the board is the fallback and it works. If you want two games with sound at once you need a
second bot application with its own token; one bot cannot be in two voice channels at once.

---

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

Bundled importers, all idempotent — re-running only adds what's missing, so they're safe to
run repeatedly. Everything they create goes into the **shared compendium**, which every server
and the web app see; nothing is switched on until a scope selects it (`npm run
backfill:popularity -- <server-id>` does that in bulk — see
[Choosing which lists you play with](#choosing-which-lists-you-play-with)).

```bash
npm run seed:people     # ~2,900 famous real people, with photographs
npm run seed:pokemon    # 1,025 Pokémon, with official artwork
npm run seed:lol        # 173 League of Legends champions, with splash art
npm run seed:wikidata   # Western TV/film/game casts, one list per title
npm run seed:anilist    # anime/manga casts, one list per title
```

These used to take a server id first. An old command that still passes one is fine: the id is
recognised, ignored with a note, and the lists land in the shared compendium as usual.

> **The Character Codex was removed.** It was the original bulk source and a poor fit: it
> carried categories nobody plays with (Blogs, Magazines, Scientific Papers, Research
> Journals), filed authors as characters (Eiichiro Oda under One Piece), and duplicated
> characters under several spellings — One Piece arrived with four Luffys and three
> Choppers, but no Zoro, Nami, Sanji or Usopp. The Wikidata and AniList importers cover the
> same ground with real casts. Use `npm run reset:seeded` to clear seed-created lists from
> the shared compendium before rebuilding from these sources.

- **`seed:people`** fills a **Real People** category with 21 lists by field — Actors,
  Footballers, Scientists & Inventors, Politicians & Leaders, Religious Figures, Musicians,
  Comedians and the rest — from [Wikidata](https://www.wikidata.org). Ranked by how many
  language Wikipedias carry an article, which is the same fame signal the Wikidata-sourced
  fictional characters use, so `difficulty` and `/list select` work on them unchanged.

  **This is the one category where a photograph is simply correct.** The image rule exists
  because Wikidata's image property answers "an image associated with this item", which for a
  fictional character gives you the actor or a cosplayer — but for a real person it gives you
  the person. 98% arrive with one.

  Wikidata files most people under several occupations, so lists are declared in priority
  order and the first to claim somebody keeps them. That ordering is doing real work: it is
  what puts Maradona in Footballers rather than Actors (he is filed as both), Kobe Bryant in
  Basketball rather than Directors (he won an Oscar for a short film), and Reagan in
  Politicians rather than Actors. Two rules were settled by measurement rather than argument:
  musicians are claimed before actors, because the other way round drags Shakira, Madonna,
  Eminem and Beyoncé into the top of Actors; and boxing, American football and baseball are
  claimed *after* the performing arts, because John Wayne, Dwayne Johnson, Bing Crosby and
  Will Ferrell are all filed as having played them.

  `--per-list N` changes how many of each field are kept (default 150) and `--dry-run` shows
  what would happen. Refresh the roster with `npm run fetch:people`.
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

### Browsing what you've got

`/list show` paginates inside Discord, which is fine for checking one show and hopeless for
43,000 characters. `npm run browse` serves a local page for it instead:

```bash
npm run browse          # then open http://localhost:4173
```

Search by name across everything, filter by category, by whether a list is in the playable
pool, or by whether a character has artwork at all, and sort by fame or by how often people
have rerolled someone. Clicking a list drills into it. It reads the live database
**read-only**, so it is safe to run while the bot is up and cannot change what gets dealt --
curation still happens through `/list toggle`, `/list select` and `npm run select:lists`.
It looks through one scope's eyes — the web app's by default; `--scope=<server-id>` shows a
server's private lists and its own playable pool instead.

Two views worth knowing about: **Missing artwork** finds the characters that will reveal as
plain text, and sorting by **Most rerolled** shows what people keep rejecting -- the place to
start if you want to switch a list off by hand.

`--port=` and `--db=` override the defaults.

`seed:pokemon` and `seed:lol` take an optional list name as their argument. Combine
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

The repo holds **two frontends over one shared core, on top of one compendium**. The layers,
bottom up — each imports only from the ones below it:

- `db/` opens the one SQLite file, and nothing more.
- `compendium/` is the content: every list and character, the scopes that see them, and each
  scope's playable selection ([The compendium](#the-compendium-shared-lists-and-scopes)). It
  owns its own tables and knows nothing about games.
- `core/` is the game: rules, turn counts, standings, and the records of finished games.
  Discord-agnostic and frontend-agnostic.
- `discord/` is this bot; `web/` is the party-mode web app
  ([docs/mobile-app-plan.md](docs/mobile-app-plan.md)).

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

---

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

### Adding an interactive control

Buttons and select menus are namespaced by the first segment of their `customId`
(`lobby:join:<channelId>`). Register the namespace once in `src/discord/components/router.js`
and give it a handler module — no new branch in `src/discord/index.js` is needed. Two rules worth
remembering:

- **Acknowledge within 3 seconds.** If the handler does slow work (sending DMs, starting a
  game), call `deferUpdate()`/`deferReply()` *first*, then do the work, then `followUp()`.
- **Buttons on a shared message can be clicked by anyone**, so each handler authorizes the
  clicking user itself — the lobby board's Start button checks the host, for example.
