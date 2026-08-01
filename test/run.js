// Zero-dependency test runner: `npm test`.
//
// Points the DB layer at a throwaway file BEFORE anything requires it, so tests can never
// read or write data/bot.sqlite.

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-test-')), 'test.sqlite');
process.env.BOT_DB_PATH = tmpDb;

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
