// The tilt gesture rules (src/web/party/public/tilt.js), which decide when a phone on a forehead has
// answered. Pure, so it can be driven here with a fake clock instead of a real accelerometer.
//
// Every case below is a bug somebody hit at a party. Tilting UP is irreversible -- it ends the
// turn and publishes the character the player is still wearing -- so the tests that matter most
// are the ones asserting it does NOT fire.

const { assert } = require('./harness');
const TiltRules = require('../src/web/party/public/tilt');

const UPRIGHT = 0.5;   // on a forehead
const FLAT = -9.8;     // face up on a table -- which reads as the strongest "got it" there is
const UP = -8;         // tilted to face the ceiling (tilt.js: negative z is up)
const DOWN = 8;        // tilted to face the floor

// Feeds one reading and returns what the caller was told to do.
function feed(state, z, now, opts = {}) {
  return TiltRules.step(state, { z, now, canGiveUp: !!opts.canGiveUp });
}

// --- arming -------------------------------------------------------------------------------

// The bug this exists for: a phone still flat on the table when the turn began used to fire a
// gesture instantly and repeatedly, burning whole turns without anyone touching it.
function aPhoneThatWasNeverUprightNeverFires() {
  const s = TiltRules.newState();
  let t = 0;
  for (let i = 0; i < 40; i++) assert.equal(feed(s, FLAT, (t += 100)).action, null);
  assert.equal(s.armed, false);
  // Even a textbook "got it" tilt does nothing while it has never been seen upright.
  for (let i = 0; i < 20; i++) assert.equal(feed(s, UP, (t += 100)).action, null);
}

function seeingItUprightArmsIt() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 100);
  assert.equal(s.armed, true);
}

// --- got it -------------------------------------------------------------------------------

function aHeldUpTiltFires() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  feed(s, UP, 100);                                   // direction starts here
  assert.equal(feed(s, UP, 100 + TiltRules.HOLD_UP_MS - 50).action, null, 'not yet');
  assert.equal(feed(s, UP, 100 + TiltRules.HOLD_UP_MS + 50).action, 'gotit');
}

// The asymmetry that stopped accidental wins: up needs a firmer, longer hold than down, because
// nodding along and lifting the phone back onto a forehead both produce an upward tilt.
function aBriefUpTiltDoesNotFire() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  feed(s, UP, 100);
  assert.equal(feed(s, UP, 100 + TiltRules.HOLD_DOWN_MS + 10).action, null, 'the shorter down hold must not win it');
  assert.ok(TiltRules.HOLD_UP_MS > TiltRules.HOLD_DOWN_MS);
  assert.ok(TiltRules.TILT_TH_UP > TiltRules.TILT_TH_DOWN);
}

// A tilt that never reaches the threshold is not an answer, however long it is held.
function aShallowTiltNeverFires() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  let t = 100;
  for (let i = 0; i < 30; i++) assert.equal(feed(s, -(TiltRules.TILT_TH_UP - 0.5), (t += 100)).action, null);
}

// Firing disarms: the phone has to come back to a forehead before it can answer again, so the
// hand returning from a tilt cannot be read as the next gesture.
function firingDisarmsUntilUprightAgain() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  feed(s, UP, 100);
  assert.equal(feed(s, UP, 900).action, 'gotit');
  assert.equal(s.armed, false);
  let t = 1000;
  for (let i = 0; i < 30; i++) assert.equal(feed(s, UP, (t += 100)).action, null, 'still disarmed');
  feed(s, UPRIGHT, (t += 100));
  assert.equal(s.armed, true);
}

// --- pass ---------------------------------------------------------------------------------

function aHeldDownTiltPasses() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  feed(s, DOWN, 100);
  assert.equal(feed(s, DOWN, 100 + TiltRules.HOLD_DOWN_MS + 50).action, 'pass');
}

// --- reading the angles ---------------------------------------------------------------------
//
// The raw accelerometer's sign differs between browsers, which swapped "got it" and "pass" for
// some Android players. The orientation angles do not, so these pin the angle conversion to the
// physical postures: whichever way the phone is turned in its own plane, facing the ceiling is
// "got it" and facing the floor is "pass".

const fromAngles = (beta, gamma) => TiltRules.gestureFor(TiltRules.zFromAngles(beta, gamma));

