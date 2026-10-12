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

function choosingHasNoClock() {
  // However long the drawer takes, nothing is picked for them.
  const g = started();
  assert.equal(g.deadline, null);
  assert.equal(draw.viewFor(g, 'p1', names, T0 + 3_600_000).secondsLeft, null);
  assert.equal(g.phase, 'choosing');
}

// --- guessing ------------------------------------------------------------------------------

function aCorrectGuessScoresByHowFastItCame() {
  const g = drawing();
  const early = draw.say(g, 'p2', 'pikachu', T0 + 8_000);
  const late = draw.say(g, 'p3', 'Pikachu', T0 + 72_000);
  assert.equal(early.verdict, 'correct');
  assert.ok(early.points > late.points, 'sooner scores more');
  assert.ok(late.points >= 100 && early.points <= 400);
  assert.equal(late.allDone, true, 'everyone has it, so the turn can end');
  assert.equal(late.doneReason, 'all');
  assert.equal(g.scores.get('p1'), 120, 'the drawer earns for each person who got it');
}

function aCloseGuessIsHiddenFromGuessersButTheDrawerSeesEveryGuess() {
  const g = drawing();
  assert.equal(draw.say(g, 'p2', 'Pikahcu', T0).verdict, 'close');
  assert.equal(draw.say(g, 'p2', 'Raichu', T0).verdict, 'wrong');
  const lines = (viewer) => draw.viewFor(g, viewer, names, T0).chat.map((m) => `${m.text}:${m.kind}`);
  assert.deepEqual(lines('p3'), ['Raichu:guess'], 'a near miss is a hint to anyone still guessing, so they never see it');
  assert.deepEqual(lines('p1'), ['Pikahcu:close', 'Raichu:guess'], 'the drawer sees every guess, marked');
  assert.equal(draw.say(g, 'p3', 'Pikachu', T0).verdict, 'correct');
  assert.deepEqual(lines('p1').at(-1), 'Pikachu:correct', '...the right ones too');
  assert.ok(!lines('p2').some((l) => l.startsWith('Pikachu')), 'but never to someone still guessing');
}

// People guessing at a drawing type what they see. "Combat" at a soldier is not a guess that it
// is Combat Carl, so a single word never wins a drawing round.
function oneWordOfTheNameIsNeverEnoughWithoutAPool() {
  // A game made without a pool cannot tell whether a word is anyone else's, so nothing short of
  // the full name counts.
  const g = started();
  draw.choose(g, 'p1', 2, T0); // Combat Carl
  assert.notEqual(draw.say(g, 'p2', 'combat', T0).verdict, 'correct');
  assert.equal(draw.say(g, 'p2', 'combat carl', T0).verdict, 'correct');
}

