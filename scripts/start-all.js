// Starts both frontends at once: `npm run start:all`.
//
//   npm run start:all                  # web (HTTP) + Discord bot
//   npm run start:all -- --secure      # web also on HTTPS :4443 -- needed for tilt on phones
//   npm run start:all -- --tunnel      # ...plus a Cloudflare tunnel, for playing off the LAN
//   npm run start:all -- --no-discord  # web only
//
// --tunnel prefers the NAMED tunnel in ~/.cloudflared/config.yml when one is configured, so the
// address is the same every launch; with no config it falls back to a quick tunnel and its
// throwaway random hostname. If cloudflared is already running that same tunnel as a Windows
// service it is left alone rather than given a second connector.
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

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

/**
 * The hostname routed to OUR port, rather than whichever `hostname:` happens to come first.
 *
 * One tunnel can front several services -- a `hostname: files.example / service: http://…:3000`
 * rule sitting above ours is an ordinary config -- so the first hostname in the file is not
 * necessarily this app's. Printing that one as the address to share sends the party to someone
 * else's site, so match the rule by the port its `service:` dials and only fall back to "the
 * first hostname" when nothing routes here.
 */
function ingressHostname(cfg, port) {
  // Only the ingress block: a `- ` elsewhere in the file is some other list, not a routing rule.
  const rules = (cfg.split(/^ingress:[ \t]*$/m)[1] ?? '').split(/^\s*-\s+/m).slice(1);
  const field = (rule, key) => rule.match(new RegExp(`\\b${key}:\\s*(\\S+)`))?.[1] ?? null;
  // Substring rather than regex: WEB_PORT is whatever the environment says, and a port with a
  // regex metacharacter in it would otherwise match the wrong rule (or throw).
  const dialsUs = (rule) => {
    const service = field(rule, 'service') ?? '';
    return service.endsWith(`:${port}`) || service.endsWith(`:${port}/`);
  };
  const hosted = rules.filter((r) => field(r, 'hostname'));
  return field(hosted.find(dialsUs) ?? hosted[0] ?? '', 'hostname');
}

/**
 * The configured named tunnel as `{ name, hostname }`, or null if there isn't one.
 *
 * A quick tunnel mints a fresh random hostname on every launch, which is fine for one party and
 * useless as an address: the link you handed out last week is already dead. Once
 * `cloudflared tunnel login` and `tunnel create` have been run there is a `config.yml` naming a
 * persistent tunnel and the hostname routed to it, so prefer that whenever it exists.
 *
 * Read with a regex rather than a YAML dependency -- a handful of scalars do not justify a
 * parser -- and any failure falls through to the quick tunnel instead of taking the launcher
 * down with it.
 */
function namedTunnel(port) {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.cloudflared', 'config.yml'), 'utf8');
    const name = cfg.match(/^\s*tunnel:\s*(\S+)/m)?.[1];
    // `<UUID>` still sitting there means the template was copied but never filled in. cloudflared
    // reports that as a credentials error much further along, so catch it here where it is obvious.
    if (!name || name.startsWith('<')) return null;
    return { name, hostname: ingressHostname(cfg, port) };
  } catch {
    return null;
  }
}

/**
 * Is the cloudflared service already carrying that tunnel?
 *
 * `cloudflared service install` is the whole point of a permanent domain -- it brings the tunnel
 * up at boot, without this launcher -- but it also means `--tunnel` here would open a SECOND
 * connector for the same tunnel. Cloudflare load-balances across connectors, so nothing fails
 * loudly; you just get doubled logs and a site that stays up when you stop what looks like the
 * only tunnel, which is a confusing thing to debug at a party.
 *
 * "A service named cloudflared is RUNNING" is NOT the question, and answering that one instead
 * cost an evening: a botched `service install` can leave a bare cloudflared.exe registered with
 * no config and no `tunnel run`, which reports RUNNING forever while serving nothing. Skipping
 * our own connector on that signal takes the site down and blames the web server. So require the
 * service's command line to actually name a tunnel before believing it.
 *
 * Nor is "some tunnel" the question. `cloudflared tunnel run <name>` spells out which one, and a
 * service carrying somebody else's tunnel must not stop us starting ours -- that is the same
 * dark-site failure by a different route. A service that takes its tunnel from its own config,
 * or from an opaque `--token`, names nothing we can compare: that copy lives under System32
 * where we cannot read it, so the doubled-connector cost is accepted over guessing.
 */
function tunnelServedByService(name) {
  if (process.platform !== 'win32') return false;
  const sc = (argv) => execFileSync('sc', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const cmd = sc(['qc', 'cloudflared']).match(/^\s*BINARY_PATH_NAME\s*:(.*)$/mi)?.[1] ?? '';
    if (!/\btunnel\b|--token/i.test(cmd)) return false;
    const runs = cmd.match(/\brun\s+(?!-)(\S+)/i)?.[1].replace(/^"|"$/g, '');
    if (runs && runs !== name) return false;
    return /\bRUNNING\b/.test(sc(['query', 'cloudflared']));
  } catch {
    return false; // not installed, or sc refused -- treat as "ours to start"
  }
}

if (wantTunnel) {
  const port = process.env.WEB_PORT || 4180;
  const named = namedTunnel(port);
  if (named && tunnelServedByService(named.name)) {
    // Deliberately vague about WHICH tunnel: where the service names none we did not confirm it
    // is this one, and a launcher that states more than it checked is how the evening above went.
    const where = named.hostname ? ` on https://${named.hostname}` : '';
    say('sys', `cloudflared is already running as a service${where} — not starting a second connector.`);
  } else if (named) {
    // `tunnel run` takes its ingress from config.yml, which carries the same 127.0.0.1 rule
    // spelled out below, so there is no --url to pass here. --no-autoupdate for the reason the
    // quick tunnel passes it: a connector that restarts itself to update drops the party with it.
    start('tunnel', 'cloudflared', ['tunnel', '--no-autoupdate', 'run', named.name]);
    say('sys', named.hostname ? `Tunnel: https://${named.hostname}` : `Running named tunnel ${named.name}.`);
  } else {
    // The tunnel points at the plain HTTP port on purpose: Cloudflare terminates TLS itself, and
    // pointing it at the self-signed HTTPS listener would just make it distrust the certificate.
    //
    // 127.0.0.1 rather than `localhost`: the server binds 0.0.0.0, which is IPv4 only, while
    // `localhost` resolves to ::1 first on Windows -- so cloudflared dials an address nothing is
    // listening on and reports "the target machine actively refused it" as though the server were
    // down. Naming the IPv4 address removes the ambiguity.
    start('tunnel', 'cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate']);
    say('sys', 'Watch the tunnel lines for the https://<name>.trycloudflare.com URL to share.');
  }
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
