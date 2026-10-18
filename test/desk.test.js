// Guess the Character on computers (src/web/desk): typed guesses, the other players' rulings, the
// board view, and the rooms that keep phones and computers apart. Real core Game via gameSetup;
// no socket.io, no network.
//
// The test that matters most is the leak test: a computer shows everybody's character but your
// own, and the phones' view deliberately carries your own -- so a slip between the two, or a
// ruling that names the answer to the person being ruled on, would hand the guesser their answer.
// It checks the WHOLE payload, not the fields that obviously hold a character.

const { assert } = require('./harness');
const { createSetup } = require('../src/web/guess/gameSetup');
const loop = require('../src/web/guess/turnLoop');
const guessing = require('../src/web/desk/guessing');
const { buildBoardView } = require('../src/web/desk/view');
const { RoomRegistry } = require('../src/web/rooms');
const notes = require('../src/web/desk/notes');

const row = (id, name) => ({ id, name, list_id: null, image_url: null });
// Distinctive names, so finding one anywhere in a payload means exactly one thing.
const CAST = { p1: 'Zorblax Quintavius', p2: 'Mirelle Okonkwo', p3: 'Tavish Brennagh' };
const names = { p1: 'Alex', p2: 'Sam', p3: 'Kira' };

function game(order = ['p1', 'p2', 'p3']) {
  const g = createSetup({
    order,
    guildId: 'web',
    listIds: [1],
    difficulty: 'normal',
    characters: order.map((id, i) => row(i + 1, CAST[id])),
    turnSeconds: 60,
  });
  loop.startTurn(g);
  return g;
}
const others = Object.values(CAST);

// --- guesses --------------------------------------------------------------------------------

function aCorrectGuessEndsTheTurnAsGotIt() {
  const g = game();
  const r = guessing.submitGuess(g, 'p1', 'zorblax quintavius', { others });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'correct');
  assert.equal(r.reveal.kind, 'got');
  assert.equal(r.nextPlayerId, 'p2');
  assert.equal(g.finishedBy.get('p1'), 1);
}

function oneWordCountsWhenNobodyElseHasIt() {
  const g = game();
  assert.equal(guessing.submitGuess(g, 'p1', 'Zorblax', { others }).verdict, 'correct');
}

function aWrongGuessCostsNothingAndTheTurnGoesOn() {
  const g = game();
  for (const text of ['Batman', 'Superman', 'Pikachu']) {
    const r = guessing.submitGuess(g, 'p1', text, { others });
    assert.equal(r.verdict, 'wrong');
  }
  assert.equal(g.currentPlayerId, 'p1', 'still their turn -- no limit, by choice');
  assert.equal(guessing.guessLog(g).length, 3);
}

// A table that has gone quiet pauses itself (turnRules.deserted), so whatever counts as somebody
// being there has to say so. On a computer that includes a guess that misses: it ends no turn.
function aTypedGuessShowsTheTableIsNotDeserted() {
  const g = game(['p1', 'p2']);
  for (let i = 0; i < 3; i++) loop.timeout(g, g.currentPlayerId);
  assert.equal(loop.deserted(g), false, 'three quiet turns of the four two rounds take');
  assert.equal(guessing.submitGuess(g, g.currentPlayerId, 'Batman', { others }).verdict, 'wrong');
  loop.timeout(g, g.currentPlayerId);
  assert.equal(loop.deserted(g), false, 'the miss started the count again');
  for (let i = 0; i < 3; i++) loop.timeout(g, g.currentPlayerId);
  assert.equal(loop.deserted(g), true, 'two full rounds with nobody acting');
}

function aRulingShowsTheTableIsNotDeserted() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  g.idleTimeouts = 5; // the guess reset it; the ruling has to, as well
  guessing.rule(g, 'p3', rulingId, false);
  assert.equal(g.idleTimeouts, 0);
}

function onlyTheCurrentPlayerMayGuess() {
  const g = game();
  assert.equal(guessing.submitGuess(g, 'p2', 'Mirelle Okonkwo', { others }).ok, false);
  assert.equal(g.finishedBy.size, 0);
}

