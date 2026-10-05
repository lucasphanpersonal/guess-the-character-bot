// Unit tests for the web setup/confirm/reroll orchestration (src/web/guess/gameSetup.js). Uses the
// real core Game, with content access injected as fakes -- no socket.io, no seeded DB.

const { assert } = require('./harness');
const { createSetup, buildView, applyReroll, applyUndo, applyConfirm, applyUnlock, clampTurnSeconds } = require('../src/web/guess/gameSetup');

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
  assert.equal(game.confirmState.p1.rerollsLeft, -1); // unlimited by default
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

// Every reference entry has to say WHOSE character it is. The names were always in the payload
// and simply were not rendered, so the setup screen listed anonymous characters and nobody could
// tell who was wearing what -- which is the one thing that list exists to tell you.
function referenceEntriesNameTheirOwner() {
  const { game, names } = setup3();
  const view = buildView(game, 'p1', names);
  assert.equal(view.reference.length, 1);
  assert.equal(view.reference[0].ownerName, 'Kira');
  assert.equal(view.reference[0].character.name, 'Cloud');
  assert.equal(view.checking.ownerName, 'Sam', 'the checked card is attributed too');
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
  assert.equal(game.confirmState.p1.rerollsLeft, -1); // unlimited: no spend
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

// Undo: "actually the last one was better" is the obvious second thought after a snap reroll,
// and a fresh roll cannot be steered back to a specific character.
function undoPutsThePreviousCharacterBack() {
  const { game, names } = setup3();
  const content = fakeContent([row(4, 'Zelda')]);
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(game.headByPlayer.p2.name, 'Zelda');

  const res = applyUndo(game, 'p1');
  assert.equal(res.ok, true);
  assert.equal(res.restored, 'Bulma');
  assert.equal(game.headByPlayer.p2.name, 'Bulma', 'the original is back on the target');
  assert.equal(buildView(game, 'p1', names).checking.character.name, 'Bulma');
}

function undoRetractsTheRejectionSoItIsNotHeldAgainstTheCharacter() {
  const { game } = setup3();
  const content = fakeContent([row(4, 'Zelda')]);
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(game.confirmState.p1.rejectedNames.has('Bulma'), true);
  applyUndo(game, 'p1');
  assert.equal(game.confirmState.p1.rejectedNames.has('Bulma'), false, 'no longer recorded as turned down');
}

function undoUnwindsRepeatedRerollsOneAtATime() {
  const { game } = setup3();
  const content = fakeContent([row(4, 'Zelda'), row(5, 'Yoshi')]);
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' }); // Bulma -> Zelda
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' }); // Zelda -> Yoshi
  assert.equal(game.headByPlayer.p2.name, 'Yoshi');
  assert.equal(applyUndo(game, 'p1').restored, 'Zelda');
  assert.equal(game.headByPlayer.p2.name, 'Zelda');
  assert.equal(applyUndo(game, 'p1').restored, 'Bulma');
  assert.equal(game.headByPlayer.p2.name, 'Bulma');
}

function undoIsRefusedWithNothingToUndo() {
  const { game, names } = setup3();
  assert.equal(buildView(game, 'p1', names).canUndo, false);
  const res = applyUndo(game, 'p1');
  assert.equal(res.ok, false);
  assert.match(res.error, /nothing to undo/i);
}

function undoIsRefusedOnceConfirmed() {
  const { game } = setup3();
  const content = fakeContent([row(4, 'Zelda')]);
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  applyConfirm(game, 'p1');
  const res = applyUndo(game, 'p1');
  assert.equal(res.ok, false);
  assert.match(res.error, /unlock/i);
  assert.equal(game.headByPlayer.p2.name, 'Zelda', 'nothing changed');
}

function undoRefundsAFiniteRerollBudget() {
  const order = ['p1', 'p2'];
  const game = createSetup({ order, guildId: 'web', listIds: [10], difficulty: 'normal',
    characters: [row(1, 'Aang'), row(2, 'Bulma')], maxRerolls: 2 });
  const content = fakeContent([row(3, 'Cloud')]);
  applyReroll(game, 'p1', { content, listIds: [10], difficulty: 'normal' });
  assert.equal(game.confirmState.p1.rerollsLeft, 1);
  applyUndo(game, 'p1');
  assert.equal(game.confirmState.p1.rerollsLeft, 2, 'the spent reroll comes back');
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

// The web config screen lets the host pick a turn length; it must land inside the same bounds
// the Discord bot enforces, and garbage must fall through to the single default rather than
// being coerced into a number here.
function turnSecondsIsClampedToTheSharedBounds() {
  assert.equal(clampTurnSeconds(60), 60);
  assert.equal(clampTurnSeconds(5), 15, 'below the minimum clamps up');
  assert.equal(clampTurnSeconds(9999), 600, 'above the maximum clamps down');
  assert.equal(clampTurnSeconds(undefined), undefined, 'missing falls through to the default');
  assert.equal(clampTurnSeconds('abc'), undefined, 'garbage falls through to the default');
}

function aClampedTurnLengthReachesTheGame() {
  const game = createSetup({
    order: ['p1', 'p2'],
    guildId: 'web',
    listIds: [1],
    difficulty: 'normal',
    characters: [row(1, 'A'), row(2, 'B')],
    turnSeconds: clampTurnSeconds(45),
  });
  assert.equal(game.turnSeconds, 45);
}

module.exports = {
  'createSetup builds a game with confirm state': createSetupBuildsAGameWithConfirmState,
  'turn seconds is clamped to the shared bounds': turnSecondsIsClampedToTheSharedBounds,
  'a clamped turn length reaches the game': aClampedTurnLengthReachesTheGame,
  "a view never contains the viewer's own character": aViewNeverContainsTheViewersOwnCharacter,
  'reference entries name their owner': referenceEntriesNameTheirOwner,
  'every character but your own is covered across checking + reference':
    everyCharacterButYourOwnIsCoveredAcrossCheckingPlusReference,
  'reroll swaps the check target (unlimited by default)': rerollSwapsTheCheckTargetAndSpendsFromTheBudget,
  'reroll excludes every character already in play': rerollExcludesEveryCharacterAlreadyInPlay,
  'reroll is refused when the budget is spent': rerollIsRefusedWhenTheBudgetIsSpent,
  'reroll reports when a character gets demoted': rerollReportsWhenAcharacterGetsDemoted,
  'undo puts the previous character back': undoPutsThePreviousCharacterBack,
  'undo retracts the rejection': undoRetractsTheRejectionSoItIsNotHeldAgainstTheCharacter,
  'undo unwinds repeated rerolls one at a time': undoUnwindsRepeatedRerollsOneAtATime,
  'undo is refused with nothing to undo': undoIsRefusedWithNothingToUndo,
  'undo is refused once confirmed': undoIsRefusedOnceConfirmed,
  'undo refunds a finite reroll budget': undoRefundsAFiniteRerollBudget,
  'confirming gates on every player': confirmingGatesOnEveryPlayer,
  'unlocking reopens a confirmation': unlockingReopensAConfirmation,
};
