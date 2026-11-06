# The compendium

The content every game deals from: lists and characters, how obscure a deal may go, which
images can be trusted, which lists each server (and the web) plays with, how a typed guess is
checked, and how the library is seeded and browsed. Shared by the Discord bot and every web
game; the code is `src/compendium/`.

---

## Difficulty: how obscure a character you'll be dealt

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

## Character images, and which ones can be believed

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

The rule (`src/compendium/characterImages.js`) is about **source**, not about guessing which
files are bad: Commons images are kept for Real People, where the photograph is the person, and
dropped for every fictional character. It first dropped them only in Cartoon and Video Games, on
the theory that a live-action character's photo is the actor. But the category does not say the
medium: animated films and series are filed under Movies and Television Shows, and 543 Commons
files had reached fictional characters that way, about 200 of them plainly cosplay, expo or
wax-museum shots (Azula "cosplay at Katsucon", Gaston at the D23 Expo, Flo from Cars at a Disney
resort). Live action still gets the actor, from TMDB, which credits them in that very role, or
from the show's own wiki. It costs some legitimate Commons-hosted art, which is the accepted
price of having no false positives — a missing image costs little, while a wrong one actively
misleads whoever is answering questions.

The seeder applies it going forward. For a database seeded before it existed, clear the Commons
files the rule no longer trusts (only Commons: art set by hand with `/list image` is left alone),
then let the wiki and TMDB backfills refill what they can, since both touch only characters with
no image:

```bash
node scripts/clean-character-images.js --dry-run
npm run fetch:fandom -- --category=Movies
npm run fetch:tmdb -- --category=Movies     # likewise for "Television Shows"
```

## Rerolls, and dropping a show

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

## Choosing which lists you play with

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
Manga; for TV, Cartoon, Movies and Video Games, a year of English Wikipedia readers of the work
itself (summed over a franchise's works), from `npm run fetch:work-fame` and its
`data/seed/work-fame.json`; summed sitelinks for Real People. Readers rather than the cast's
sitelinks, which ranked a big cast over a famous show (Glee above Breaking Bad), and rather than
how many Wikipedias cover the work, which bulk-made stubs inflate (Go, Dog. Go! is in 160 of
them, Breaking Bad 93). Unranked lists sort last and still work.

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

## The compendium: shared lists and scopes

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

## Checking a typed guess

The Discord bot and the phones leave guesses to the people at the table. Games played on a
computer can't, so the compendium has a checker (`src/compendium/answers.js`) with three
verdicts:

| Verdict | For |
| --- | --- |
| **correct** | The name however it's typed (`spiderman`, `uzumaki naruto`); without a qualifier or a leading "The"; a quoted nickname alone (`Tails`) or the name without it; the part before a describing comma (`Catherine`). And — only if the game turns it on, which both computer games do — one word of a two- or three-word name when nobody else in that character's own show has it (`Sasuke`, `Luffy`), or everyone who does is at least ten times less famous (`Uzumaki` for Naruto, `Bakugo` for Katsuki; not `Uchiha`, which Itachi and Sasuke share). |
| **close** | Something a person should look at: a title stripped off (`Leia` for Princess Leia, but also `America` for Captain America), a word other characters share (`Uzumaki`), a typo or two, or the right name with extra words. |
| **wrong** | Everything else. |

**Typos, where a game turns them on.** Draw does (`acceptTypos`), because there "close" is only a
hint, and a guesser who plainly knew the answer used to score nothing for `Hermoine Granger`. The
computer guessing game doesn't: there a close guess goes to the other players to rule on. A typo
counts as correct when it is small (one slip from five letters, two from ten — nothing below five,
where `Mira` and `Mara` are two people), on a form that would have counted itself (not a stripped
title, not a shared surname), and is not another character's name. That means anyone within a typo
of it in the same show, and anyone in the library with exactly that name: 7,583 names sit one letter
from a different character's (`Banjo` and Elfen Lied's `Bando`). Measured over the 500 best-known
characters, a swap of two letters used to count 4 times; it now counts 486.

Run against every character in the compendium, it never accepts one character's full name for a
different character's — with typos accepted, too. The same rules decide which two names are one character when a game is
dealt, so nobody is dealt "Noelle Silva" while somebody else wears "Silva Noelle".

## Where a character is from

A character is shown with the work they come from — "Luke Skywalker, Star Wars: Episode VII
(Movies)" — and Draw hands the same thing out as hints. Most characters sit in several lists
(Luke is in a film, a Lego show and four games lists), so one is chosen
(`getCharacterOrigin`):

- **Only lists of the same franchise as the one they were dealt from count**: ones sharing at
  least two other characters with it. Names collide across franchises — ONE PIECE has a Batman,
  Ben 10 a Ditto — and the dealt list is the one thing that knows which character this is. That
  holds even when the dealt list cannot be shown because it is named after them (the Batman
  games list is called "Batman").
- **Among those, the best-known work wins**: each list's `reach`, the English Wikipedia readers
  of its single best-known work over a year, measured for every category on one scale by
  `npm run fetch:work-fame`. The best single work, not the franchise total, or twenty Star Wars
  games added up would outweigh the film.
