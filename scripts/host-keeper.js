// The host keeper: run every two minutes by a scheduled task on the machine that serves the site
// (scripts/install-autostart.ps1). Each run does two jobs and exits:
//
//   1. Deploys main. It fetches origin/main and, when main has moved, fast-forwards the checkout,
//      runs `npm ci` if the lockfile changed, and restarts the site -- but only once nobody would
//      lose a game by it: a restart throws away every room. A change that touches only docs or
//      tests is pulled without a restart.
//   2. Restarts a site that is running but not answering. The launcher task's own five-minute
//      watchdog brings back a launcher that has EXITED; it cannot see one that is still running
//      but no longer serving (a hung server, a tunnel that stopped carrying traffic). This checks
//      /api/health on this machine, and through the tunnel's public hostname.
//
//   node scripts/host-keeper.js            # one run, as the task does it
//   node scripts/host-keeper.js --dry-run  # say what it would do, change nothing
//
// The log is data/host-keeper/keeper.log. The decisions are scripts/lib/hostKeeper.js, which has
// the reasons behind each threshold; this file is the I/O.
//
// Windows only, because restarting means the scheduled task: the keeper never starts a server
// itself, since one started outside the task is invisible to the task's watchdog, which then
// starts a second that loses the race for the port (CLAUDE.md, "Never leave a detached server
// running"). It stops the launcher by asking (STOP_REQUEST), then starts the task again.
//
// It does nothing at all while the launcher task is disabled or missing: that is how a person
// says "this machine is not hosting right now" (moving hosts, or working on the server by hand).

// Optional on purpose: this is the process that repairs node_modules (npm ci, and the roll-back
// after a failed one), so it must still run when node_modules is missing or broken.
try {
  require('dotenv').config();
} catch {
  /* WEB_PORT and KEEPER_PUBLIC_URL fall back to their defaults */
}

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { KEEPER_DIR, STOP_REQUEST, planDeploy, checkHealth } = require('./lib/hostKeeper');
const { namedTunnel } = require('./lib/tunnelConfig');

const ROOT = path.join(__dirname, '..');
// The launcher's task, as install-autostart.ps1 names it.
const TASK = 'Guess the Character';
const PORT = process.env.WEB_PORT || 4180;
const LOCAL_HEALTH = `http://127.0.0.1:${PORT}/api/health`;
const DRY = process.argv.includes('--dry-run');

const LOG = path.join(KEEPER_DIR, 'keeper.log');
const STATE = path.join(KEEPER_DIR, 'state.json');
const LOG_MAX_BYTES = 1024 * 1024;

fs.mkdirSync(KEEPER_DIR, { recursive: true });

function log(line) {
  const stamped = `${new Date().toISOString()} ${DRY ? '[dry run] ' : ''}${line}`;
  console.log(stamped);
  if (DRY) return;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > LOG_MAX_BYTES) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, `${stamped}\n`);
  } catch {
    /* a log that cannot be written must not stop the keeper doing its job */
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  if (DRY) return;
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE);
}

// A message that would otherwise repeat every two minutes (waiting, skipping) is logged once,
// until something else is said.
function note(state, line) {
  if (state.lastNote === line) return;
  state.lastNote = line;
  log(line);
}
function say(state, line) {
  state.lastNote = null;
  log(line);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file, args, timeout = 2 * 60 * 1000) {
  return execFileSync(file, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // The task has no one to answer a prompt: a git asking for credentials would hang every run.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  }).trim();
}
const git = (...args) => run('git', args);

/** The launcher task's state: Ready, Running, Disabled, Queued, or Missing. */
function taskState() {
  // Get-ScheduledTask's State is an enum, so it reads the same on any Windows language, which
  // schtasks' "Status" column does not.
  const ps = `$t = Get-ScheduledTask -TaskName '${TASK}' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'Missing' }`;
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
}
function taskDo(cmdlet) {
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `${cmdlet} -TaskName '${TASK}'`]);
}

async function health(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'gtc-host-keeper' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok ? body : null;
  } catch {
    return null;
  }
}

async function waitFor(test, timeoutMs, everyMs = 1000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= until) return false;
    await sleep(everyMs);
  }
}

/** Stops the launcher and everything it runs. False if something is still serving the port. */
async function stopSite(state) {
  if (taskState() === 'Running') {
    fs.writeFileSync(STOP_REQUEST, new Date().toISOString());
    const stopped = await waitFor(() => taskState() !== 'Running', 30_000);
    if (!stopped) {
      say(state, 'The launcher did not stop when asked; ending its task.');
      taskDo('Stop-ScheduledTask');
      await waitFor(() => taskState() !== 'Running', 10_000);
    }
  }
  fs.rmSync(STOP_REQUEST, { force: true });
  const portFree = await waitFor(async () => !(await health(LOCAL_HEALTH, 3000)), 15_000);
  if (!portFree) {
    say(state, `Something outside the task is still answering on :${PORT} (a launcher started by hand?). Not starting a second one; stop it, and the next run will.`);
  }
  return portFree;
}

async function startSite(state) {
  taskDo('Start-ScheduledTask');
  state.startedAt = Date.now();
  const up = await waitFor(async () => !!(await health(LOCAL_HEALTH, 3000)), 90_000, 3000);
  say(state, up ? 'The site is answering again.' : 'The site has not answered within 90s of starting; the next runs will keep checking.');
  return up;
}

