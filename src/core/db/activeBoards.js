// Storage for the active_boards table: which button-bearing messages are live right now.
// The rows describe messages, never game state -- see src/game/boards.js for why.

const db = require('./connection');

function rememberBoard(channelId, messageId, kind) {
  // Only the newest board of a kind is ever live in a channel: the turn board is replaced
  // every turn, the lobby board once per lobby. Dropping the older row keeps the table from
  // growing when an untrack never happens -- a crash mid-turn, say.
  db.prepare('DELETE FROM active_boards WHERE channel_id = ? AND kind = ?').run(channelId, kind);
  db.prepare(
    'INSERT OR REPLACE INTO active_boards (channel_id, message_id, kind, created_at) VALUES (?, ?, ?, ?)'
  ).run(channelId, messageId, kind, Date.now());
}

function forgetBoard(channelId, messageId) {
  db.prepare('DELETE FROM active_boards WHERE channel_id = ? AND message_id = ?').run(channelId, messageId);
}

function allBoards() {
  return db
    .prepare('SELECT channel_id AS channelId, message_id AS messageId, kind FROM active_boards ORDER BY id')
    .all();
}

module.exports = { rememberBoard, forgetBoard, allBoards };
