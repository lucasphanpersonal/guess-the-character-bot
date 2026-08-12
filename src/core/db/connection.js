const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// BOT_DB_PATH lets the test suite point at a throwaway database instead of the live one.
// Unset in normal use, where it falls back to data/bot.sqlite.
const dbPath = process.env.BOT_DB_PATH || path.join(__dirname, '..', '..', '..', 'data', 'bot.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations: earlier databases were created before these columns existed.
// CREATE TABLE IF NOT EXISTS won't add columns to an already-existing table.
const characterColumns = db.prepare('PRAGMA table_info(characters)').all();
if (characterColumns.length && !characterColumns.some((col) => col.name === 'image_url')) {
  db.exec('ALTER TABLE characters ADD COLUMN image_url TEXT');
}
if (characterColumns.length && !characterColumns.some((col) => col.name === 'fame')) {
  db.exec('ALTER TABLE characters ADD COLUMN fame INTEGER');
}

const listColumns = db.prepare('PRAGMA table_info(character_lists)').all();
if (listColumns.length && !listColumns.some((col) => col.name === 'category')) {
  db.exec('ALTER TABLE character_lists ADD COLUMN category TEXT');
}
// Existing servers start with nothing enabled, same as a fresh install: with ~2,000 seeded
// lists there is no honest default selection to pick on someone's behalf, so /list select
// is where a server says what it actually plays with.
if (listColumns.length && !listColumns.some((col) => col.name === 'enabled')) {
  db.exec('ALTER TABLE character_lists ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0');
}
if (listColumns.length && !listColumns.some((col) => col.name === 'popularity')) {
  db.exec('ALTER TABLE character_lists ADD COLUMN popularity INTEGER');
}

// Games recorded before this column existed keep a NULL character, and stay that way: which
// character sat on which head was never written down, so there is nothing to backfill from.
const gamePlayerColumns = db.prepare('PRAGMA table_info(game_players)').all();
if (gamePlayerColumns.length && !gamePlayerColumns.some((col) => col.name === 'character_id')) {
  db.exec(
    'ALTER TABLE game_players ADD COLUMN character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL'
  );
}

// game_results -> games + game_players. A table split rather than a column add, so it can't
// use the PRAGMA idiom above.
//
// The guard is the old table's existence, and the last step renames it away: that makes the
// migration idempotent (a second run finds nothing called game_results) without needing a
// migrations table. It is kept rather than dropped so the change stays reversible -- it costs
// nothing, and a fresh database never creates it in the first place.
const legacyResults = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_results'")
  .get();
if (legacyResults) {
  const migrate = db.transaction(() => {
    const rows = db.prepare('SELECT * FROM game_results ORDER BY finished_at').all();
    const insertGame = db.prepare(
      'INSERT INTO games (guild_id, player_count, finished_at) VALUES (?, 2, ?)'
    );
    const insertPlayer = db.prepare(
      'INSERT INTO game_players (game_id, user_id, turns_taken, outcome) VALUES (?, ?, NULL, ?)'
    );
    for (const row of rows) {
      const gameId = insertGame.run(row.guild_id, row.finished_at).lastInsertRowid;
      // turns_taken stays NULL: these games were scored on who guessed first, and never
      // recorded how many turns it took. A tie becomes two 'won' rows, which is exactly how
      // the new schema represents one.
      insertPlayer.run(gameId, row.player1_id, row.result === 'player2' ? 'lost' : 'won');
      insertPlayer.run(gameId, row.player2_id, row.result === 'player1' ? 'lost' : 'won');
    }
    db.exec('ALTER TABLE game_results RENAME TO game_results_legacy');
  });
  migrate();
}

module.exports = db;
