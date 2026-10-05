// Draw the Character's rules (src/web/draw/game.js), on a fake clock. No socket.io, no DB.
//
// The leak test matters most: the answer must reach only those who already know it -- the drawer
// and whoever has guessed it -- until the reveal. Not through `character`, not through the
// drawer's choices, not through a chat line from someone who knows. It searches whole payloads.

const { assert } = require('./harness');
const draw = require('../src/web/draw/game');

const head = (name) => ({ id: null, name, imageUrl: null, source: null });
const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira' };
const T0 = 1_000_000;

// p1 draws first. Choices are distinctive so finding one in a payload means one thing.
function started({ order = ['p1', 'p2', 'p3'], rounds = 2, drawSeconds = 80 } = {}) {
  const g = draw.createDrawGame({ order, rounds, drawSeconds });
  draw.offerChoices(g, [head('Pikachu'), head('Bowser Koopa'), head('Combat Carl')], T0);
  return g;
}
function drawing(opts) {
  const g = started(opts);
  draw.choose(g, 'p1', 0, T0);
  return g;
}

// --- choosing ------------------------------------------------------------------------------

function onlyTheDrawerChoosesAndOnlyFromTheThree() {
  const g = started();
  assert.equal(draw.choose(g, 'p2', 0, T0).ok, false);
  assert.equal(draw.choose(g, 'p1', 7, T0).ok, false);
  assert.equal(draw.choose(g, 'p1', 1, T0).ok, true);
  assert.equal(g.character.name, 'Bowser Koopa');
  assert.equal(g.phase, 'drawing');
  assert.equal(g.deadline, T0 + 80_000);
}

function aDrawerWhoNeverChoosesGetsTheFirst() {
  const g = started();
  draw.autoChoose(g, T0 + 15_000);
  assert.equal(g.character.name, 'Pikachu');
}

// --- guessing ------------------------------------------------------------------------------

function aCorrectGuessScoresByHowFastItCame() {
  const g = drawing();
  const early = draw.say(g, 'p2', 'pikachu', T0 + 8_000);
  const late = draw.say(g, 'p3', 'Pikachu', T0 + 72_000);
  assert.equal(early.verdict, 'correct');
  assert.ok(early.points > late.points, 'sooner scores more');
  assert.ok(late.points >= 100 && early.points <= 400);
  assert.equal(late.allGuessed, true, 'everyone has it, so the turn can end');
  assert.equal(g.scores.get('p1'), 120, 'the drawer earns for each person who got it');
}

function aCloseGuessIsTheGuessersAloneAndAWrongOneIsShown() {
  const g = drawing();
  assert.equal(draw.say(g, 'p2', 'Pikahcu', T0).verdict, 'close');
  assert.equal(g.chat.length, 0, 'a near miss is a hint to everyone else, so nobody else sees it');
  assert.equal(draw.say(g, 'p2', 'Raichu', T0).verdict, 'wrong');
  assert.deepEqual(g.chat.map((m) => m.text), ['Raichu']);
}

// People guessing at a drawing type what they see. "Combat" at a soldier is not a guess that it
// is Combat Carl, so a single word never wins a drawing round.
function oneWordOfTheNameIsNeverEnough() {
  const g = started();
  draw.choose(g, 'p1', 2, T0); // Combat Carl
  assert.notEqual(draw.say(g, 'p2', 'combat', T0).verdict, 'correct');
  assert.equal(draw.say(g, 'p2', 'combat carl', T0).verdict, 'correct');
}

function onceYouKnowYourWordsGoOnlyToTheOthersWhoKnow() {
  const g = drawing();
  draw.say(g, 'p2', 'Pikachu', T0);
  assert.equal(draw.say(g, 'p2', 'easy one, it is Pikachu', T0).verdict, 'said');
  assert.equal(draw.say(g, 'p1', 'nice', T0).verdict, 'said', "the drawer's words too");
  const p3 = JSON.stringify(draw.viewFor(g, 'p3', names, T0));
  assert.equal(p3.includes('easy one'), false, "a guesser never sees an insider's line");
  assert.ok(JSON.stringify(draw.viewFor(g, 'p2', names, T0)).includes('easy one'));
}

function theDrawerCannotGuess() {
  const g = drawing();
  assert.equal(draw.say(g, 'p1', 'Pikachu', T0).verdict, 'said');
  assert.equal(g.guessed.size, 0);
}

function nobodyScoresTwice() {
  const g = drawing();
  draw.say(g, 'p2', 'Pikachu', T0);
  const before = g.scores.get('p2');
  draw.say(g, 'p2', 'Pikachu', T0);
  assert.equal(g.scores.get('p2'), before);
}