function anEmptyGuessIsRefused() {
  const g = game();
  assert.equal(guessing.submitGuess(g, 'p1', '   ', { others }).ok, false);
  assert.equal(guessing.guessLog(g).length, 0);
}

// --- rulings --------------------------------------------------------------------------------

function aCloseGuessWaitsForTheOthers() {
  const g = game();
  const r = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others }); // a typo
  assert.equal(r.verdict, 'close');
  assert.ok(guessing.pendingRuling(g));
  assert.equal(g.currentPlayerId, 'p1');
  // ...and nothing else can be typed until it is settled.
  assert.equal(guessing.submitGuess(g, 'p1', 'Batman', { others }).ok, false);
}

function anAcceptedRulingIsGotIt() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  const r = guessing.rule(g, 'p2', rulingId, true);
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.reveal.kind, 'got');
  assert.equal(g.finishedBy.get('p1'), 1);
  assert.equal(guessing.pendingRuling(g), null);
}

function aRejectedRulingIsAMissAndTheTurnGoesOn() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  const r = guessing.rule(g, 'p3', rulingId, false);
  assert.equal(r.accepted, false);
  assert.equal(g.currentPlayerId, 'p1');
  assert.equal(guessing.guessLog(g).at(-1).verdict, 'wrong');
  assert.equal(guessing.guessLog(g).at(-1).ruledBy, 'p3');
}

function theGuesserCannotRuleOnTheirOwnGuess() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  assert.equal(guessing.rule(g, 'p1', rulingId, true).ok, false);
  assert.equal(guessing.rule(g, 'stranger', rulingId, true).ok, false, 'nor can anyone not in the game');
  assert.ok(guessing.pendingRuling(g), 'still pending');
}

function theFirstRulingSettlesIt() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  assert.equal(guessing.rule(g, 'p2', rulingId, false).ok, true);
  assert.equal(guessing.rule(g, 'p3', rulingId, true).ok, false, 'a second tap changes nothing');
  assert.equal(g.finishedBy.size, 0);
}

// The rule CLAUDE.md learned the hard way: state taken for one turn is dropped with that turn.
// A late tap on a ruling from a turn that has ended must not resolve the next player's turn.
function aRulingDiesWithItsTurn() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  loop.timeout(g, 'p1');
  guessing.endTurnState(g); // what the socket layer does for every turn end
  assert.equal(g.currentPlayerId, 'p2');
  assert.equal(guessing.rule(g, 'p3', rulingId, true).ok, false);
  assert.equal(g.finishedBy.size, 0, 'nobody was finished by a stale ruling');
}

function aRulingNobodyMakesLapsesAsAMiss() {
  const g = game();
  const { rulingId } = guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  assert.equal(guessing.lapse(g, rulingId).ok, true);
  assert.equal(guessing.pendingRuling(g), null);
  assert.equal(guessing.guessLog(g).at(-1).lapsed, true);
  assert.equal(guessing.lapse(g, rulingId).ok, false, 'only once');
}

// --- the board ------------------------------------------------------------------------------

// Every view, for every player, at every moment that adds something to the payload.
function nobodysViewEverNamesTheirOwnCharacter() {
  const g = game();
  const check = (moment) => {
    for (const viewer of g.turnOrder) {
      if (g.finishedBy.has(viewer)) continue; // they have earned the reveal
      const json = JSON.stringify(buildBoardView(g, viewer, names));
      assert.equal(json.includes(CAST[viewer]), false, `${moment}: ${viewer}'s own character leaked to them`);
      for (const other of g.turnOrder.filter((id) => id !== viewer)) {
        assert.ok(json.includes(CAST[other]), `${moment}: ${viewer} should see ${other}'s character`);
      }
    }
  };
  check('start');
  guessing.submitGuess(g, 'p1', 'Batman', { others });
  check('after a miss');
  guessing.submitGuess(g, 'p1', 'Zorblax Quintavus', { others });
  check('during a ruling'); // the ruling names the answer -- to everyone but p1
  const view = buildBoardView(g, 'p2', names);
  assert.equal(view.ruling.answer.name, CAST.p1, 'the rulers see what they are ruling against');
  assert.equal(buildBoardView(g, 'p1', names).ruling.waiting, true);
  guessing.rule(g, 'p2', view.ruling.id, false);
  loop.pass(g, 'p1');
  guessing.endTurnState(g);
  check('next turn');
}

