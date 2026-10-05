// Pick-for-each-other mode (src/web/guess/gameSetup.js applyPick and its effect on the rest of the
// setup rules): nothing is dealt, and every player picks the character of the player they check.
// Real core Game, fake content -- no DB, no sockets.
//
// What matters most is the leak: a player sees every character in play but their own, so a pick
// refused for clashing with a character they CANNOT see would tell them who they are.

const { assert } = require('./harness');
const { createSetup, buildView, applyPick, applyReroll, applyUndo, applyConfirm, applyUnlock } = require('../src/web/guess/gameSetup');

const row = (id, name) => ({ id, name, list_id: null, image_url: null });
const LIBRARY = { 1: row(1, 'Spider-Man'), 2: row(2, 'Batman'), 3: row(3, 'Mario') };

function fakeContent(pool = [row(10, 'Luigi'), row(11, 'Zelda')]) {
  const rejected = [];
  return {
    rejected,
    demoteThreshold: 3,
    characterById: (id) => LIBRARY[id] ?? null,
    freeform: (name) => ({ name, id: null, list_id: null, image_url: null }),
    rerollOne: (_listIds, exclude) => pool.find((c) => !exclude.has(c.name)) ?? null,
    recordReject: (id, by) => { rejected.push({ id, by }); return 1; },
  };
}

const names = { a: 'Alex', b: 'Sam', c: 'Kira' };
// a checks b, b checks c, c checks a.
const setupGame = (order = ['a', 'b', 'c']) =>
  createSetup({ order, guildId: 'web', listIds: [1], difficulty: 'everything', characters: order.map(() => null), checkerPicks: true });
const deps = (content = fakeContent()) => ({ content, listIds: [1], difficulty: 'everything' });

function everySeatStartsEmptyAndNobodyCanLockIn() {
  const g = setupGame();
  const v = buildView(g, 'a', names);
  assert.equal(v.checkerPicks, true);
  assert.equal(v.checking.ownerId, 'b');
  assert.equal(v.checking.character, null, 'an empty seat is null, never a placeholder name');
  assert.equal(v.canConfirm, false);
  assert.equal(v.reference[0].character, null);
  const r = applyConfirm(g, 'a');
  assert.equal(r.ok, false);
  assert.match(r.error, /Pick a character/);
  assert.equal(g.confirmState.a.confirmed, false);
}

function aPickFillsTheCheckedPlayersSeat() {
  const g = setupGame();
  const content = fakeContent();
  assert.equal(applyPick(g, 'a', { id: 2 }, { content }).ok, true);
  assert.equal(g.headByPlayer.b.name, 'Batman');
  assert.equal(applyPick(g, 'b', { name: '  Grandma Jean  ' }, { content }).ok, true);
  assert.equal(g.headByPlayer.c.name, 'Grandma Jean', 'typed, trimmed, freeform');
  assert.equal(g.headByPlayer.c.id, null);
  assert.equal(buildView(g, 'a', names).canConfirm, true);
  assert.equal(applyConfirm(g, 'a').ok, true);
  assert.equal(content.rejected.length, 0, 'picking is not a judgement on the pool');
}

function playCanOnlyBeginWithEverySeatFilled() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'a', { id: 1 }, { content });
  applyPick(g, 'b', { id: 2 }, { content });
  assert.equal(applyConfirm(g, 'a').allReady, false);
  assert.equal(applyConfirm(g, 'b').allReady, false);
  assert.equal(applyConfirm(g, 'c').ok, false, "c has not picked for a, so a's seat is empty");
  applyPick(g, 'c', { id: 3 }, { content });
  assert.equal(applyConfirm(g, 'c').allReady, true);
  assert.ok(g.turnOrder.every((id) => g.headByPlayer[id]), 'no empty seat reaches play');
}

function nobodyIsEverSentTheirOwnCharacter() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'a', { id: 1 }, { content });
  applyPick(g, 'b', { id: 2 }, { content });
  applyPick(g, 'c', { id: 3 }, { content });
  for (const id of g.turnOrder) {
    const payload = JSON.stringify(buildView(g, id, names));
    assert.ok(!payload.includes(g.headByPlayer[id].name), `${id} must not see their own character`);
  }
}

function aPickThatClashesWithAVisibleCharacterIsRefused() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'b', { id: 1 }, { content }); // c is Spider-Man, which a can see
  const r = applyPick(g, 'a', { name: 'spiderman' }, { content });
  assert.equal(r.ok, false, 'judged by identity keys, not spelling');
  assert.match(r.error, /Spider-Man is already in play/);
  assert.equal(g.headByPlayer.b, null);
}

// The leak. c picked Batman for a; a cannot see their own seat. If a then picks Batman for b and is
// refused, a has learned they are Batman. So it is accepted.
function aClashWithYourOwnHiddenCharacterIsNotRevealed() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'c', { id: 2 }, { content }); // a is Batman
  const r = applyPick(g, 'a', { id: 2 }, { content });
  assert.equal(r.ok, true, 'refusing would tell a who they are');
  assert.equal(g.headByPlayer.b.name, 'Batman');
}

