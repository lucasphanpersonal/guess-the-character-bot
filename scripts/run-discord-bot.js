// Runs the Discord bot with everything it prints also appended to data/discord-bot.log, one
// timestamp per line: `node scripts/run-discord-bot.js`. For the scheduled task, which has no
// console -- without this, "why did the bot go down" has no answer.
//
// In-process on purpose. The obvious way to capture output is a `cmd /c node ... >> log`
// wrapper, but that makes cmd.exe the task's process: kill the wrapper and node keeps running as
// an orphan while Task Scheduler reports the task stopped, so the five-minute watchdog in
// install-autostart.ps1 starts a SECOND bot and every slash command gets handled twice. That was
// tested, not assumed. Requiring the bot from here keeps it the task's one and only process.

const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '..', 'data', 'discord-bot.log');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const fd = fs.openSync(LOG, 'a');

// Synchronous writes, so the last lines before a process.exit() or a crash are on disk rather
// than in a buffer that died with the process -- those are the lines this file exists for.
// Stamped per line rather than per chunk: one chunk can hold several lines, or half of one.
let atLineStart = true;
function append(chunk) {
  const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
  let out = '';
  for (const piece of text.split(/(?<=\n)/)) {
    if (!piece) continue;
    if (atLineStart) out += `${new Date().toISOString()} `;
    out += piece;
    atLineStart = piece.endsWith('\n');
  }
  try {
    fs.writeSync(fd, out);
  } catch {
    /* a full disk must not take the bot down with it */
  }
}

for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    append(chunk);
    return write(chunk, ...rest);
  };
}

// Node prints a fatal exception straight to the stderr handle, not through the write above, so a
// crash -- the thing this log most needs -- would otherwise be missing from it. The Monitor
// variant only observes; it does not change whether the process dies.
process.on('uncaughtExceptionMonitor', (err, origin) => append(`FATAL (${origin}): ${err?.stack || err}\n`));
// A clean shutdown and a crash both leave a line here; a process that was killed outright
// leaves none, which is itself the answer.
process.on('exit', (code) => append(`--- exited with code ${code} ---\n`));

console.log(`--- starting (pid ${process.pid}) ---`);
require('../src/discord/index.js');