- Without reach to go on, the list they were dealt from stands; looked up by name alone, the
  biggest list wins.

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
npm run seed:dota2      # 127 Dota 2 heroes, with portraits
npm run seed:deadlock   # Deadlock's heroes (all but cut and test ones), with portraits
npm run seed:persona    # ~400 Persona characters from the games, with artwork
npm run seed:wikidata   # Western TV/film/game casts, one list per title
npm run seed:anilist    # anime/manga casts, one list per title
```

The hero games come from small roster files in `data/seed/` (`dota-2.json`, `deadlock.json`),
refreshed with `npm run fetch:rosters` — OpenDota's hero constants and deadlock-api.com's assets,
names and image links only. Deadlock's list carries cut and test heroes, marked disabled; only the
rest are kept (not the "selectable" flag, which still marks the newest heroes unselectable),
since a character nobody has seen is not one anyone can guess.

**Persona** comes from the games too (`persona.json`, from the Megami Tensei wiki's character
category for each game — the anime, film and novel ones left out). The Wikidata seed files every
Persona game under *Megami Tensei* and has entries for only a few of their characters, and the
anime fell below the AniList seed's popularity cut, so neither seed would ever have made it.
A character's fame there is the length of their wiki page, which is what lets Easy deal the
party rather than a classmate with one line. Its popularity is measured from the games
themselves, given by hand in `data/seed/work-overrides.json`: searching Wikidata for "Persona"
finds the term in psychology.

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
  [AniList](https://anilist.co), with artwork on nearly every character. Names are shown the
  way English releases write them (`scripts/lib/anilistNames.js`): given name first ("Satoru
  Gojo", "Spike Spiegel", "Eren Yeager"), surname first only for the franchises whose English
  releases keep it (ONE PIECE: "Monkey D. Luffy", "Roronoa Zoro"), and with the long vowels
  AniList spells out folded (Gojou → Gojo, Shouyou → Shoyo), but only inside a word made
  entirely of Japanese syllables, so Louise and Soul are never touched.

  The importer used to put every name surname-first, which was right for ONE PIECE and
  scrambled the rest: 13,313 of 20,562 names, including every Western one ("Spiegel Spike",
  "Forger Loid"). To move a database seeded that way onto the new names:

  ```bash
  npm run fetch:anilist                            # once: re-fetches any series without name parts
  node scripts/rename-anilist-characters.js        # report: data/anilist-renames-<time>.csv
  node scripts/rename-anilist-characters.js --apply   # writes an undo log first (--undo=<log>)
  node scripts/rename-anilist-characters.js --apply --merge-duplicates   # also fold names that collided
  ```

  It can be run again whenever the rules change: a row is found by any spelling its character's
  name has had (`looseKey`: Gojou Satoru, Gojo Satoru and Satoru Gojo are one key), always
  together with the character's image or an old name that means one character only. A rename
  that collides with a name already in the list is reported; where the row holding the name is
  the same character (no art, art that is no AniList character's, or art only that character uses: the placeholder is shared by 1,813, so it is no evidence), it is a
  duplicate, and `--merge-duplicates` folds the two: the kept row takes the other's picture,
  fame, rerolls and past games, and the other is deleted, all in the undo log first. Two
  different characters whose names come out alike are marked `distinct` and left alone.
  "oo" folds only at the start of a word (Ootsutsuki → Otsutsuki); inside one it is as often two
  syllables (Hiro-omi), so the long ones there are exceptions (Tooru → Toru). A name no rule can
  make (Kyouraku's middle names, Fairy Tail's Ooba Babasaama) goes in `NAME_OVERRIDES`. AniList files
  middle names inside the first name and changes them, so a row is also matched by its surname and
  the last word of its first name ("Kyouraku Jirou Souzousa Shunsui" is Kyouraku Shunsui).

  Read the CSV before `--apply`, and look in particular for English words the long-vowel rule
  folded by mistake: the rule's exceptions (`FOLD_EXCEPTIONS`) came from exactly that reading
  (Urouge, Mouseman, Mousse, Rouge, Mountain), and from it the rule that "-ura" never folds
  (Minoura is Mino-ura). Read the rows marked `check_order` too: AniList files a few characters
  with the surname as the given name, so the old flip happened to show them right ("Tim Marcoh")
  and the new order scrambles them. The ones found so far are kept as they were
  (`PARTS_SWAPPED`); `check_order` flags renames whose old first word ends like a Japanese
  given name (-rou, -suke, -ichi: "Heihachirou Kuroda"), the likeliest shape of more. The script
  works each new name out from the stored name parts with the current rules, so a fix to the rules
  shows in the very next report, without a re-fetch. Guesses typed the old way still count: both computer games
  judge Anime and Manga names with `romanised`, which folds long vowels and takes the words in
  any order, so "Gojou Satoru" is correct for "Satoru Gojo". The seed file also keeps AniList's
  other names for each character, for a later pass at nicknames such as "All Might".

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

## Browsing what you've got

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
