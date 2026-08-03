CREATE TABLE IF NOT EXISTS character_lists (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  category TEXT,
  -- Whether this list is in the server's playable selection, set from /list-filter.
  -- Off by default: the seed data runs to ~2,000 lists, most of them obscure enough that
  -- being dealt one is a dead turn, so a server opts lists IN rather than pruning them out.
  -- Only pooled draws (category / everything / random) honour it -- naming a list outright
  -- is a deliberate act and always works.
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Fame score used to sort the /list-filter page most-recognisable-first, so the lists
  -- worth enabling surface on page 1. Scale differs per source (AniList user counts vs
  -- summed Wikipedia sitelinks) and is only ever compared within a category. NULL for
  -- hand-made lists, which sort last. Populated by `npm run backfill:popularity`.
  popularity INTEGER,
  UNIQUE(guild_id, name COLLATE NOCASE)
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
-- rerolled by one person after another, and that is a better signal about what this server
-- knows than any amount of up-front curation. Once REROLL_DEMOTE_THRESHOLD *different*
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

-- The button-bearing messages ("boards") that are live right now. Deliberately NOT game
-- state -- just enough to find those messages again after a restart and retire them, since
-- the lobby/game they belong to is gone. See src/game/boards.js.
CREATE TABLE IF NOT EXISTS active_boards (
  id INTEGER PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind TEXT NOT NULL, -- 'lobby', 'turn', 'vote', 'gameover', or 'confirm'
  created_at INTEGER NOT NULL,
  UNIQUE(channel_id, message_id)
);

-- One row per finished game, and one per player in it.
--
-- This replaces a single game_results table with two hardcoded player columns and a
-- 'player1' | 'player2' | 'tie' verdict, which cannot describe a game with three players in
-- it. See docs/multiplayer-design.md. Existing rows are migrated in connection.js.
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  player_count INTEGER NOT NULL,
  finished_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  -- Turns this player needed to get their character -- the score, fewest wins. NULL when
  -- they never got it: they gave up, or the game predates turn tracking.
  turns_taken INTEGER,
  -- 'won' | 'lost' | 'gave_up'. Stored rather than derived from MIN(turns_taken) because
  -- migrated two-player games have no turn counts, and inventing them would be a lie about
  -- the data. A tie is simply more than one 'won' row for the same game.
  outcome TEXT NOT NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_games_guild ON games(guild_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
