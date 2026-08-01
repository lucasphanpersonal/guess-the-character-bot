// Wall-clock safety net for the two deadlines the bot runs on: the turn timer and the
// audience-vote auto-close.
//
// Both are plain setTimeout calls, and this bot runs on a personal desktop that sleeps. A
// sleeping machine doesn't run timers, so a 90-second turn started before the lid closes can
// come back due minutes or hours later -- or, depending on how the platform accounts for
// suspended time, fire in a burst on wake. Either way the countdown on screen (which is
// derived from Date.now(), so it stays honest) disagrees with the timer that's supposed to
// enforce it.
//
// This pass runs every few seconds and enforces the deadline from the wall clock instead:
// anything already past due is expired now. It's a supplement, not a replacement -- in the
// normal case the setTimeout still wins the race, and this finds nothing to do.

const GameManager = require('./GameManager');
const engine = require('./engine');

const CHECK_INTERVAL_MS = 5000;

let handle = null;

/**
 * One pass over every lobby. Exported for the tests, which drive it directly rather than
 * waiting on an interval.
 */
async function checkOverdue(client, now = Date.now()) {
  const expired = { turns: 0, votes: 0 };

  for (const lobby of GameManager.allLobbies()) {
    const vote = lobby.vote;
    if (vote && !vote.closed && lobby.status === 'VOTING' && now >= vote.endsAt) {
      expired.votes++;
      // closeAudienceVote clears the pending timer itself and is idempotent, so a late
      // setTimeout arriving afterwards is a no-op.
      await engine.closeAudienceVote(client, lobby, { reason: 'timer' }).catch((err) => console.error(err));
      continue;
    }

    const game = lobby.game;
    if (!game || game.finished || lobby.status !== 'IN_PROGRESS') continue;
    // `paused` is the state handleTimeout puts the turn in, so this can't fire twice.
    if (game.paused) continue;
    const expiresAt = game.timer?.expiresAt() ?? null;
    if (expiresAt === null || now < expiresAt) continue;

    expired.turns++;
    // Drop the pending setTimeout so it can't run handleTimeout a second time on wake.
    game.timer.clear();
    await engine.handleTimeout(client, lobby).catch((err) => console.error(err));
  }

  return expired;
}

function start(client, intervalMs = CHECK_INTERVAL_MS) {
  if (handle) return;
  handle = setInterval(() => {
    checkOverdue(client).catch((err) => console.error('[timerWatchdog]', err));
  }, intervalMs);
  // Nothing here should hold the process open on its own.
  handle.unref?.();
}

function stop() {
  if (handle) clearInterval(handle);
  handle = null;
}

module.exports = { checkOverdue, start, stop, CHECK_INTERVAL_MS };