function yourOwnCardTurnsOverOnceYouHaveIt() {
  const g = game();
  guessing.submitGuess(g, 'p1', 'Zorblax Quintavius', { others });
  const mine = buildBoardView(g, 'p1', names);
  assert.equal(mine.me.character.name, CAST.p1);
  assert.equal(mine.board.find((b) => b.isMe).character.name, CAST.p1);
}

function theGuesserIsOfferedPassButNeverAGotItButton() {
  const g = game();
  const v = buildBoardView(g, 'p1', names);
  assert.equal(v.isMyTurn, true);
  assert.equal(v.buttons.pass, true);
  assert.equal(v.buttons.gotIt, false, 'only a typed guess can claim it');
  assert.equal(buildBoardView(g, 'p2', names).buttons, null);
}

function theLogShowsTheCurrentPlayersGuessesNewestFirst() {
  const g = game();
  guessing.submitGuess(g, 'p1', 'Batman', { others });
  guessing.submitGuess(g, 'p1', 'Superman', { others });
  assert.deepEqual(buildBoardView(g, 'p3', names).guesses.map((x) => x.text), ['Superman', 'Batman']);
}

// --- notes ----------------------------------------------------------------------------------

function notesAreSavedAndEveryoneSeesThem() {
  const g = game();
  assert.equal(notes.setNotes(g, 'p1', 'Not human. Has a sword?').ok, true);
  for (const viewer of g.turnOrder) {
    const mine = buildBoardView(g, viewer, names).board.find((b) => b.playerId === 'p1');
    assert.equal(mine.notes, 'Not human. Has a sword?', `${viewer} sees p1's notes`);
  }
}

// The one way a player's own answer could reach them: somebody else's notes. p2 can see p1 is
// Zorblax Quintavius; writing it down would show it to p1.
function notesThatNameAnotherPlayersCharacterAreRefused() {
  const g = game();
  for (const text of ['Alex is Zorblax Quintavius', 'alex = zorblax quintavius!', 'remember: Zorblax', 'Quintavius lol']) {
    const r = notes.setNotes(g, 'p2', text);
    assert.equal(r.ok, false, `refused: ${text}`);
    assert.match(r.error, /everyone can see/);
  }
  assert.equal(notes.notesOf(g, 'p2'), '', 'nothing was stored');
  assert.equal(JSON.stringify(buildBoardView(g, 'p1', names)).includes('Zorblax'), false);
}

function wholeWordsOnlySoAnInnocentNoteIsKept() {
  const g = createSetup({ order: ['p1', 'p2'], guildId: 'web', listIds: [1], difficulty: 'normal', characters: [row(1, 'Leo'), row(2, 'Mirelle Okonkwo')], turnSeconds: 60 });
  loop.startTurn(g);
  assert.equal(notes.setNotes(g, 'p2', 'maybe a leopard?').ok, true, '"Leo" is not in "leopard"');
  assert.equal(notes.setNotes(g, 'p2', 'Am I Leo?').ok, false, 'but Leo itself is');
}

function aGuessAtYourOwnCharacterIsFine() {
  const g = game();
  // p1 cannot know they are Zorblax, so naming it is a guess, not a leak -- and the check never
  // looks at the writer's own character.
  assert.equal(notes.setNotes(g, 'p1', 'Am I Zorblax Quintavius?').ok, true);
}

function onceTheyHaveItTheirNameIsFairGame() {
  const g = game();
  guessing.submitGuess(g, 'p1', 'Zorblax Quintavius', { others });
  assert.equal(notes.setNotes(g, 'p2', 'Alex was Zorblax Quintavius').ok, true);
}