/** Restart, optionally deploying `target` on the way: stop, fast-forward, install, start. */
async function restart(state, { target, head, install } = {}) {
  if (!(await stopSite(state))) return;
  if (target) {
    try {
      git('merge', '--ff-only', '--quiet', target);
    } catch (err) {
      say(state, `Could not fast-forward to ${target.slice(0, 7)}: ${firstLine(err)}. Starting the site on ${head.slice(0, 7)}.`);
      state.failedTarget = target;
      return startSite(state);
    }
    if (install && !npmCi(state)) {
      // node_modules is in an unknown state now, and the code needs what it failed to install.
      // Step back to the commit that was running (reset --keep refuses to touch local changes,
      // and there are none: planDeploy checked) and install what that one needs.
      state.failedTarget = target;
      try {
        git('reset', '--keep', head);
        say(state, `Rolled back to ${head.slice(0, 7)}.`);
        npmCi(state);
      } catch (err) {
        say(state, `Could not roll back to ${head.slice(0, 7)}: ${firstLine(err)}`);
      }
      return startSite(state);
    }
    say(state, `Deployed ${target.slice(0, 7)}${install ? ' (with npm ci)' : ''}.`);
  }
  return startSite(state);
}

function npmCi(state) {
  try {
    // A shell, because npm is npm.cmd on Windows and Node will not run a .cmd without one.
    execSync('npm ci --no-audit --no-fund', { cwd: ROOT, timeout: 15 * 60 * 1000, windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (err) {
    say(state, `npm ci failed: ${firstLine(err)}`);
    return false;
  }
}

function firstLine(err) {
  const text = String(err.stderr || err.message || err).trim();
  return text.split(/\r?\n/).find(Boolean) || 'unknown error';
}

/** What git says about main: everything planDeploy needs except health and the clock. */
function lookAtMain() {
  git('fetch', '--quiet', 'origin', 'main');
  const head = git('rev-parse', 'HEAD');
  const target = git('rev-parse', 'origin/main');
  const onMain = git('rev-parse', '--abbrev-ref', 'HEAD') === 'main';
  let fastForward = true;
  try {
    git('merge-base', '--is-ancestor', head, target);
  } catch {
    fastForward = false;
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  const files = head === target ? [] : git('diff', '--name-only', head, target).split(/\r?\n/).filter(Boolean);
  return { head, target, onMain, fastForward, dirty, files };
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('The host keeper drives a Windows scheduled task; on this machine there is nothing for it to do.');
    return;
  }
  const state = loadState();
  const task = taskState();
  if (task === 'Missing' || task === 'Disabled') {
    note(state, `The '${TASK}' task is ${task.toLowerCase()}, so this machine is not hosting; doing nothing.`);
    return saveState(state);
  }

  const local = await health(LOCAL_HEALTH);

  // 1. Deploy main.
  let repo;
  try {
    repo = lookAtMain();
  } catch (err) {
    // Offline, or GitHub is: the health check below still runs.
    note(state, `Could not check main: ${firstLine(err)}`);
  }
  if (repo) {
    const plan = planDeploy({ ...repo, health: local, now: Date.now() }, state);
    if (plan.action !== 'wait') delete state.waitingFor;
    if (plan.action === 'skip') note(state, `Not deploying: ${plan.reason}.`);
    if (plan.action === 'wait') {
      if (state.waitingFor !== repo.target) Object.assign(state, { waitingFor: repo.target, waitingSince: Date.now() });
      note(state, `Not restarting yet: ${plan.reason}.`);
    }
    if (plan.action === 'pull') {
      if (DRY) log(`Would fast-forward to ${repo.target.slice(0, 7)} (${plan.reason}).`);
      else {
        try {
          git('merge', '--ff-only', '--quiet', repo.target);
          say(state, `Pulled ${repo.target.slice(0, 7)}; ${plan.reason}, so no restart.`);
        } catch (err) {
          state.failedTarget = repo.target;
          say(state, `Could not fast-forward to ${repo.target.slice(0, 7)}: ${firstLine(err)}`);
        }
      }
    }
    if (plan.action === 'deploy') {
      say(state, `Deploying ${plan.reason}${plan.install ? ' (lockfile changed: npm ci)' : ''}.`);
      if (repo.files.includes('scripts/install-autostart.ps1')) {
        say(state, 'This change edits scripts/install-autostart.ps1; the tasks are not re-registered automatically, so re-run it.');
      }
      if (!DRY) await restart(state, { ...repo, install: plan.install });
      return saveState(state);
    }
  }

  // 2. Health. Only while the launcher runs: when it has exited, its own watchdog starts it.
  if (task !== 'Running') return saveState(state);
  const tunnel = namedTunnel(PORT);
  const publicUrl = process.env.KEEPER_PUBLIC_URL || (tunnel?.hostname ? `https://${tunnel.hostname}/api/health` : null);
  const pub = local && publicUrl && publicUrl !== 'off' ? !!(await health(publicUrl, 15_000)) : null;
  const before = { localFailures: state.localFailures || 0, publicFailures: state.publicFailures || 0 };
  const result = checkHealth({ local, public: pub, now: Date.now() }, state);
  Object.assign(state, result.state);
  if (!local) say(state, `No answer from ${LOCAL_HEALTH} (${state.localFailures || 'restarting'}).`);
  else if (pub === false) say(state, `No answer from ${publicUrl} (${state.publicFailures || 'restarting'}).`);
  else if (before.localFailures || before.publicFailures) say(state, 'Healthy again.');
  if (result.restart) {
    say(state, `Restarting: ${result.restart}.`);
    if (!DRY) await restart(state);
  }
  saveState(state);
}

main().catch((err) => {
  log(`The keeper failed: ${err.stack || err}`);
  process.exitCode = 1;
});
