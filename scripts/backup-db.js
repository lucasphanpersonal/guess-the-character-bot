// Snapshots data/bot.sqlite to data/bot.sqlite.bak-<label>-<timestamp>, matching the naming
// the repo's other manual backups already use (see .gitignore's data/*.sqlite.bak-* rule).
//
// Uses better-sqlite3's online backup API rather than copying the file: the live database
// runs in WAL mode, and recent writes can still be sitting in bot.sqlite-wal rather than in
// bot.sqlite itself, so a plain file copy can silently miss them. The backup API reads a
// consistent snapshot instead, safely even while the site is running.
//
// Usage:
//   node scripts/backup-db.js [label]
//
// The bare handle (src/db), NOT the compendium's or the game layer's: those migrate the database
// when they load, and the backup worth having before a schema change is the one taken before it.

const path = require('path');
const db = require('../src/db/connection');

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function main() {
  const label = process.argv[2] ? `${process.argv[2]}-` : '';
  const dest = path.join(__dirname, '..', 'data', `bot.sqlite.bak-${label}${timestamp()}`);
  await db.backup(dest);
  console.log(`Backed up to ${dest}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => db.close());
}
