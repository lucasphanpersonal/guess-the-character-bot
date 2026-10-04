-- The compendium: every list, every character, and who plays with which.
--
-- Applied by src/compendium/db.js. The games' own tables (results, live Discord boards) live in
-- src/core/db/schema.sql on the same file; nothing here refers to them.

CREATE TABLE IF NOT EXISTS character_lists (
  id INTEGER PRIMARY KEY,
  -- Who can see the list. NULL is the shared compendium, which every scope sees -- that is
  -- where every seeded list lives, and every list made with `/list create`. Otherwise the one
  -- scope it is private to, and no one else (today only a second Discord server's lists, kept
  -- private by the migration in db.js).
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
  -- Fame score used to sort the /list-filter page most-recognisable-first, so the lists
  -- worth enabling surface on page 1. Scale differs per source (AniList user counts vs
  -- summed Wikipedia sitelinks) and is only ever compared within a category. NULL for
  -- hand-made lists, which sort last. Populated by `npm run backfill:popularity`.
  popularity INTEGER
);

-- One name per owner. An expression rather than a plain UNIQUE(owner_scope, name) because SQL
-- treats every NULL as distinct, which would let two shared lists share a name -- and the seed
-- scripts rely on the second insert of a name failing.
CREATE UNIQUE INDEX IF NOT EXISTS idx_character_lists_owner_name
  ON character_lists (IFNULL(owner_scope, ''), name COLLATE NOCASE);

-- Which lists a scope plays with: its "playable selection", set from /list select in Discord.
--
-- Off by default: the compendium runs to ~2,000 lists, most of them obscure enough that being
-- dealt one is a dead turn, so a scope opts lists IN rather than pruning them out. Only pooled
-- draws (category / everything / random) honour it -- naming a list outright is a deliberate act
-- and always works.
--
-- Per scope, which is the point. It used to be an `enabled` column ON the list, i.e. one switch
-- shared by everyone who could see it: the web app read the Discord server's selection, and a
-- web host unticking a list would have taken it out of the server's game. A scope is any id that
-- plays: a Discord guild id, or 'web' for the web app (WEB_SCOPE overrides that).
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

-- Every reroll, so the pool can learn from them. A character nobody recognises gets
-- rerolled by one person after another, and that is a better signal about what people
-- know than any amount of up-front curation. Once REROLL_DEMOTE_THRESHOLD *different*
-- people have rejected the same character, random draws stop offering it.
--
-- Keyed per (character, user) so one person rerolling the same unlucky draw twice is not
-- mistaken for a consensus.
CREATE TABLE IF NOT EXISTS character_rerolls (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(character_id, user_id)
);
