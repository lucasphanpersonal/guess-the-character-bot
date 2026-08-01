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

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migrations: earlier databases were created before these columns existed.
// CREATE TABLE IF NOT EXISTS won't add columns to an already-existing table.
const characterColumns = db.prepare('PRAGMA table_info(characters)').all();
if (characterColumns.length && !characterColumns.some((col) => col.name === 'image_url')) {
  db.exec('ALTER TABLE characters ADD COLUMN image_url TEXT');
}

const listColumns = db.prepare('PRAGMA table_info(character_lists)').all();
if (listColumns.length && !listColumns.some((col) => col.name === 'category')) {
  db.exec('ALTER TABLE character_lists ADD COLUMN category TEXT');
}

module.exports = db;