function notesAreCapped() {
  const g = game();
  assert.equal(notes.setNotes(g, 'p1', 'x'.repeat(2000)).text.length, notes.NOTES_MAX);
}

// --- rooms ----------------------------------------------------------------------------------

// One registry, two games: a phone dealt into a computer game would be holding a client that
// cannot draw it.
function phonesAndComputersCannotJoinEachOthersRooms() {
  const reg = new RoomRegistry();
  const deskRoom = reg.createRoom({ hostPlayerId: 'h', nickname: 'Host', kind: 'desk' }).room;
  const partyRoom = reg.createRoom({ hostPlayerId: 'h2', nickname: 'Host2' }).room;
  assert.equal(deskRoom.publicState().kind, 'desk');
  assert.equal(partyRoom.kind, 'party', 'party is the default -- the phone client never says');

  const fromPhone = reg.joinRoom(deskRoom.code, { playerId: 'x', nickname: 'X' });
  assert.equal(fromPhone.ok, false);
  assert.match(fromPhone.error, /computer/);
  const fromComputer = reg.joinRoom(partyRoom.code, { playerId: 'y', nickname: 'Y', kind: 'desk' });
  assert.equal(fromComputer.ok, false);
  assert.match(fromComputer.error, /phone/);
  // Not even a seat-holder gets back in through the wrong game.
  assert.equal(reg.joinRoom(deskRoom.code, { playerId: 'h', nickname: 'Host' }).ok, false);
  assert.equal(reg.joinRoom(deskRoom.code, { playerId: 'z', nickname: 'Z', kind: 'desk' }).ok, true);
}

module.exports = {
  'a typed guess shows the table is not deserted': aTypedGuessShowsTheTableIsNotDeserted,
  'a ruling shows the table is not deserted': aRulingShowsTheTableIsNotDeserted,
  'notes are saved and everyone sees them': notesAreSavedAndEveryoneSeesThem,
  "notes that name another player's character are refused": notesThatNameAnotherPlayersCharacterAreRefused,
  'whole words only, so an innocent note is kept': wholeWordsOnlySoAnInnocentNoteIsKept,
  'a guess at your own character is fine': aGuessAtYourOwnCharacterIsFine,
  'once they have it, their name is fair game': onceTheyHaveItTheirNameIsFairGame,
  'notes are capped': notesAreCapped,
  'a correct guess ends the turn as got it': aCorrectGuessEndsTheTurnAsGotIt,
  'one word counts when nobody else has it': oneWordCountsWhenNobodyElseHasIt,
  'a wrong guess costs nothing and the turn goes on': aWrongGuessCostsNothingAndTheTurnGoesOn,
  'only the current player may guess': onlyTheCurrentPlayerMayGuess,
  'an empty guess is refused': anEmptyGuessIsRefused,
  'a close guess waits for the others': aCloseGuessWaitsForTheOthers,
  'an accepted ruling is got it': anAcceptedRulingIsGotIt,
  'a rejected ruling is a miss and the turn goes on': aRejectedRulingIsAMissAndTheTurnGoesOn,
  'the guesser cannot rule on their own guess': theGuesserCannotRuleOnTheirOwnGuess,
  'the first ruling settles it': theFirstRulingSettlesIt,
  'a ruling dies with its turn': aRulingDiesWithItsTurn,
  'a ruling nobody makes lapses as a miss': aRulingNobodyMakesLapsesAsAMiss,
  "nobody's view ever names their own character": nobodysViewEverNamesTheirOwnCharacter,
  'your own card turns over once you have it': yourOwnCardTurnsOverOnceYouHaveIt,
  'the guesser is offered pass but never a got-it button': theGuesserIsOfferedPassButNeverAGotItButton,
  "the log shows the current player's guesses newest first": theLogShowsTheCurrentPlayersGuessesNewestFirst,
  "phones and computers cannot join each other's rooms": phonesAndComputersCannotJoinEachOthersRooms,
};
