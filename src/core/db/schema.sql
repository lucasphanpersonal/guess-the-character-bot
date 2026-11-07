-- The games' own records: finished games, written by the Discord bot while there was one.
--
-- Nothing writes these now; the web games keep no records. The tables stay because the live
-- database holds that history, and the content scripts that merge or delete characters
-- (tidy-characters, rename-anilist-characters) keep its character_id pointing right. An old
-- database may also still hold the bot's `active_boards` table: harmless, and left alone.
--
-- Applied by src/core/db/connection.js, AFTER the compendium's tables
-- (src/compendium/schema.sql), because game_players points at a character.

-- One row per finished game, and one per player in it.
--
-- This replaces a single game_results table with two hardcoded player columns and a
-- 'player1' | 'player2' | 'tie' verdict, which cannot describe a game with three players in
-- it. See docs/multiplayer-design.md. Existing rows are migrated in connection.js.
--
-- guild_id here really is a Discord guild: stats and the leaderboard were per server. It is not
-- the compendium's scope, and the compendium's move away from guild ids did not touch it.
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
  -- Which character they were wearing. Turn counts alone cannot say whether a long game was
  -- a hard character or a slow table, and this is the only moment the pairing exists -- a
  -- finished game is not reconstructable afterwards. NULL for characters assigned by hand
  -- via /lobby set-characters, which have no row behind them, and for every game played
  -- before this column existed.
  --
  -- SET NULL rather than CASCADE or the default RESTRICT. CASCADE would delete the player out
  -- of a game they actually played because someone later pruned a list. RESTRICT would make
  -- `/list remove` and `npm run reset:seeded` start failing on any character that has ever
  -- been dealt. Losing the link is the only loss the game itself survives.
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_games_guild ON games(guild_id);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);
