// Starts both frontends at once: `npm run start:all`.
//
//   npm run start:all                  # web (HTTP) + Discord bot
//   npm run start:all -- --secure      # web also on HTTPS :4443 -- needed for tilt on phones
//   npm run start:all -- --tunnel      # ...plus a Cloudflare tunnel, for playing off the LAN
//   npm run start:all -- --no-discord  # web only
//
// The two frontends are separate long-running processes sharing one SQLite file, which is why
// this exists at all: running them by hand means two or three terminals and remembering which
// flag belongs to which. Output is prefixed per process so one scrollback stays readable, and
// Ctrl+C takes everything down together.
//
// A child dying does NOT kill its siblings. The common case is the Discord bot exiting because
// its token is missing or rejected, and taking a working web app down with it -- mid-party --
// would be the wrong call. Each exit is reported and the rest keep running.

require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const secure = has('secure');
const wantWeb = !has('no-web');
const wantDiscord = !has('no-discord');
const wantTunnel = has('tunnel');

const ROOT = path.join(__dirname, '..');
// ANSI colours keep the interleaved output legible; harmless if the terminal ignores them.
const COLOURS = { web: '\x1b[36m', discord: '\x1b[35m', tunnel: '\x1b[33m', sys: '\x1b[90m' };
const RESET = '\x1b[0m';

const children = [];
let shuttingDown = false;

function say(tag, line) {
  process.stdout.write(`${COLOURS[tag] || ''}[${tag}]${RESET} ${line}\n`);
}

/**
 * Spawns one child and pipes its output through a prefix.
 *
 * Line-buffered rather than chunk-forwarded: a chunk can split mid-line, which would put the
 * prefix in the middle of a sentence and interleave badly once three processes are talking.
 */
function start(tag, command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffered = '';
  const onData = (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    // The web server tags its own lines `[web]` so it reads well when run on its own; through
    // here that doubles up into "[web] [web] …". Strip the child's copy — this process is
    // already labelling every line.
    for (const line of lines) if (line.trim()) say(tag, line.replace(new RegExp(`^\\[${tag}\\]\\s?`), ''));
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('error', (err) => say(tag, `could not start: ${err.message}`));
  child.on('exit', (code, signal) => {
    if (buffered.trim()) say(tag, buffered.trim());
    // Ctrl+C signals the whole console process group, so children usually die BEFORE the parent's
    // handler runs -- checking `shuttingDown` alone therefore reported a normal shutdown as an
    // unexpected exit, complete with a token hint that had nothing to do with it. A
    // signal-terminated child is being stopped, not failing. (143 = 128+SIGTERM, 130 = 128+SIGINT,
    // which is how a shell reports the same thing when no signal name reaches us.)
    const stopped = shuttingDown || signal === 'SIGTERM' || signal === 'SIGINT' || code === 143 || code === 130;
    if (stopped) return;
    say('sys', `${tag} exited (${signal || `code ${code}`}) — the others are still running.`);
    if (tag === 'discord' && code !== 0) {
      say('sys', 'If that was the token: check DISCORD_TOKEN in .env, then re-run.');
    }
  });

  children.push({ tag, child });
  return child;
}

if (wantWeb) {
  start('web', process.execPath, [path.join('src', 'web', 'server.js')], secure ? { WEB_HTTPS: '1' } : {});
}

if (wantDiscord) {
  if (!process.env.DISCORD_TOKEN) {
    say('sys', 'DISCORD_TOKEN is not set, so the bot is skipped. Web app only. (--no-discord to silence this.)');
  } else {
    start('discord', process.execPath, [path.join('src', 'discord', 'index.js')]);
  }
}

if (wantTunnel) {
  // The tunnel points at the plain HTTP port on purpose: Cloudflare terminates TLS itself, and
  // pointing it at the self-signed HTTPS listener would just make it distrust the certificate.
  //
  // 127.0.0.1 rather than `localhost`: the server binds 0.0.0.0, which is IPv4 only, while
  // `localhost` resolves to ::1 first on Windows -- so cloudflared dials an address nothing is
  // listening on and reports "the target machine actively refused it" as though the server were
  // down. Naming the IPv4 address removes the ambiguity.
  const port = process.env.WEB_PORT || 4180;
  start('tunnel', 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
  say('sys', 'Watch the tunnel lines for the https://<name>.trycloudflare.com URL to share.');
}

if (!children.length) {
  say('sys', 'Nothing to start. Drop --no-web / --no-discord, or set DISCORD_TOKEN.');
  process.exit(1);
}

say('sys', `started ${children.map((c) => c.tag).join(' + ')} — Ctrl+C stops everything`);
if (wantWeb && !secure) {
  say('sys', 'Tilt controls and the screen wake lock need HTTPS: add --secure (or --tunnel).');
}

// One Ctrl+C should take the whole set down, not leave orphans holding ports 4180/4443.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('sys', `${signal} — stopping ${children.length} process(es)…`);
  for (const { child } of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  // Don't hang forever if something ignores the signal.
  setTimeout(() => process.exit(0), 3000).unref();
  let left = children.length;
  for (const { child } of children) {
    child.on('exit', () => {
      if (--left === 0) process.exit(0);
    });
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
