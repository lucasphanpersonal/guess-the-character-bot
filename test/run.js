// Zero-dependency test runner: `npm test`.
//
// Points the DB layer at a throwaway file BEFORE anything requires it, so tests can never
// read or write data/bot.sqlite.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-test-')), 'test.sqlite');
process.env.BOT_DB_PATH = tmpDb;

// Required after BOT_DB_PATH is set, so the DB layer still opens the throwaway file.
const GameManager = require('../src/game/GameManager');
const engine = require('../src/game/engine');
const { clearVoteTimer } = require('../src/game/audienceVote');

/**
 * Returns the shared world to empty between tests.
 *
 * Tests do their own cleanup, but a test that FAILS throws before reaching it -- and what it
 * abandons is a live game in a module-level Map with a running timer. The next suite sees it:
 * the timer watchdog counts every unfinished game it can find, so one genuine failure
 * manufactured a second, unrelated-looking one in a different file. That cost real debugging
 * time twice, and the second failure is the more misleading of the two because nothing about
 * it points at the test that actually broke.
 */
function sweepSharedState() {
  for (const lobby of GameManager.allLobbies()) {
    if (lobby.game) engine.clearTimers(lobby.game);
    clearVoteTimer(lobby.vote);
  }
  GameManager.clear();
}

const testFiles = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let passed = 0;
const failures = [];

(async () => {
  for (const file of testFiles) {
    const suite = require(path.join(__dirname, file));
    const suiteName = file.replace(/\.test\.js$/, '');
    console.log(`\n${suiteName}`);
    for (const [name, fn] of Object.entries(suite)) {
      try {
        await fn();
        passed++;
        console.log(`  ok  ${name}`);
      } catch (err) {
        failures.push({ suiteName, name, err });
        console.log(`  FAIL ${name}`);
      } finally {
        sweepSharedState();
      }
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const { suiteName, name, err } of failures) {
    console.log(`\n--- ${suiteName} > ${name} ---`);
    console.log(err.message);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  }

  // Best-effort cleanup; the OS temp dir gets swept anyway.
  try {
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  process.exit(failures.length ? 1 : 0);
})();
