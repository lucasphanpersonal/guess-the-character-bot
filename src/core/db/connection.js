// The game layer's tables, on the shared database handle.
//
// The compendium's tables are required first: game_players refers to characters, and requiring
// the compendium is what guarantees those exist and are migrated. Everything in core and the two
// frontends that keeps a game record goes through this module; content reads go through
// src/compendium instead.

const fs = require('fs');
const path = require('path');
const db = require('../../compendium/db');

// Games recorded before this column existed keep a NULL character, and stay that way: which
// character sat on which head was never written down, so there is nothing to backfill from.
const gamePlayerColumns = db.prepare('PRAGMA table_info(game_players)').all();
if (gamePlayerColumns.length && !gamePlayerColumns.some((col) => col.name === 'character_id')) {
  db.exec(
    'ALTER TABLE game_players ADD COLUMN character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL'
  );
}

db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

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