// --- what each player sees -----------------------------------------------------------------

function theAnswerReachesOnlyThoseWhoKnowIt() {
  const g = started();
  const check = (moment, who) => {
    for (const viewer of who) {
      const json = JSON.stringify(draw.viewFor(g, viewer, names, T0));
      assert.equal(json.includes('Pikachu'), false, `${moment}: ${viewer} saw the answer`);
    }
  };
  // Choosing: the three options belong to the drawer alone.
  assert.equal(draw.viewFor(g, 'p1', names, T0).choices.length, 3);
  check('choosing', ['p2', 'p3']);
  draw.choose(g, 'p1', 0, T0);
  check('drawing', ['p2', 'p3']);
  draw.say(g, 'p2', 'Pikachu', T0 + 1000);
  draw.say(g, 'p2', 'it is Pikachu obviously', T0 + 2000);
  check('after p2 got it and said so', ['p3']);
  assert.equal(draw.viewFor(g, 'p2', names, T0).character.name, 'Pikachu', 'p2 has earned it');
  draw.endTurn(g, T0 + 3000, 'time');
  assert.equal(draw.viewFor(g, 'p3', names, T0).lastTurn.character.name, 'Pikachu', 'the reveal shows everyone');
}

function theMaskShowsTheShapeAndHintsFillItIn() {
  const g = started();
  g.choices[0] = head('Spider-Man Noir');
  draw.choose(g, 'p1', 0, T0);
  assert.equal(draw.maskOf(g), '______-___ ____', 'hyphen and space are part of the shape');
  draw.revealDueHints(g, T0 + 39_000, (xs) => xs[0]);
  assert.equal(draw.maskOf(g), '______-___ ____', 'nothing before half time');
  draw.revealDueHints(g, T0 + 40_000, (xs) => xs[0]);
  assert.equal(draw.maskOf(g), 'S_____-___ ____', 'one letter at half time');
  draw.revealDueHints(g, T0 + 60_000, (xs) => xs[0]);
  assert.equal(g.revealed.length, 2, 'another at three quarters');
}

function aShortNameGetsNoHintThatWouldGiveItAway() {
  const g = started();
  g.choices[0] = head('Ed');
  draw.choose(g, 'p1', 0, T0);
  draw.revealDueHints(g, T0 + 79_000);
  assert.equal(g.revealed.length, 0, 'never more than a third of the letters');
}

// --- turns, rounds, leaving ----------------------------------------------------------------

function everyoneDrawsOnceARoundThenItEnds() {
  const g = drawing({ order: ['p1', 'p2'], rounds: 2 });
  const drawers = [];
  for (;;) {
    drawers.push(draw.drawerOf(g));
    draw.endTurn(g, T0, 'time');
    if (draw.advance(g).over) break;
    draw.offerChoices(g, [head('Mario')], T0);
    draw.choose(g, draw.drawerOf(g), 0, T0);
  }
  assert.deepEqual(drawers, ['p1', 'p2', 'p1', 'p2']);
  assert.equal(g.phase, 'over');
}

function theDrawerLeavingEndsTheirTurn() {
  const g = drawing();
  const r = draw.removePlayer(g, 'p1', T0);
  assert.equal(r.endTurn, true);
  assert.equal(g.phase, 'reveal');
  draw.advance(g);
  assert.equal(draw.drawerOf(g), 'p2');
}

function theLastGuesserLeavingEndsTheTurnForEveryoneWhoHasIt() {
  const g = drawing();
  draw.say(g, 'p2', 'Pikachu', T0);
  assert.equal(draw.removePlayer(g, 'p3', T0).endTurn, true);
  assert.equal(g.lastTurn.reason, 'all');
}

function aLeaverIsSkippedAsDrawer() {
  const g = drawing();
  draw.removePlayer(g, 'p2', T0);
  draw.endTurn(g, T0, 'time');
  draw.advance(g);
  assert.equal(draw.drawerOf(g), 'p3');
}

function onePlayerLeftIsTheEnd() {
  const g = drawing({ order: ['p1', 'p2'] });
  draw.removePlayer(g, 'p2', T0);
  assert.equal(draw.advance(g).over, true);
}

// --- the host removing someone (room:kick goes through removePlayer, as leaving does) -----------