function aKnownNameCountsWhenNobodyElseInTheShowHasIt() {
  const { poolIndex } = require('../src/compendium/answers');
  const cast = poolIndex(['Sasuke Uchiha', 'Itachi Uchiha', 'Naruto Uzumaki', 'Kushina Uzumaki', 'Monkey D. Luffy', 'Pikachu']);
  const game = (name) => {
    const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'], castOf: () => cast });
    draw.offerChoices(g, [head(name)], T0);
    draw.choose(g, 'p1', 0, T0);
    return g;
  };
  assert.equal(draw.say(game('Sasuke Uchiha'), 'p2', 'sasuke', T0).verdict, 'correct', 'a first name nobody else has');
  assert.equal(draw.say(game('Monkey D. Luffy'), 'p2', 'Luffy', T0).verdict, 'correct', 'the name a character is known by');
  assert.equal(draw.say(game('Naruto Uzumaki'), 'p2', 'Naruto', T0).verdict, 'correct');
  assert.equal(draw.say(game('Naruto Uzumaki'), 'p2', 'Uzumaki', T0).verdict, 'close', 'a family name others share stays close');
  assert.equal(draw.say(game('Itachi Uchiha'), 'p2', 'uchiha', T0).verdict, 'close');
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

function theBlanksWaitForHalfTimeAndLettersFillThemIn() {
  const g = started();
  g.choices[0] = head('Spider-Man Noir');
  draw.choose(g, 'p1', 0, T0);
  // The first half is the drawing's: no blanks, only when they will come (at 40s on the clock).
  let v = draw.viewFor(g, 'p2', names, T0);
  assert.equal(v.mask, null, 'no blanks before half time');
  assert.equal(v.maskAt, 40);
  draw.revealDueHints(g, T0 + 39_000, (xs) => xs[0]);
  assert.equal(draw.viewFor(g, 'p2', names, T0 + 39_000).mask, null);
  draw.revealDueHints(g, T0 + 40_000, (xs) => xs[0]);
  v = draw.viewFor(g, 'p2', names, T0 + 40_000);
  assert.equal(v.mask, '______-___ ____', 'at half time: the shape, hyphen and space included');
  assert.equal(v.maskAt, null);
  assert.ok(draw.hintTimes(g).includes(T0 + 40_000), 'the room is woken for the blanks');
  // Letters from 60%, a beat after the blanks, then faster to 95%. Thirteen letters give away a
  // third, four: at 48s, 57.3s, 66.7s and 76s.
  const due = (ms) => {
    draw.revealDueHints(g, T0 + ms, (xs) => xs[0]);
    return g.revealed.length;
  };
  assert.equal(due(47_900), 0, 'no letter on top of the blanks');
  assert.equal(due(48_000), 1);
  assert.equal(draw.maskOf(g), 'S_____-___ ____');
  assert.equal(due(57_000), 1, 'not yet the second');
  assert.equal(due(57_400), 2);
  assert.equal(due(76_000), 4, 'a third of the letters by the last few seconds');
  assert.equal(due(79_900), 4, 'and never more');
  assert.ok(draw.hintTimes(g).includes(T0 + 76_000), 'the room is woken for the last one');
}

function namesGiveUpAThirdOfTheirLetters() {
  const revealedBy = (name) => {
    const g = started();
    g.choices[0] = head(name);
    draw.choose(g, 'p1', 0, T0);
    draw.revealDueHints(g, T0 + 79_999);
    return g.revealed.length;
  };
  assert.equal(revealedBy('Pikachu'), 2, 'seven letters: two');
  assert.equal(revealedBy('Luke'), 1, 'four letters: one');
  assert.equal(revealedBy('Leo'), 1, 'three letters: one');
  assert.equal(revealedBy('Ed'), 0, 'two letters: none -- that would be the answer');
}

function theKindOfWorkComesAtAQuarterAndTheWorkInTheLastQuarter() {
  const g = started();
  g.choices[0] = { ...head('Bowser Koopa'), origin: { work: 'Super Mario Bros.', category: 'Video Games' } };
  draw.choose(g, 'p1', 0, T0);
  for (const viewer of ['p1', 'p2']) {
    assert.deepEqual(draw.viewFor(g, viewer, names, T0).clue, { category: null, categoryAt: 60, work: null, workAt: 20 }, `${viewer} at the start: only when each will come`);
  }
  assert.ok(draw.hintTimes(g).includes(T0 + 20_000) && draw.hintTimes(g).includes(T0 + 60_000), 'the room is woken for each');
  assert.equal(draw.revealDueHints(g, T0 + 19_000), false);
  assert.equal(draw.revealDueHints(g, T0 + 20_000, (xs) => xs[0]), true);
  assert.deepEqual(draw.viewFor(g, 'p2', names, T0 + 20_000).clue, { category: 'Video Games', categoryAt: null, work: null, workAt: 20 });
  draw.revealDueHints(g, T0 + 59_000, (xs) => xs[0]);
  assert.equal(draw.viewFor(g, 'p2', names, T0 + 59_000).clue.work, null, 'not before the last quarter');
  draw.revealDueHints(g, T0 + 60_000, (xs) => xs[0]);
  assert.deepEqual(draw.viewFor(g, 'p2', names, T0 + 60_000).clue, { category: 'Video Games', categoryAt: null, work: 'Super Mario Bros.', workAt: null });
}

function aRoomPlayingOneCategorySeesItFromTheStart() {
  // Everyone saw "Anime" in the lobby: holding it back would hide nothing.
  const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'], categoryKnown: true });
  draw.offerChoices(g, [{ ...head('Ed'), origin: { work: 'Cowboy Bebop', category: 'Anime' } }], T0);
  draw.choose(g, 'p1', 0, T0);
  assert.deepEqual(draw.viewFor(g, 'p2', names, T0).clue, { category: 'Anime', categoryAt: null, work: null, workAt: 20 });
}

function theWorkHasTheNameBlankedOutOfIt() {
  const g = started();
  g.choices[0] = { ...head('Mario'), origin: { work: 'Super Mario Bros.', category: 'Video Games' } };
  draw.choose(g, 'p1', 0, T0);
  draw.revealDueHints(g, T0 + 60_000, (xs) => xs[0]);
  const json = JSON.stringify(draw.viewFor(g, 'p2', names, T0 + 60_000));
  assert.ok(json.includes('Super _____ Bros.'), json);
  assert.ok(!/mario/i.test(json), 'a guesser never sees the name, title or no title');
}

function aShortNameStillGetsItsWorkOnTime() {
  // No letter is ever due for "Ed" (a third of two letters is none), so each hint must be a change
  // of its own -- or the room would not be told until some guess happened to send a view.
  const g = started();
  g.choices[0] = { ...head('Ed'), origin: { work: 'Cowboy Bebop', category: 'Anime' } };
  draw.choose(g, 'p1', 0, T0);
  assert.equal(draw.revealDueHints(g, T0 + 40_000), true, 'the blanks');
  assert.equal(draw.revealDueHints(g, T0 + 60_000), true, 'the work');
  assert.equal(draw.viewFor(g, 'p3', names, T0 + 60_000).clue.work, 'Cowboy Bebop');
}

function noOriginNoClue() {
  const g = drawing();
  assert.equal(draw.viewFor(g, 'p2', names, T0).clue, null);
  g.character.origin = { work: null, category: 'Anime' };
  assert.deepEqual(draw.viewFor(g, 'p2', names, T0).clue, { category: null, categoryAt: 60, work: null, workAt: null }, 'nothing promised that is not coming');
}

// --- other names the drawer accepts -----------------------------------------------------------

function aNameTheDrawerAcceptsCounts() {
  const g = started();
  g.choices[0] = head('Tsukino Usagi');
  draw.choose(g, 'p1', 0, T0, 'Serena, Sailor Moon');
  assert.equal(draw.say(g, 'p2', 'serena', T0 + 1000).verdict, 'correct', 'the English name');
  assert.equal(draw.say(g, 'p3', 'Moon Sailor', T0 + 1000).verdict, 'correct', 'whole names, in any order');
  assert.equal(draw.viewFor(g, 'p1', names, T0).alsoAccept.join('|'), 'Serena|Sailor Moon', 'the drawer sees them');
}

function theDrawerIsToldWhatWillCountForEachChoice() {
  const { poolIndex } = require('../src/compendium/answers');
  const cast = poolIndex(['Uchiha Sasuke', 'Uchiha Itachi', 'Miles "Tails" Prower']);
  const g = draw.createDrawGame({ order: ['p1', 'p2', 'p3'], castOf: () => cast });
  draw.offerChoices(g, [head('Uchiha Sasuke'), head('Miles "Tails" Prower'), head('Pikachu')], T0);
  const accepts = draw.viewFor(g, 'p1', names, T0).choices.map((c) => c.accepts);
  assert.deepEqual(accepts[0], ['Uchiha Sasuke', 'Sasuke'], 'not Uchiha: Itachi has it too');
  assert.ok(accepts[1].includes('Tails'), 'a nickname, without its quotes');
  assert.deepEqual(accepts[2], ['Pikachu']);
  // And each is what the judge then says.
  draw.choose(g, 'p1', 0, T0);
  assert.equal(draw.say(g, 'p2', 'Sasuke', T0 + 1000).verdict, 'correct');
  assert.equal(draw.say(g, 'p3', 'Uchiha', T0 + 1000).verdict, 'close');
}

function theBlanksSpellTheNameTheDrawerPicked() {
  const g = started();
  g.choices[0] = head('Todoroki Enji');
  draw.choose(g, 'p1', 0, T0, 'Endeavor', 'Endeavor');
  assert.equal(draw.viewFor(g, 'p1', names, T0).shownAs, 'Endeavor', 'the drawer sees what the blanks spell');
  assert.equal(draw.viewFor(g, 'p2', names, T0).shownAs, null);
  draw.revealDueHints(g, T0 + 40_000, (xs) => xs[0]);
  const guesser = draw.viewFor(g, 'p2', names, T0 + 40_000);
  assert.equal(guesser.mask, '________', 'one word of eight, not "Todoroki Enji"');
  assert.ok(!JSON.stringify(guesser).includes('Endeavor'), 'a guesser is never sent the spelling itself');
  // Letters come from the spelling too: a third of eight is two.
  draw.revealDueHints(g, T0 + 79_999, (xs) => xs[0]);
  assert.equal(draw.maskOf(g), 'En______');
  assert.equal(draw.say(g, 'p2', 'endeavor', T0 + 79_999).verdict, 'correct');
  draw.endTurn(g, T0 + 80_000, 'time');
  assert.equal(draw.viewFor(g, 'p3', names, T0 + 80_000).lastTurn.shownAs, 'Endeavor', 'named at the reveal');
  assert.deepEqual([g.drawings[0].character.name, g.drawings[0].character.realName], ['Endeavor', 'Todoroki Enji'], 'and in the gallery');
}

function theBlanksTakeOnlyASpellingThatCounts() {
  const swapped = started();
  swapped.choices[0] = { ...head('Lee Rock'), origin: { work: 'Naruto', category: 'Anime' } };
  assert.equal(draw.viewFor(swapped, 'p1', names, T0).choices[0].swapped, 'Rock Lee', 'offered for a romanised name');
  draw.choose(swapped, 'p1', 0, T0, '', 'Rock Lee');
  assert.equal(swapped.shownAs, 'Rock Lee', 'the two words the other way round');
  const western = started();
  western.choices[0] = { ...head('Cindy Walsh'), origin: { work: 'Beverly Hills, 90210', category: 'Television Shows' } };
  assert.equal(draw.viewFor(western, 'p1', names, T0).choices[0].swapped, null, 'not for anyone else');
  draw.choose(western, 'p1', 0, T0, '', 'Walsh Cindy');
  assert.equal(western.shownAs, 'Cindy Walsh');
  const made = started();
  made.choices[0] = head('Lee Rock');
  draw.choose(made, 'p1', 0, T0, '', 'Totally Wrong');
  assert.equal(made.shownAs, 'Lee Rock', 'anything else is the name itself');
  const plain = started();
  draw.choose(plain, 'p1', 0, T0);
  assert.equal(plain.shownAs, 'Pikachu', 'and by default');
  assert.deepEqual(draw.spellingsFor('Lee Rock', ['Rock Lee', 'Bushy Brow']), ['Lee Rock', 'Rock Lee', 'Bushy Brow'], 'no spelling twice');
}

function otherNamesReachNobodyButTheDrawerUntilTheReveal() {
  const g = started();
  draw.choose(g, 'p1', 0, T0, 'Pika');
  const guesser = JSON.stringify(draw.viewFor(g, 'p2', names, T0));
  assert.ok(!guesser.includes('Pika"') && draw.viewFor(g, 'p2', names, T0).alsoAccept === null);
  draw.endTurn(g, T0 + 80_000, 'time');
  assert.deepEqual(draw.viewFor(g, 'p2', names, T0 + 80_000).lastTurn.alsoAccepted, ['Pika'], 'named at the reveal');
}

function otherNamesAreAFewRealNames() {
  assert.deepEqual(draw.cleanAlsoAccept('a, Serena , ,Serena, Bunny, Usako, Moon'), ['Serena', 'Bunny', 'Usako'], 'no single letters, no repeats, at most three');
  assert.equal(draw.cleanAlsoAccept('x'.repeat(100))[0].length, 40);
  assert.deepEqual(draw.cleanAlsoAccept(undefined), []);
}

function otherNamesAreForThatTurnOnly() {
  const g = started();
  draw.choose(g, 'p1', 0, T0, 'Pika');
  draw.endTurn(g, T0 + 80_000, 'time');
  draw.advance(g);
  draw.offerChoices(g, [head('Mario')], T0 + 90_000);
  draw.choose(g, 'p2', 0, T0 + 90_000);
  assert.notEqual(draw.say(g, 'p3', 'pika', T0 + 91_000).verdict, 'correct');
}

// --- giving up ------------------------------------------------------------------------------

function whoGaveUpTalksOnlyToThoseWhoKnow() {
  // They have seen the answer, so what they type could give it away: it goes to insiders only.
  const g = drawing();
  assert.equal(draw.giveUp(g, 'p2').ok, true);
  assert.equal(draw.say(g, 'p2', 'it is Pikachu obviously', T0 + 1000).verdict, 'said');
  assert.ok(!JSON.stringify(draw.viewFor(g, 'p3', names, T0 + 1000)).includes('obviously'), 'not shown to someone guessing');
  assert.ok(JSON.stringify(draw.viewFor(g, 'p1', names, T0 + 1000)).includes('obviously'), 'shown to the drawer');
  assert.equal(draw.viewFor(g, 'p2', names, T0 + 1000).character.name, 'Pikachu', 'and they see the answer');
  assert.equal(draw.say(g, 'p2', 'Pikachu', T0 + 2000).verdict, 'said', 'no points for naming it now');
}

function aLeaverCanLeaveNobodyGuessing() {
  const g = drawing();
  draw.giveUp(g, 'p2');
  const res = draw.removePlayer(g, 'p3', T0 + 5000);
  assert.equal(res.endTurn, true);
  assert.equal(g.lastTurn.reason, 'given-up');
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

function newChoicesStayUntimed() {
  const g = started();
  draw.rerollChoices(g, 'p1', [head('Luigi')], T0 + 12_000);
  assert.equal(g.deadline, null);
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
  'choosing has no clock': choosingHasNoClock,
  'a correct guess scores by how fast it came': aCorrectGuessScoresByHowFastItCame,
  'a close guess is hidden from guessers, but the drawer sees every guess': aCloseGuessIsHiddenFromGuessersButTheDrawerSeesEveryGuess,
  'one word of the name is never enough without a pool': oneWordOfTheNameIsNeverEnoughWithoutAPool,
  'a known name counts when nobody else in the show has it': aKnownNameCountsWhenNobodyElseInTheShowHasIt,
  'once you know, your words go only to the others who know': onceYouKnowYourWordsGoOnlyToTheOthersWhoKnow,
  'the drawer cannot guess': theDrawerCannotGuess,
  'nobody scores twice': nobodyScoresTwice,
  'the answer reaches only those who know it': theAnswerReachesOnlyThoseWhoKnowIt,
  'the blanks wait for half time, and letters fill them in': theBlanksWaitForHalfTimeAndLettersFillThemIn,
  'names give up a third of their letters': namesGiveUpAThirdOfTheirLetters,
  'whoever gave up talks only to those who know, and scores nothing': whoGaveUpTalksOnlyToThoseWhoKnow,
  'a name the drawer accepts counts': aNameTheDrawerAcceptsCounts,
  'the drawer is told what will count for each choice': theDrawerIsToldWhatWillCountForEachChoice,
  'the blanks spell the name the drawer picked': theBlanksSpellTheNameTheDrawerPicked,
  'the blanks take only a spelling that counts': theBlanksTakeOnlyASpellingThatCounts,
  'other names reach nobody but the drawer until the reveal': otherNamesReachNobodyButTheDrawerUntilTheReveal,
  'other names are a few real names': otherNamesAreAFewRealNames,
  'other names are for that turn only': otherNamesAreForThatTurnOnly,
  'a leaver can leave nobody guessing, which ends the turn': aLeaverCanLeaveNobodyGuessing,
  'the kind of work comes at a quarter, and the work in the last quarter': theKindOfWorkComesAtAQuarterAndTheWorkInTheLastQuarter,
  'a room playing one category sees it from the start': aRoomPlayingOneCategorySeesItFromTheStart,
  'the work has the name blanked out of it': theWorkHasTheNameBlankedOutOfIt,
  'a short name still gets its work on time': aShortNameStillGetsItsWorkOnTime,
  'no origin, no clue': noOriginNoClue,
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
  'new choices stay untimed': newChoicesStayUntimed,
  'only the drawer, and only while choosing, may ask for new choices': onlyTheDrawerAndOnlyWhileChoosingMayAskForNewChoices,
  'a finite budget counts down': aFiniteBudgetCountsDown,
  'only the drawer hears about rerolls': onlyTheDrawerHearsAboutRerolls,
};
