// Unit tests for the web setup/confirm/reroll orchestration (src/web/gameSetup.js). Uses the
// real core Game, with content access injected as fakes -- no socket.io, no seeded DB.

const { assert } = require('./harness');
const { createSetup, buildView, applyReroll, applyConfirm, applyUnlock } = require('../src/web/gameSetup');

const row = (id, name) => ({ id, name, list_id: null, image_url: null });

// A fake content provider backed by a queue of "next" characters for rerolls.
function fakeContent(queue = [], { rejectCounts = {} } = {}) {
  const rejected = [];
  return {
    demoteThreshold: 3,
    rejected,
    rerollOne(_listIds, excludeNames, _difficulty) {
      const i = queue.findIndex((c) => !excludeNames.has(c.name));
      return i === -1 ? null : queue.splice(i, 1)[0];
    },
    recordReject(id, playerId) {
      rejected.push([id, playerId]);
      return rejectCounts[id] ?? 1;
    },
  };
}

function setup3() {
  const order = ['p1', 'p2', 'p3'];
  const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira' };
  const characters = [row(1, 'Aang'), row(2, 'Bulma'), row(3, 'Cloud')];
  const game = createSetup({ order, guildId: 'web', listIds: [10], difficulty: 'normal', characters });
  return { game, names, order };
}

function createSetupBuildsAGameWithConfirmState() {
  const { game } = setup3();
  assert.deepEqual(game.turnOrder, ['p1', 'p2', 'p3']);
  assert.equal(game.confirmState.p1.confirmed, false);
  assert.equal(game.confirmState.p1.rerollsLeft, 3);
  assert.equal(game.rerollAllowed, true);
}

function aViewNeverContainsTheViewersOwnCharacter() {
  const { game, names } = setup3();
  // p1 wears Aang. The whole view must be free of it.
  const view = buildView(game, 'p1', names);
  const shown = [view.checking.character.name, ...view.reference.map((r) => r.character.name)];
  assert.equal(shown.includes('Aang'), false);
  // p1 checks the next player (p2 = Bulma); the rest are reference (p3 = Cloud).
  assert.equal(view.checking.ownerName, 'Sam');
  assert.equal(view.checking.character.name, 'Bulma');
  assert.deepEqual(view.reference.map((r) => r.character.name), ['Cloud']);
}

function everyCharacterButYourOwnIsCoveredAcrossCheckingPlusReference() {
  const { game, names } = setup3();
  const view = buildView(game, 'p2', names); // p2 wears Bulma
  const shown = new Set([view.checking.character.name, ...view.reference.map((r) => r.character.name)]);
  assert.deepEqual([...shown].sort(), ['Aang', 'Cloud']); // everyone but p2's own
}

function rerollSwapsTheCheckTargetAndSpendsFromTheBudget() {
  const { game, names } = setup3();
  const content = fakeContent([row(4, 'Zelda')]);
  const res = applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(res.ok, true);
  assert.equal(game.confirmState.p1.rerollsLeft, 2);
  // p1 checks p2 -> p2's character is what changed.
  assert.equal(game.headByPlayer.p2.name, 'Zelda');
  assert.equal(buildView(game, 'p1', names).checking.character.name, 'Zelda');
  // The rejected character (Bulma) was recorded against the roller.
  assert.deepEqual(content.rejected, [[2, 'p1']]);
  assert.equal(game.confirmState.p1.rejectedNames.has('Bulma'), true);
}

function rerollExcludesEveryCharacterAlreadyInPlay() {
  const { game } = setup3();
  // The only "new" option the fake offers duplicates an in-play name, so it must be skipped
  // and the reroll should fail rather than deal a duplicate.
  const content = fakeContent([row(9, 'Cloud')]); // Cloud is already p3's
  const res = applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no other characters/i);
}

function rerollIsRefusedWhenTheBudgetIsSpent() {
  const order = ['p1', 'p2'];
  const characters = [row(1, 'Aang'), row(2, 'Bulma')];
  const game = createSetup({ order, guildId: 'web', listIds: [10], difficulty: 'normal', characters, maxRerolls: 1 });
  const content = fakeContent([row(3, 'Cloud'), row(4, 'Zelda')]);
  assert.equal(applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' }).ok, true);
  const second = applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(second.ok, false);
  assert.match(second.error, /out of rerolls/i);
}

function rerollReportsWhenAcharacterGetsDemoted() {
  const { game } = setup3();
  const content = fakeContent([row(4, 'Zelda')], { rejectCounts: { 2: 3 } }); // Bulma hits threshold
  const res = applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(res.ok, true);
  assert.equal(res.demotedName, 'Bulma');
}

function confirmingGatesOnEveryPlayer() {
  const { game } = setup3();
  assert.equal(applyConfirm(game, 'p1').allReady, false);
  assert.equal(applyConfirm(game, 'p2').allReady, false);
  assert.equal(applyConfirm(game, 'p3').allReady, true);
}

function unlockingReopensAConfirmation() {
  const { game } = setup3();
  applyConfirm(game, 'p1');
  applyConfirm(game, 'p2');
  applyConfirm(game, 'p3'); // all in
  applyUnlock(game, 'p2');
  assert.equal(game.confirmState.p2.confirmed, false);
  // No longer all ready.
  assert.equal(applyConfirm(game, 'p1').allReady, false);
}

module.exports = {
  'createSetup builds a game with confirm state': createSetupBuildsAGameWithConfirmState,
  "a view never contains the viewer's own character": aViewNeverContainsTheViewersOwnCharacter,
  'every character but your own is covered across checking + reference':
    everyCharacterButYourOwnIsCoveredAcrossCheckingPlusReference,
  'reroll swaps the check target and spends from the budget': rerollSwapsTheCheckTargetAndSpendsFromTheBudget,
  'reroll excludes every character already in play': rerollExcludesEveryCharacterAlreadyInPlay,
  'reroll is refused when the budget is spent': rerollIsRefusedWhenTheBudgetIsSpent,
  'reroll reports when a character gets demoted': rerollReportsWhenAcharacterGetsDemoted,
  'confirming gates on every player': confirmingGatesOnEveryPlayer,
  'unlocking reopens a confirmation': unlockingReopensAConfirmation,
};