function removingTheDrawerWhileTheyChooseEndsTheTurn() {
  const g = started();
  const r = draw.removePlayer(g, 'p1', T0);
  assert.equal(r.endTurn, true);
  assert.equal(g.phase, 'reveal');
  assert.equal(g.lastTurn.reason, 'drawer-left');
  assert.equal(draw.advance(g).over, false);
  assert.equal(draw.drawerOf(g), 'p2');
}

function removingOneOfSeveralGuessersLetsTheDrawingGoOn() {
  const g = drawing({ order: ['p1', 'p2', 'p3', 'p4'] });
  const r = draw.removePlayer(g, 'p3', T0);
  assert.equal(r.ok, true);
  assert.equal(r.endTurn, false, 'two people are still guessing');
  assert.equal(g.phase, 'drawing');
  assert.equal(draw.allGuessed(g), false);
}

function aRemovedPlayerCannotGuessButKeepsTheirScore() {
  const g = drawing();
  draw.say(g, 'p2', 'Pikachu', T0);
  const scored = g.scores.get('p2');
  draw.removePlayer(g, 'p2', T0);
  assert.equal(draw.say(g, 'p2', 'hello', T0).ok, false);
  const row = draw.standings(g, names).find((s) => s.playerId === 'p2');
  assert.equal(row.score, scored);
  assert.equal(row.left, true);
  assert.equal(draw.viewFor(g, 'p3', names, T0).players.find((p) => p.playerId === 'p2').left, true);
}

function removingSomeoneTwiceIsANoOp() {
  const g = drawing({ order: ['p1', 'p2', 'p3', 'p4'] });
  assert.equal(draw.removePlayer(g, 'p3', T0).ok, true);
  assert.equal(draw.removePlayer(g, 'p3', T0).ok, false);
  assert.equal(draw.removePlayer(g, 'nobody', T0).ok, false);
  assert.equal(g.phase, 'drawing');
}

function aRemovalDuringTheRevealLeavesTheRevealAlone() {
  const g = drawing();
  draw.endTurn(g, T0, 'time');
  const shown = g.lastTurn;
  assert.equal(draw.removePlayer(g, 'p2', T0).endTurn, false);
  assert.equal(g.phase, 'reveal');
  assert.equal(g.lastTurn, shown, 'the turn just shown is not rewritten');
  draw.advance(g);
  assert.equal(draw.drawerOf(g), 'p3', 'and they are skipped as the next drawer');
}

function removingAllButOneEndsTheTurnAndTheGame() {
  const g = drawing();
  assert.equal(draw.removePlayer(g, 'p2', T0).endTurn, false);
  assert.equal(draw.removePlayer(g, 'p3', T0).endTurn, true, 'a drawer with nobody to draw for');
  assert.equal(draw.advance(g).over, true);
  assert.equal(g.phase, 'over');
}

function tiesShareAPlace() {
  const g = drawing();
  g.scores = new Map([['p1', 300], ['p2', 300], ['p3', 100]]);
  assert.deepEqual(draw.standings(g, names).map((s) => [s.playerId, s.place]), [['p1', 1], ['p2', 1], ['p3', 3]]);
}

// --- new choices -----------------------------------------------------------------------------

function theDrawerCanAskForNewChoicesAsOftenAsTheyLike() {
  const g = started();
  assert.equal(draw.CHOICE_REROLLS, -1, 'unlimited to start');
  for (let i = 0; i < 5; i++) {
    const r = draw.rerollChoices(g, 'p1', [head(`Fresh ${i}a`), head(`Fresh ${i}b`), head(`Fresh ${i}c`)], T0 + 1000 * (i + 1));
    assert.equal(r.ok, true);
  }
  assert.deepEqual(g.choices.map((c) => c.name), ['Fresh 4a', 'Fresh 4b', 'Fresh 4c']);
  assert.equal(draw.viewFor(g, 'p1', names, T0).rerollsLeft, -1);
}

function newChoicesNeverRepeatOnesAlreadyOfferedOrDrawn() {
  const g = started();
  g.used.push('Drawn Earlier');
  draw.rerollChoices(g, 'p1', [head('Luigi'), head('Zelda'), head('Link')], T0);
  const ex = draw.rerollExclusions(g);
  for (const n of ['Pikachu', 'Bowser Koopa', 'Combat Carl', 'Luigi', 'Zelda', 'Link', 'Drawn Earlier']) {
    assert.ok(ex.includes(n), `${n} must not be offered again this turn`);
  }
  // A new turn starts a fresh list of offers (drawn ones stay excluded through g.used).
  draw.choose(g, 'p1', 0, T0);
  draw.endTurn(g, T0, 'time');
  draw.advance(g);
  draw.offerChoices(g, [head('Mario')], T0);
  assert.deepEqual(draw.rerollExclusions(g).sort(), ['Drawn Earlier', 'Luigi', 'Mario'].sort());
}

