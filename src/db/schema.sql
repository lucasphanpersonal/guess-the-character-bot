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

CREATE TABLE IF NOT EXISTS game_results (
  id INTEGER PRIMARY KEY,
  guild_id TEXT NOT NULL,
  player1_id TEXT NOT NULL,
  player2_id TEXT NOT NULL,
  result TEXT NOT NULL, -- 'player1', 'player2', or 'tie'
  finished_at INTEGER NOT NULL
);