function replacingYourOwnPickIsAllowedAndUndoable() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'a', { id: 1 }, { content });
  assert.equal(applyPick(g, 'a', { name: 'Spider Man' }, { content }).ok, true, "the seat being replaced is not a clash");
  assert.equal(applyPick(g, 'a', { id: 2 }, { content }).ok, true);
  assert.equal(buildView(g, 'a', names).canUndo, true);
  assert.equal(applyUndo(g, 'a').ok, true);
  assert.equal(g.headByPlayer.b.name, 'Spider Man');
}

function randomFillsAnEmptySeatWithoutRecordingARejection() {
  const g = setupGame();
  const content = fakeContent();
  const r = applyReroll(g, 'a', deps(content));
  assert.equal(r.ok, true);
  assert.equal(g.headByPlayer.b.name, 'Luigi');
  assert.equal(content.rejected.length, 0, 'nothing was turned down');
  assert.equal(buildView(g, 'a', names).canUndo, false, 'nothing to put back');
  // Rerolling the random one IS turning down what the pool dealt.
  applyReroll(g, 'a', deps(content));
  assert.equal(g.headByPlayer.b.name, 'Zelda');
  assert.equal(content.rejected.length, 1);
}

function rerollingAwayFromAPickIsNotHeldAgainstThePool() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'a', { id: 3 }, { content });
  assert.equal(applyReroll(g, 'a', deps(content)).ok, true);
  assert.equal(content.rejected.length, 0, 'Mario was chosen by a person, not dealt');
}

function anEmptyPoolSaysSo() {
  const g = setupGame();
  const r = applyReroll(g, 'a', deps(fakeContent([])));
  assert.equal(r.ok, false);
  assert.match(r.error, /pool has no characters/);
}

function aLockedInPlayerCannotChangeTheirPick() {
  const g = setupGame();
  const content = fakeContent();
  applyPick(g, 'a', { id: 1 }, { content });
  applyConfirm(g, 'a');
  assert.equal(applyPick(g, 'a', { id: 2 }, { content }).ok, false);
  assert.equal(applyReroll(g, 'a', deps(content)).ok, false);
  assert.equal(g.headByPlayer.b.name, 'Spider-Man');
  applyUnlock(g, 'a');
  assert.equal(applyPick(g, 'a', { id: 2 }, { content }).ok, true);
}

function badPicksAreRefused() {
  const g = setupGame();
  const content = fakeContent();
  assert.equal(applyPick(g, 'a', { id: 999 }, { content }).ok, false, 'not in the library');
  assert.equal(applyPick(g, 'a', { id: 'x' }, { content }).ok, false);
  assert.equal(applyPick(g, 'a', { name: '   ' }, { content }).ok, false);
  assert.equal(applyPick(g, 'nobody', { id: 1 }, { content }).ok, false);
  assert.equal(applyPick(g, 'a', { name: 'x'.repeat(500) }, { content }).ok, true);
  assert.equal(g.headByPlayer.b.name.length, 60, 'capped');
}

function aDealtGameCannotBePickedInto() {
  const g = createSetup({ order: ['a', 'b'], guildId: 'web', listIds: [1], difficulty: 'everything', characters: [row(1, 'Spider-Man'), row(2, 'Batman')] });
  assert.equal(applyPick(g, 'a', { id: 3 }, { content: fakeContent() }).ok, false);
  assert.equal(buildView(g, 'a', names).checkerPicks, false);
  assert.equal(buildView(g, 'a', names).canConfirm, true);
}

module.exports = {
  'every seat starts empty and nobody can lock in': everySeatStartsEmptyAndNobodyCanLockIn,
  "a pick fills the checked player's seat": aPickFillsTheCheckedPlayersSeat,
  'play can only begin with every seat filled': playCanOnlyBeginWithEverySeatFilled,
  'nobody is ever sent their own character': nobodyIsEverSentTheirOwnCharacter,
  'a pick that clashes with a visible character is refused': aPickThatClashesWithAVisibleCharacterIsRefused,
  'a clash with your own hidden character is not revealed': aClashWithYourOwnHiddenCharacterIsNotRevealed,
  'replacing your own pick is allowed and undoable': replacingYourOwnPickIsAllowedAndUndoable,
  'random fills an empty seat without recording a rejection': randomFillsAnEmptySeatWithoutRecordingARejection,
  'rerolling away from a pick is not held against the pool': rerollingAwayFromAPickIsNotHeldAgainstThePool,
  'an empty pool says so': anEmptyPoolSaysSo,
  'a locked-in player cannot change their pick': aLockedInPlayerCannotChangeTheirPick,
  'bad picks are refused': badPicksAreRefused,
  'a dealt game cannot be picked into': aDealtGameCannotBePickedInto,
};
