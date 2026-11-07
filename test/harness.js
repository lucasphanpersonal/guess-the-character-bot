// Minimal zero-dependency test harness.
//
// Tests run against a throwaway SQLite file (BOT_DB_PATH, set by test/run.js) so they can
// never touch data/bot.sqlite. Nothing here talks to the network.

const assert = require('node:assert/strict');

module.exports = { assert };
