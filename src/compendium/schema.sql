-- The compendium: every list, every character, and who plays with which.
--
-- Applied by src/compendium/db.js. The games' own tables (finished games) live in
-- src/core/db/schema.sql on the same file; nothing here refers to them.

CREATE TABLE IF NOT EXISTS character_lists (
  id INTEGER PRIMARY KEY,
  -- Who can see the list. NULL is the shared compendium, which every scope sees -- that is
  -- where every seeded list lives, and every list made by hand. Otherwise the one
  -- scope it is private to, and no one else (today only a second Discord server's lists, kept
  -- private by the migration in db.js, from when a Discord bot shared this database).
  --
  -- This was `guild_id NOT NULL` once, with the seed scripts filing ~2,000 lists under one
  -- Discord server and the web app borrowing that server's id to see them. Renamed rather than
  -- reused so any query still written against the old meaning fails loudly instead of quietly
  -- returning nothing. Migrated in db.js.
  owner_scope TEXT,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  category TEXT,
  -- Fame score used to sort lists most-recognisable-first (the /list-filter page, the web's
  -- picker and library), so the lists worth enabling surface on page 1. Scale differs per
  -- category (AniList user counts for Anime and Manga; a year of English Wikipedia readers,
  -- summed over a franchise's works, for TV, Cartoon, Movies and Games; summed sitelinks for
  -- Real People) and is only ever compared within a category. NULL for hand-made lists, which
  -- sort last. Populated by `npm run backfill:popularity` and scripts/fetch-work-fame.js.
  popularity INTEGER,
  -- How many people know the list's single best-known work: a year of English Wikipedia
  -- readers of it, on ONE scale across every category -- which is what popularity cannot be.
  -- Decides which of a character's lists names them (getCharacterOrigin): Luke Skywalker is in
  -- a film list and four game lists, and is from the film. The best single work, not a
  -- franchise's total, or twenty Star Wars games would outweigh the film. NULL when unknown.
  -- Populated by scripts/fetch-work-fame.js.
  reach INTEGER
);

-- One name per owner. An expression rather than a plain UNIQUE(owner_scope, name) because SQL
-- treats every NULL as distinct, which would let two shared lists share a name -- and the seed
-- scripts rely on the second insert of a name failing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_lists_owner_name
  ON character_lists (IFNULL(owner_scope, ''), name COLLATE NOCASE);

-- Which lists a scope plays with: its "playable selection" (`npm run select:lists`).
--
-- Off by default: the compendium runs to ~2,000 lists, most of them obscure enough that being
-- dealt one is a dead turn, so a scope opts lists IN rather than pruning them out. Only pooled
-- draws (category / everything / random) honour it -- naming a list outright is a deliberate act
-- and always works.
--
-- Per scope, which is the point. It used to be an `enabled` column ON the list, i.e. one switch
-- shared by everyone who could see it: the web app read the Discord server's selection, and a
-- web host unticking a list would have taken it out of the server's game. A scope is any id that
-- plays: 'web' for the web app (WEB_SCOPE overrides that), and the Discord guild ids whose
-- selections are still on file from the retired bot.
CREATE TABLE IF NOT EXISTS list_selection (
  scope TEXT NOT NULL,
  list_id INTEGER NOT NULL REFERENCES character_lists(id) ON DELETE CASCADE,
  PRIMARY KEY (scope, list_id)
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES character_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  image_url TEXT,
  -- How well known this character is: AniList favourites, or Wikipedia sitelinks for the
  -- Wikidata-sourced lists. Only ever compared against others in the SAME list, which is
  -- what lets two different scales share the column -- see difficulty in characterLists.js.
  -- NULL for hand-added characters, and for anything the backfill couldn't match.
  fame INTEGER,
  UNIQUE(list_id, name COLLATE NOCASE)
);

-- Every reroll, as a curation signal: a character nobody recognises gets rerolled by one
-- person after another, which the browse tool (Most rerolled) and /character show to whoever
-- curates. It never changes what is dealt -- see recordReroll in characterLists.js for why
-- rerolls stopped retiring characters.
--
-- Keyed per (character, user) so one person rerolling the same unlucky draw twice counts once.
CREATE TABLE IF NOT EXISTS character_rerolls (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(character_id, user_id)
);
