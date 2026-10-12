# Guess the Character

"Guess the Character" -- the Hedbanz-style game from The Best in Jest: every player is secretly
assigned a character they **can't see themselves**, and they take turns asking yes/no questions
until they work out who they are. Two to eight people play. Fewest turns wins.

One project, three ways to play it, all dealing from one shared library of characters:

- **On Discord.** The bot is the impartial host: it deals characters, DMs everyone what they need
  to know, runs the turn clock, and keeps score, while the questions and answers happen live in
  voice. Whoever can see your character rules on your guess with a button.
  → [Playing on Discord](docs/discord.md)
- **On phones** (*Guess on Phones*, from the website's home page). Heads Up–style: each player
  holds a phone to their forehead, showing their character to the room, and tilts to answer.
  → [src/web/README.md](src/web/README.md) · design: [docs/mobile-app-plan.md](docs/mobile-app-plan.md)
- **On computers** (*Guess on Computers*, `/desk/`). Every screen shows everyone's character but
  its owner's -- whoever is asking questions big in the middle, everyone else in a strip along the
  bottom; on your turn you **type** who you think you are. A clear match counts, a clear miss is just a miss, and
  anything close goes to the other players to rule on. Each player keeps notes, shown live to
  everyone -- a note that would name someone's character is refused.
  → [src/web/README.md](src/web/README.md)

And a second game on the same web server: **Draw the Character** (`/draw/`), on phones and
computers alike in one room. One player draws a character they picked from three; everyone else
types guesses. The hints wait for the drawing: the kind of work at a quarter of the time, the
blanks at half, letters written in from there, the work itself for the last quarter. Faster
guesses score more, the drawer scores for everyone who gets it, and the night's drawings come
back at the end with accolades and a vote for the best, each one saveable. Or play it as
**Telephone**: everyone at once, each chain passed along -- draw, guess, draw -- then replayed card
by card to see where it went wrong.

The website's home page asks which game: Draw, or Guess on phones or on computers. In every game a **Room** button lists
who is in the room and lets anyone leave, and the host remove anyone or pause the game. Every
page has a **Dark Mode** switch (remembered per browser; until it's pressed, the device's own
setting decides).

## Quick start

```bash
npm install
cp .env.example .env      # DISCORD_TOKEN and CLIENT_ID, for the bot
```

The **Discord bot** -- full setup, invite link and permissions in
[Playing on Discord › Setup](docs/discord.md#setup):

```bash
npm run deploy-commands   # once, and whenever a command's options change
npm start
```

The **web games** -- phones need HTTPS for their motion sensors, hence `web:secure`:

```bash
npm run web:secure        # HTTP on :4180 and HTTPS on :4443
```

Or both at once, optionally behind a Cloudflare tunnel for playing off the LAN:

```bash
npm run start:all -- --secure --tunnel
```

A fresh database has no characters. Seed the library and choose what each server (and the web)
plays with -- see [The compendium › Seeding](docs/compendium.md#seeding-character-lists) and
[Choosing which lists you play with](docs/compendium.md#choosing-which-lists-you-play-with).

## The docs

| | |
| --- | --- |
| [docs/discord.md](docs/discord.md) | How a game runs on Discord, judging, audience vote, sound, every command, bot setup |
| [docs/compendium.md](docs/compendium.md) | The character library: difficulty, images, rerolls, per-server lists, the typed-guess checker, seeding, browsing |
| [src/web/README.md](src/web/README.md) | The web games: phones, computers and Draw -- running, testing, how each plays |
| [docs/architecture.md](docs/architecture.md) | How the repo is laid out, where state lives, restarts, tests |
| [CLAUDE.md](CLAUDE.md) | Working notes: the rules that keep the code honest, and the bugs that taught them |
| [docs/multiplayer-design.md](docs/multiplayer-design.md), [docs/multiplayer-ux.md](docs/multiplayer-ux.md), [docs/mobile-app-plan.md](docs/mobile-app-plan.md) | Design records: why the rules and the web app are the way they are |

## Developing

```bash
npm test                  # the unit suite -- no network, no Discord
npm run check:web-socket  # boots the real web server and plays full games over sockets
```

Both must pass before a commit. More in [Architecture › Development](docs/architecture.md#development).
