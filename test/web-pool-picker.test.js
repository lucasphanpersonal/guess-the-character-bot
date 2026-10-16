// The pool picker's server side (src/web/content.js): several categories played together, and a
// room switching many lists on or off at once. Real compendium, throwaway DB.
//
// The property that matters is that ids from a client are trusted only once every one of them
// checks out, and that nothing here ever writes the web's shared selection.

const { assert } = require('./harness');
const { RoomRegistry } = require('../src/web/rooms');
const lists = require('../src/compendium/characterLists');
const web = require('../src/web/content');

let n = 0;
// Two fresh categories of the web's own, so nothing else in the DB can land in them.
function seed() {
  const tag = `pp${++n}-${Date.now()}`;
  const catA = `Picker A ${tag}`;
  const catB = `Picker B ${tag}`;
  const a1 = lists.createList(web.WEB_SCOPE, `A1 ${tag}`, 'tester', catA, { enabled: true });
  const a2 = lists.createList(web.WEB_SCOPE, `A2 ${tag}`, 'tester', catA, { enabled: true });
  const b1 = lists.createList(web.WEB_SCOPE, `B1 ${tag}`, 'tester', catB, { enabled: true });
  const hidden = lists.createList(`someone-else-${tag}`, `H ${tag}`, 'tester', catA, { enabled: true });
  return { catA, catB, a1, a2, b1, hidden };
}
const room = () => new RoomRegistry().createRoom({ hostPlayerId: 'p1', nickname: 'Alex' }).room;
const sorted = (xs) => [...xs].map(Number).sort((x, y) => x - y);

function severalCategoriesPlayTogether() {
  const { catA, catB, a1, a2, b1 } = seed();
  const r = web.resolvePool({ poolType: 'categories', categories: [catA, catB], excluded: room().excludedListIds });
  assert.deepEqual(sorted(r.listIds), sorted([a1, a2, b1]));
  assert.equal(r.label, `${catA} + ${catB}`);
}

function aRoomsExclusionsApplyAcrossCategories() {
  const { catA, catB, a1, a2, b1 } = seed();
  const rm = room();
  rm.excludedListIds.add(a1);
  const r = web.resolvePool({ poolType: 'categories', categories: [catA, catB], excluded: rm.excludedListIds });
  assert.deepEqual(sorted(r.listIds), sorted([a2, b1]));
}

function anUnknownCategoryContributesNothing() {
  const { catA, a1, a2 } = seed();
  const r = web.resolvePool({ poolType: 'categories', categories: [catA, 'No Such Category', catA], excluded: new Set() });
  assert.deepEqual(sorted(r.listIds), sorted([a1, a2]), 'and a repeated one counts once');
}

function theOldSingleCategoryShapeStillWorks() {
  const { catA, a1, a2 } = seed();
  const r = web.resolvePool({ poolType: 'category', category: catA, excluded: new Set() });
  assert.deepEqual(sorted(r.listIds), sorted([a1, a2]));
}

function noneThenAllSwitchesEveryListInOneGo() {
  const { a1, a2 } = seed();
  const rm = room();
  const off = web.setListsPlaying([a1, a2], false, rm);
  assert.deepEqual(off, { ok: true, playing: [false, false] });
  assert.equal(rm.excludedListIds.has(a1) && rm.excludedListIds.has(a2), true);
  const on = web.setListsPlaying([a1, a2], true, rm);
  assert.deepEqual(on.playing, [true, true]);
  assert.equal(rm.excludedListIds.size, 0);
  // The web's own selection is untouched throughout.
  assert.equal(lists.getListsByIds([a1], web.WEB_SCOPE)[0].enabled, 1);
}

function oneBadIdChangesNothing() {
  const { a1, hidden } = seed();
  const rm = room();
  assert.equal(web.setListsPlaying([a1, hidden], false, rm).ok, false, "another scope's private list");
  assert.equal(web.setListsPlaying([a1, 99999999], false, rm).ok, false);
  assert.equal(web.setListsPlaying([a1, 'x'], false, rm).ok, false);
  assert.equal(web.setListsPlaying([], false, rm).ok, false);
  assert.equal(rm.excludedListIds.size, 0, 'not half of the request');
}

// A host's remembered opt-outs, put back into a new room by their browser.
function rememberedListsGoBackOffInANewRoom() {
  const { a1, a2 } = seed();
  const rm = room();
  assert.deepEqual(sorted(web.keepListsOff([a1, a2], rm).off), sorted([a1, a2]));
  assert.equal(rm.excludedListIds.has(a1) && rm.excludedListIds.has(a2), true);
  assert.equal(lists.getListsByIds([a1], web.WEB_SCOPE)[0].enabled, 1, "the web's selection is untouched");
  // Again is harmless: off stays off, nothing flips back on.
  web.keepListsOff([a1], rm);
  assert.equal(rm.excludedListIds.has(a1), true);
}

function aRememberedListThatIsGoneIsSkippedNotFatal() {
  const { a1, hidden } = seed();
  const rm = room();
  const res = web.keepListsOff([a1, hidden, 99999999, 'x'], rm);
  assert.deepEqual(res, { ok: true, off: [a1] }, "another scope's list and a missing one are skipped; the rest still apply");
  assert.deepEqual(sorted(rm.excludedListIds), [a1]);
  assert.deepEqual(web.keepListsOff(undefined, rm), { ok: true, off: [] });
}

function aSingleTickStillFlips() {
  const { a1 } = seed();
  const rm = room();
  assert.deepEqual(web.toggleList(a1, rm), { ok: true, playing: false });
  assert.deepEqual(web.toggleList(String(a1), rm), { ok: true, playing: true });
}

module.exports = {
  'several categories play together': severalCategoriesPlayTogether,
  "a room's exclusions apply across categories": aRoomsExclusionsApplyAcrossCategories,
  'an unknown category contributes nothing': anUnknownCategoryContributesNothing,
  'the old single-category shape still works': theOldSingleCategoryShapeStillWorks,
  'none then all switches every list in one go': noneThenAllSwitchesEveryListInOneGo,
  'one bad id changes nothing': oneBadIdChangesNothing,
  'a single tick still flips': aSingleTickStillFlips,
  'remembered lists go back off in a new room': rememberedListsGoBackOffInANewRoom,
  'a remembered list that is gone is skipped, not fatal': aRememberedListThatIsGoneIsSkippedNotFatal,
};