function anglesReadFaceUpAsUpAndFaceDownAsDown() {
  assert.ok(TiltRules.zFromAngles(0, 0) < -9.7, 'flat, face up');
  assert.ok(TiltRules.zFromAngles(180, 0) > 9.7, 'flat, face down');
  assert.ok(TiltRules.zFromAngles(-180, 0) > 9.7, 'flat, face down (beta wraps)');
}

function anglesReadUprightAsUprightInEitherOrientation() {
  assert.ok(TiltRules.isUpright(TiltRules.zFromAngles(90, 0)), 'portrait, upright');
  assert.ok(TiltRules.isUpright(TiltRules.zFromAngles(-90, 0)), 'portrait, upside down');
  assert.ok(TiltRules.isUpright(TiltRules.zFromAngles(0, 90)), 'landscape, one way');
  assert.ok(TiltRules.isUpright(TiltRules.zFromAngles(0, -89)), 'landscape, the other');
}

// The forehead is held landscape, where beta barely moves and the whole gesture is in gamma
// (tilting toward the ceiling) or in beta flipping past 90 (toward the floor).
function anglesGiveTheRightGestureInLandscape() {
  assert.equal(fromAngles(0, 40), 'gotit', 'landscape, tilted to the ceiling');
  assert.equal(fromAngles(0, -40), 'gotit', 'landscape the other way, tilted to the ceiling');
  assert.equal(fromAngles(180, 50), 'pass', 'landscape, tilted to the floor');
  assert.equal(fromAngles(-180, -50), 'pass', 'landscape the other way, tilted to the floor');
  assert.equal(fromAngles(5, 75), null, 'a nod is not a gesture');
}

function anglesGiveTheRightGestureInPortrait() {
  assert.equal(fromAngles(40, 0), 'gotit', 'portrait, tilted to the ceiling');
  assert.equal(fromAngles(140, 0), 'pass', 'portrait, tilted to the floor');
}

// Up is the irreversible direction and asks for more tilt; the angles must not erode that.
function upNeedsMoreTiltThanDownFromAnglesToo() {
  // ~37 degrees off upright: enough to pass, not enough to publish the character.
  assert.equal(fromAngles(0, 53), null, '37 degrees toward the ceiling');
  assert.equal(fromAngles(180, 53), 'pass', '37 degrees toward the floor');
}

function missingAnglesAreNoReading() {
  assert.equal(TiltRules.zFromAngles(null, 10), null);
  assert.equal(TiltRules.zFromAngles(10, null), null);
}

// --- give up ------------------------------------------------------------------------------

function givingUpNeedsTheLongHold() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  let out = feed(s, DOWN, 100, { canGiveUp: true });
  assert.equal(out.action, null);
  out = feed(s, DOWN, 100 + TiltRules.HOLD_DOWN_MS + 50, { canGiveUp: true });
  assert.equal(out.action, null, 'a pass-length hold must not give up');
  assert.ok(out.giveUpFraction > 0 && out.giveUpFraction < 1, 'it reports progress meanwhile');
  out = feed(s, DOWN, 100 + TiltRules.GIVEUP_HOLD_MS + 10, { canGiveUp: true });
  assert.equal(out.action, 'giveup');
}

// The bug: the hold used to ride on the same timestamp as the strict gesture, which resets the
// instant the reading dips below the threshold -- and holding a phone down for nearly a second
// and a half produces plenty of momentary dips. Every dip restarted the clock, so the hold could
// never complete and tilting down as the last player appeared to do nothing at all.
function aMomentaryDipDoesNotRestartTheHold() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  feed(s, DOWN, 100, { canGiveUp: true });
  feed(s, UPRIGHT, 400, { canGiveUp: true });            // a wobble, well inside the gap
  feed(s, DOWN, 500, { canGiveUp: true });
  assert.equal(feed(s, DOWN, 100 + TiltRules.GIVEUP_HOLD_MS + 10, { canGiveUp: true }).action, 'giveup');
}

