// The host keeper's decisions, kept apart from its I/O (scripts/host-keeper.js) so they can be
// tested: when a merge to main gets pulled, when that means a restart, when a restart has to wait
// for a party to finish, and when a server that has stopped answering gets restarted.
//
// Everything here is a pure function of what the keeper saw this tick plus the state it saved
// last tick. Nothing reads the clock, the network or git.

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// Machine-local, gitignored: the log, the state between ticks, and the launcher's stop request.
const KEEPER_DIR = path.join(ROOT, 'data', 'host-keeper');
// The keeper's only way to stop the launcher cleanly. Windows has no signal one process can send
// another and have handled -- process.kill() there is TerminateProcess -- and ending the scheduled
// task is not reliable either: Task Scheduler stops the process it started, and may leave that
// process's children (the web server, cloudflared) running, holding the port. So the launcher
// watches for this file, deletes it, stops its children and exits 0 (scripts/start-all.js).
const STOP_REQUEST = path.join(KEEPER_DIR, 'stop-launcher');

const MINUTE = 60 * 1000;

const LIMITS = {
  // Consecutive failed checks before acting. The keeper runs every two minutes, so a server that
  // stops answering locally is restarted within about six; a one-off slow answer never is.
  localFailures: 3,
  publicFailures: 3,
  // After the keeper starts the site it gives the server and the tunnel this long to come up
  // before judging them.
  graceMs: 3 * MINUTE,
  // A restart for the PUBLIC check failing (the local one passing) is the weak case: the usual
  // cause is the machine's internet or Cloudflare, which no restart fixes, and a restart every six
  // minutes through an outage would throw away games people on the LAN can still play. So it waits
  // for the rooms to be empty, and happens at most once an hour.
  publicRestartEveryMs: 60 * MINUTE,
  // A deploy waits for nobody to be in a room. A tab left open on a lobby is somebody to the
  // server, and keeps a room for as long as it stays open -- possibly days -- so after this long
  // waiting only a game in progress holds the deploy back.
  waitForEmptyMs: 3 * 60 * MINUTE,
};

/**
 * Does a change to these files need the server restarted to take effect?
 *
 * Only when every file is one the running server never reads does a pull alone finish the deploy.
 * The served client (src/web/.../public) is NOT one of them, although the server reads it from
 * disk per request: a page from the new client talking to the old server is exactly the mismatch
 * a deploy has to avoid, so it ships with a restart like any other code.
 */
function needsRestart(files) {
  const inert = (f) => /\.md$/i.test(f) || /^(docs|test|\.github)\//.test(f) || f === 'LICENSE' || f === '.gitignore';
  return files.some((f) => !inert(f));
}

/** Did this change move the dependencies? Then the deploy runs `npm ci`, with the server stopped. */
function needsInstall(files) {
  return files.includes('package-lock.json') || files.includes('package.json');
}

/**
 * What to do about main this tick.
 *
 * @param {object} seen
 *   head, target: the checkout's commit and origin/main's.
 *   onMain: the checkout is on branch main.
 *   fastForward: head is an ancestor of target, so `merge --ff-only` can take it.
 *   dirty: tracked files have local changes.
 *   files: what differs between head and target.
 *   health: /api/health's body, or null when the server did not answer.
 *   now: ms.
 * @param {object} state  The keeper's saved state (see host-keeper.js).
 * @returns {{ action: 'none'|'skip'|'pull'|'wait'|'deploy', reason: string, install?: boolean }}
 *   pull: fast-forward only, nothing restarts. deploy: stop, fast-forward, maybe install, start.
 */
function planDeploy(seen, state) {
  const { head, target, onMain, fastForward, dirty, files, health, now } = seen;
  if (!target || head === target) return { action: 'none', reason: 'up to date' };
  const short = target.slice(0, 7);
  // Each of these needs a person. The keeper never resets, stashes or force-checks-out: the
  // checkout may hold something someone is in the middle of.
  if (!onMain) return { action: 'skip', reason: `the checkout is not on main, so ${short} waits` };
  if (!fastForward) return { action: 'skip', reason: `the checkout has commits main does not, so ${short} cannot be fast-forwarded` };
  if (dirty) return { action: 'skip', reason: `the checkout has local changes, so ${short} waits` };
  if (state.failedTarget === target) {
    return { action: 'skip', reason: `deploying ${short} failed (see above); waiting for the next merge` };
  }
  if (!needsRestart(files)) return { action: 'pull', reason: `${short} changes no running code` };

  const install = needsInstall(files);
  // No answer means nothing to protect: the server is down or hung, and a deploy restarts it.
  if (!health) return { action: 'deploy', reason: `${short}, and the server is not answering`, install };
  const waitedMs = state.waitingFor === target && state.waitingSince ? now - state.waitingSince : 0;
  const { occupied = 0, inGame = 0 } = health;
  if (inGame > 0) return { action: 'wait', reason: `${short} waits: ${inGame} game(s) in progress`, install };
  if (occupied > 0 && waitedMs < LIMITS.waitForEmptyMs) {
    return { action: 'wait', reason: `${short} waits: ${occupied} room(s) with people in them`, install };
  }
  return { action: 'deploy', reason: occupied > 0 ? `${short}, after waiting 3h for idle rooms to empty` : short, install };
}

/**
 * Is the site healthy, and if not, is it time to restart it?
 *
 * @param {object} seen
 *   local: /api/health's body on 127.0.0.1, or null.
 *   public: true/false for the tunnel's public hostname, or null when there is none to check.
 *   now: ms.
 * @param {object} state  The saved state; only its health fields are read.
 * @returns {{ restart: string|null, state: object }}  restart is the reason, when there is one.
 *   `state` is the health fields to save: localFailures, publicFailures, lastPublicRestart.
 */
function checkHealth(seen, state) {
  const { local, now } = seen;
  const next = {
    localFailures: local ? 0 : (state.localFailures || 0) + 1,
    // Only counted while the server answers locally: otherwise it is the local failure again.
    publicFailures: local && seen.public === false ? (state.publicFailures || 0) + 1 : 0,
    lastPublicRestart: state.lastPublicRestart || 0,
  };
  if (state.startedAt && now - state.startedAt < LIMITS.graceMs) {
    return { restart: null, state: { ...next, localFailures: 0, publicFailures: 0 } };
  }
  if (next.localFailures >= LIMITS.localFailures) {
    return {
      restart: `the server has not answered on this machine ${next.localFailures} times in a row`,
      state: { ...next, localFailures: 0, publicFailures: 0 },
    };
  }
  if (
    next.publicFailures >= LIMITS.publicFailures &&
    !local.occupied &&
    now - next.lastPublicRestart >= LIMITS.publicRestartEveryMs
  ) {
    return {
      restart: `the site has not answered through the tunnel ${next.publicFailures} times in a row`,
      state: { ...next, localFailures: 0, publicFailures: 0, lastPublicRestart: now },
    };
  }
  return { restart: null, state: next };
}

module.exports = { KEEPER_DIR, STOP_REQUEST, LIMITS, needsRestart, needsInstall, planDeploy, checkHealth };
