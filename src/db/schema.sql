CREATE TABLE IF NOT EXISTS character_lists (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  category TEXT,
  UNIQUE(guild_id, name COLLATE NOCASE)
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL REFERENCES character_lists(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  image_url TEXT,
  UNIQUE(list_id, name COLLATE NOCASE)
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

CREATE TABLE IF NOT EXISTS game_results (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  result TEXT NOT NULL, -- 'player1', 'player2', or 'tie'
  finished_at INTEGER NOT NULL
);