// Genuinely raising the phone back to your forehead aborts it -- a give-up is irreversible and
// public, so letting go has to mean letting go.
function raisingTheP1honeAbortsTheHold() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  feed(s, DOWN, 100, { canGiveUp: true });
  feed(s, UPRIGHT, 200, { canGiveUp: true });
  feed(s, UPRIGHT, 200 + TiltRules.GIVEUP_GAP_MS + 50, { canGiveUp: true }); // held away past the gap
  assert.equal(s.giveUpStart, 0, 'the hold was abandoned');
  const out = feed(s, DOWN, 100 + TiltRules.GIVEUP_HOLD_MS + 10, { canGiveUp: true });
  assert.equal(out.action, null, 'the old start time must not carry over into an instant give-up');
}

// While the give-up hold is counting it owns the gesture, or a long press down would also be
// read as a pass on its way through.
function theHoldOwnsTheGestureWhileCounting() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  feed(s, DOWN, 100, { canGiveUp: true });
  for (let t = 200; t < TiltRules.GIVEUP_HOLD_MS; t += 100) {
    assert.equal(feed(s, DOWN, t, { canGiveUp: true }).action, null);
  }
}

// Down means pass when there IS somebody to pass to, and the give-up tracker stays out of it.
function downIsAPassWhenGivingUpIsNotOffered() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0);
  feed(s, DOWN, 100);
  assert.equal(feed(s, DOWN, 100 + TiltRules.GIVEUP_HOLD_MS + 10).action, 'pass');
}

function theHoldTicksAudiblyAsItCounts() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  feed(s, DOWN, 100, { canGiveUp: true });
  const ticks = [];
  for (let t = 150; t < 100 + TiltRules.GIVEUP_HOLD_MS; t += 50) {
    if (feed(s, DOWN, t, { canGiveUp: true }).giveUpTick) ticks.push(t);
  }
  assert.ok(ticks.length >= 2, `the room should hear it counting (got ${ticks.length} ticks)`);
}

// --- housekeeping -------------------------------------------------------------------------

function resetClearsTheHoldButNotTheArming() {
  const s = TiltRules.newState();
  feed(s, UPRIGHT, 0, { canGiveUp: true });
  feed(s, DOWN, 100, { canGiveUp: true });
  TiltRules.reset(s);
  assert.equal(s.giveUpStart, 0);
  assert.equal(s.dir, null);
}

function noReadingYetIsNotAGesture() {
  const s = TiltRules.newState();
  assert.equal(feed(s, null, 100).action, null);
  assert.equal(s.armed, false);
  assert.equal(TiltRules.gestureFor(null), null);
  assert.equal(TiltRules.isUpright(null), false);
}

module.exports = {
  'a phone that was never upright never fires': aPhoneThatWasNeverUprightNeverFires,
  'seeing it upright arms it': seeingItUprightArmsIt,
  'a held up tilt fires': aHeldUpTiltFires,
  'a brief up tilt does not fire': aBriefUpTiltDoesNotFire,
  'a shallow tilt never fires': aShallowTiltNeverFires,
  'firing disarms until upright again': firingDisarmsUntilUprightAgain,
  'a held down tilt passes': aHeldDownTiltPasses,
  'angles: face up is up, face down is down': anglesReadFaceUpAsUpAndFaceDownAsDown,
  'angles: upright in either orientation': anglesReadUprightAsUprightInEitherOrientation,
  'angles: right gesture in landscape': anglesGiveTheRightGestureInLandscape,
  'angles: right gesture in portrait': anglesGiveTheRightGestureInPortrait,
  'angles: up still needs more tilt than down': upNeedsMoreTiltThanDownFromAnglesToo,
  'angles: missing angles are no reading': missingAnglesAreNoReading,
  'giving up needs the long hold': givingUpNeedsTheLongHold,
  'a momentary dip does not restart the hold': aMomentaryDipDoesNotRestartTheHold,
  'raising the phone aborts the hold': raisingTheP1honeAbortsTheHold,
  'the hold owns the gesture while counting': theHoldOwnsTheGestureWhileCounting,
  'down is a pass when giving up is not offered': downIsAPassWhenGivingUpIsNotOffered,
  'the hold ticks audibly as it counts': theHoldTicksAudiblyAsItCounts,
  'reset clears the hold': resetClearsTheHoldButNotTheArming,
  'no reading yet is not a gesture': noReadingYetIsNotAGesture,
};