function newChoicesRestartTheChoosingClock() {
  const g = started();
  draw.rerollChoices(g, 'p1', [head('Luigi')], T0 + 12_000);
  assert.equal(g.deadline, T0 + 12_000 + draw.CHOOSE_SECONDS * 1000);
}

function onlyTheDrawerAndOnlyWhileChoosingMayAskForNewChoices() {
  const g = started();
  assert.equal(draw.rerollChoices(g, 'p2', [head('Luigi')], T0).ok, false);
  assert.equal(draw.rerollChoices(g, 'p1', [], T0).ok, false, 'nothing left to offer is refused, not an empty screen');
  assert.equal(g.choices[0].name, 'Pikachu');
  draw.choose(g, 'p1', 0, T0);
  assert.equal(draw.rerollChoices(g, 'p1', [head('Luigi')], T0).ok, false);
  assert.equal(draw.viewFor(g, 'p1', names, T0).rerollsLeft, null);
}

function aFiniteBudgetCountsDown() {
  const g = started();
  g.rerollsLeft = 1;
  assert.equal(draw.rerollChoices(g, 'p1', [head('Luigi')], T0).ok, true);
  assert.equal(g.rerollsLeft, 0);
  assert.equal(draw.rerollChoices(g, 'p1', [head('Zelda')], T0).ok, false);
}

function onlyTheDrawerHearsAboutRerolls() {
  const g = started();
  assert.equal(draw.viewFor(g, 'p2', names, T0).rerollsLeft, null);
}

module.exports = {
  'only the drawer chooses, and only from the three': onlyTheDrawerChoosesAndOnlyFromTheThree,
  'a drawer who never chooses gets the first': aDrawerWhoNeverChoosesGetsTheFirst,
  'a correct guess scores by how fast it came': aCorrectGuessScoresByHowFastItCame,
  "a close guess is the guesser's alone, and a wrong one is shown": aCloseGuessIsTheGuessersAloneAndAWrongOneIsShown,
  'one word of the name is never enough': oneWordOfTheNameIsNeverEnough,
  'once you know, your words go only to the others who know': onceYouKnowYourWordsGoOnlyToTheOthersWhoKnow,
  'the drawer cannot guess': theDrawerCannotGuess,
  'nobody scores twice': nobodyScoresTwice,
  'the answer reaches only those who know it': theAnswerReachesOnlyThoseWhoKnowIt,
  'the mask shows the shape, and hints fill it in': theMaskShowsTheShapeAndHintsFillItIn,
  'a short name gets no hint that would give it away': aShortNameGetsNoHintThatWouldGiveItAway,
  'everyone draws once a round, then it ends': everyoneDrawsOnceARoundThenItEnds,
  'the drawer leaving ends their turn': theDrawerLeavingEndsTheirTurn,
  'the last guesser leaving ends the turn for everyone who has it': theLastGuesserLeavingEndsTheTurnForEveryoneWhoHasIt,
  'a leaver is skipped as drawer': aLeaverIsSkippedAsDrawer,
  'one player left is the end': onePlayerLeftIsTheEnd,
  'removing the drawer while they choose ends the turn': removingTheDrawerWhileTheyChooseEndsTheTurn,
  'removing one of several guessers lets the drawing go on': removingOneOfSeveralGuessersLetsTheDrawingGoOn,
  'a removed player cannot guess, but keeps their score': aRemovedPlayerCannotGuessButKeepsTheirScore,
  'removing someone twice is a no-op': removingSomeoneTwiceIsANoOp,
  'a removal during the reveal leaves the reveal alone': aRemovalDuringTheRevealLeavesTheRevealAlone,
  'removing all but one ends the turn and the game': removingAllButOneEndsTheTurnAndTheGame,
  'ties share a place': tiesShareAPlace,
  'the drawer can ask for new choices as often as they like': theDrawerCanAskForNewChoicesAsOftenAsTheyLike,
  'new choices never repeat ones already offered or drawn': newChoicesNeverRepeatOnesAlreadyOfferedOrDrawn,
  'new choices restart the choosing clock': newChoicesRestartTheChoosingClock,
  'only the drawer, and only while choosing, may ask for new choices': onlyTheDrawerAndOnlyWhileChoosingMayAskForNewChoices,
  'a finite budget counts down': aFiniteBudgetCountsDown,
  'only the drawer hears about rerolls': onlyTheDrawerHearsAboutRerolls,
};
