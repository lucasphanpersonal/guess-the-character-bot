// The one SQLite file everything lives in, opened once per process.
//
// Deliberately schema-free. The file holds two owners' tables -- the compendium's content
// (src/compendium/db.js) and the games' records (src/core/db/connection.js) -- and each applies
// its own schema on top of this handle. Keeping the handle below both is what lets the compendium
// stand on its own: it needs a database, not the game layer.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// BOT_DB_PATH lets the test suite point at a throwaway database instead of the live one.
// Unset in normal use, where it falls back to data/bot.sqlite.
const dbPath = process.env.BOT_DB_PATH || path.join(__dirname, '..', '..', 'data', 'bot.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
