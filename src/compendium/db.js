// The compendium's tables, on the shared database handle.
//
// Requiring this is what guarantees the content tables exist and are in their current shape, so
// it runs once per process before anything reads a list. The game layer applies its own tables
// afterwards (src/core/db/connection.js), because game_players refers to characters.

const fs = require('fs');
const path = require('path');
const db = require('../db/connection');

const columnsOf = (handle, table) => handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/**
 * Brings an older database up to the current layout. Idempotent: every step is guarded by the
 * shape it changes, so a second run -- or a fresh, empty file -- finds nothing to do.
 *
 * Exported for the test suite, which runs it against a hand-built database in the old layout.
 */
function migrate(handle) {
  // Columns added to characters after it first shipped.
  const characterColumns = columnsOf(handle, 'characters');
  if (characterColumns.length && !characterColumns.includes('image_url')) {
    handle.exec('ALTER TABLE characters ADD COLUMN image_url TEXT');
  }
  if (characterColumns.length && !characterColumns.includes('fame')) {
    handle.exec('ALTER TABLE characters ADD COLUMN fame INTEGER');
  }
  // Columns added to the scoped character_lists after it shipped. (The guild layout below gets
  // them from the rebuild, which writes the scoped table whole.)
  const scopedListColumns = columnsOf(handle, 'character_lists');
  if (scopedListColumns.length && !scopedListColumns.includes('guild_id') && !scopedListColumns.includes('reach')) {
    handle.exec('ALTER TABLE character_lists ADD COLUMN reach INTEGER');
  }

  // Everything below applies only to the guild-scoped layout, which `guild_id` identifies. It is
  // first brought up to its own last shape, because the conversion reads those columns.
  const listColumns = columnsOf(handle, 'character_lists');
  if (!listColumns.includes('guild_id')) return;
  if (!listColumns.includes('category')) handle.exec('ALTER TABLE character_lists ADD COLUMN category TEXT');
  if (!listColumns.includes('enabled')) {
    handle.exec('ALTER TABLE character_lists ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!listColumns.includes('popularity')) handle.exec('ALTER TABLE character_lists ADD COLUMN popularity INTEGER');
  migrateToScopes(handle);
}

/**
 * guild-scoped lists -> one shared compendium, with each scope's selection kept separately.
 *
 * Which lists become shared: EVERY list of the guild holding the most playable content -- the
 * same guild the web app used to auto-pick as its scope, so the web already saw all of them.
 * That includes the lists made there by hand with /list create: they were on the web before, and
 * a migration that quietly took them off it would be a loss nobody asked for. (Lists made with
 * /list create after this point are shared from the start.) Every other guild's lists stay
 * private to it, seeded ones included,
 * because sharing two guilds' copies of "Naruto" would put two shared lists under one name.
 *
 * Each guild keeps exactly the selection it had. The web app, which read that same guild's
 * selection, gets a copy of it under 'web', so it deals what it dealt yesterday and stops
 * sharing the switch.
 *
 * A table rebuild, because SQLite cannot drop a NOT NULL constraint in place. Foreign keys are
 * switched off for it: dropping the old table with them on would CASCADE through characters and
 * delete every character in the database. The new table is built under a temporary name and
 * renamed INTO place -- renaming the old one away instead would rewrite characters' foreign key
 * to follow it to the doomed table.
 */
function migrateToScopes(handle) {
  const contentGuild = handle
    .prepare(
      `SELECT cl.guild_id AS guildId
         FROM character_lists cl
         LEFT JOIN characters c ON c.list_id = cl.id
        GROUP BY cl.guild_id
        ORDER BY SUM(CASE WHEN cl.enabled = 1 THEN 1 ELSE 0 END) DESC, COUNT(DISTINCT c.id) DESC
        LIMIT 1`
    )
    .get()?.guildId ?? null;

  handle.pragma('foreign_keys = OFF');
  try {
    handle.transaction(() => {
      // Must match character_lists in schema.sql (a test compares the two layouts).
      handle.exec(`
        CREATE TABLE character_lists_new (
          id INTEGER PRIMARY KEY,
          owner_scope TEXT,
          name TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          category TEXT,
          popularity INTEGER,
          reach INTEGER
        );
        CREATE TABLE IF NOT EXISTS list_selection (
          scope TEXT NOT NULL,
          list_id INTEGER NOT NULL REFERENCES character_lists(id) ON DELETE CASCADE,
          PRIMARY KEY (scope, list_id)
        );
      `);
      handle
        .prepare(
          `INSERT INTO character_lists_new (id, owner_scope, name, created_by, created_at, category, popularity)
           SELECT id,
                  CASE WHEN guild_id = ? THEN NULL ELSE guild_id END,
                  name, created_by, created_at, category, popularity
             FROM character_lists`
        )
        .run(contentGuild);
      handle.exec(
        `INSERT OR IGNORE INTO list_selection (scope, list_id)
         SELECT guild_id, id FROM character_lists WHERE enabled = 1`
      );
      handle
        .prepare(
          `INSERT OR IGNORE INTO list_selection (scope, list_id)
           SELECT 'web', id FROM character_lists
            WHERE enabled = 1 AND guild_id = ?`
        )
        .run(contentGuild);
      handle.exec('DROP TABLE character_lists');
      handle.exec('ALTER TABLE character_lists_new RENAME TO character_lists');
      const broken = handle.pragma('foreign_key_check');
      if (broken.length) throw new Error(`compendium migration left ${broken.length} dangling reference(s)`);
    })();
  } finally {
    handle.pragma('foreign_keys = ON');
  }
}

migrate(db);
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = db;
module.exports.migrate = migrate;
