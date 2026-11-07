// The host keeper's decisions (scripts/lib/hostKeeper.js): when a merge is pulled, when that
// restarts the site, when a restart waits for a party, and when a silent server is restarted.

const { assert } = require('./harness');
const { LIMITS, needsRestart, needsInstall, planDeploy, checkHealth } = require('../scripts/lib/hostKeeper');

const HEAD = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const idle = { ok: true, rooms: 0, occupied: 0, inGame: 0 };
const seen = (over = {}) => ({
  head: HEAD,
  target: TARGET,
  onMain: true,
  fastForward: true,
  dirty: false,
  files: ['src/web/server.js'],
  health: idle,
  now: 1_000_000_000,
  ...over,
});

module.exports = {
  'only docs, tests and CI config are pulled without a restart'() {
    assert.equal(needsRestart(['README.md', 'docs/compendium.md', 'test/x.test.js', '.github/workflows/ci.yml']), false);
    assert.equal(needsRestart(['README.md', 'src/web/server.js']), true);
    // The served client is code too: a new page talking to the old server is the mismatch to avoid.
    assert.equal(needsRestart(['src/web/party/public/app.js']), true);
    assert.equal(needsRestart(['scripts/start-all.js']), true);
  },

  'a lockfile or package.json change means npm ci'() {
    assert.equal(needsInstall(['package-lock.json']), true);
    assert.equal(needsInstall(['package.json']), true);
    assert.equal(needsInstall(['src/web/server.js']), false);
  },

  'nothing to do when the checkout is main'() {
    assert.equal(planDeploy(seen({ target: HEAD }), {}).action, 'none');
  },

  'a checkout someone is working in is never touched'() {
    assert.equal(planDeploy(seen({ onMain: false }), {}).action, 'skip');
    assert.equal(planDeploy(seen({ fastForward: false }), {}).action, 'skip');
    assert.equal(planDeploy(seen({ dirty: true }), {}).action, 'skip');
  },

  'a merge that failed to deploy is not retried until main moves again'() {
    assert.equal(planDeploy(seen(), { failedTarget: TARGET }).action, 'skip');
    assert.equal(planDeploy(seen(), { failedTarget: 'c'.repeat(40) }).action, 'deploy');
  },

  'a docs-only merge is pulled even mid-game'() {
    const plan = planDeploy(seen({ files: ['docs/architecture.md'], health: { ...idle, occupied: 2, inGame: 1 } }), {});
    assert.equal(plan.action, 'pull');
  },

  'code deploys straight away when nobody is in a room'() {
    const plan = planDeploy(seen({ files: ['src/web/server.js', 'package-lock.json'] }), {});
    assert.deepEqual([plan.action, plan.install], ['deploy', true]);
    // Rooms everyone has left are still in memory until the sweep; they are nobody's game.
    assert.equal(planDeploy(seen({ health: { ...idle, rooms: 3 } }), {}).action, 'deploy');
  },

  'a server that does not answer is deployed to, since there is nothing to protect'() {
    assert.equal(planDeploy(seen({ health: null }), {}).action, 'deploy');
  },

  'a game in progress holds a deploy for as long as it lasts'() {
    const busy = seen({ health: { ...idle, occupied: 1, inGame: 1 } });
    assert.equal(planDeploy(busy, {}).action, 'wait');
    const longAgo = { waitingFor: TARGET, waitingSince: busy.now - 24 * 60 * 60 * 1000 };
    assert.equal(planDeploy(busy, longAgo).action, 'wait');
  },

  'an occupied lobby holds a deploy, but not forever'() {
    const lobby = seen({ health: { ...idle, occupied: 1 } });
    assert.equal(planDeploy(lobby, {}).action, 'wait');
    const almost = { waitingFor: TARGET, waitingSince: lobby.now - LIMITS.waitForEmptyMs + 1 };
    assert.equal(planDeploy(lobby, almost).action, 'wait');
    const waited = { waitingFor: TARGET, waitingSince: lobby.now - LIMITS.waitForEmptyMs };
    assert.equal(planDeploy(lobby, waited).action, 'deploy');
    // The wait is per merge: time spent waiting on an earlier one does not count for a newer one.
    const earlier = { waitingFor: 'c'.repeat(40), waitingSince: lobby.now - LIMITS.waitForEmptyMs };
    assert.equal(planDeploy(lobby, earlier).action, 'wait');
  },

  'a server that stops answering is restarted after several checks in a row, not one'() {
    const now = 1_000_000_000;
    let state = {};
    for (let i = 1; i < LIMITS.localFailures; i++) {
      const r = checkHealth({ local: null, public: null, now }, state);
      assert.equal(r.restart, null, `failure ${i}`);
      state = r.state;
    }
    const r = checkHealth({ local: null, public: null, now }, state);
    assert.match(r.restart, /not answered on this machine/);
    assert.equal(r.state.localFailures, 0, 'the count starts over after a restart');
    // One good answer in between starts the count over.
    const healed = checkHealth({ local: idle, public: true, now }, { localFailures: LIMITS.localFailures - 1 });
    assert.deepEqual([healed.restart, healed.state.localFailures], [null, 0]);
  },

  'nothing is judged while a site the keeper just started comes up'() {
    const now = 1_000_000_000;
    const r = checkHealth({ local: null, public: null, now }, { startedAt: now - 1000, localFailures: 99 });
    assert.deepEqual([r.restart, r.state.localFailures], [null, 0]);
  },

  'the tunnel failing restarts only an empty site, and at most once an hour'() {
    const now = 10 * LIMITS.publicRestartEveryMs;
    const failing = { publicFailures: LIMITS.publicFailures - 1 };
    const r = checkHealth({ local: idle, public: false, now }, failing);
    assert.match(r.restart, /through the tunnel/);
    assert.equal(r.state.lastPublicRestart, now);
    const again = checkHealth({ local: idle, public: false, now: now + 1 }, { ...failing, lastPublicRestart: now });
    assert.equal(again.restart, null, 'not again within the hour');
    const lanParty = checkHealth({ local: { ...idle, occupied: 1 }, public: false, now }, failing);
    assert.equal(lanParty.restart, null, 'people still playing on the LAN keep their games');
  },

  'a public failure is not counted while the server is down locally'() {
    const r = checkHealth({ local: null, public: null, now: 0 }, { publicFailures: 2 });
    assert.equal(r.state.publicFailures, 0);
  },
};
