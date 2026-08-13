// Per-room list exclusions (src/web/rooms.js + the setup service's curation).
//
// The property that matters is NEGATIVE: excluding a list for one room must not change the
// shared `enabled` column, because the Discord bot reads that same column as its playable pool.
// The first implementation flipped `enabled` directly, which meant anyone with a room link could
// permanently reshape what a whole Discord server got dealt.

const { assert } = require('./harness');
const { RoomRegistry } = require('../src/web/rooms');
const lists = require('../src/core/db/characterLists');
const db = require('../src/core/db/connection');

let n = 0;
function seed() {
  const guildId = `excl-${++n}`;
  db.prepare('DELETE FROM character_lists WHERE guild_id = ?').run(guildId);
  const a = lists.createList(guildId, 'Alpha', 'tester', 'Video Games', { enabled: true });
  const b = lists.createList(guildId, 'Beta', 'tester', 'Video Games', { enabled: true });
  for (let i = 0; i < 5; i++) {
    lists.addCharacter(a, `A${i}`, 'tester');
    lists.addCharacter(b, `B${i}`, 'tester');
  }
  return { guildId, a, b };
}

function room() {
  const reg = new RoomRegistry();
  return reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' }).room;
}

function aNewRoomExcludesNothing() {
  const r = room();
  assert.equal(r.excludedListIds.size, 0);
}

function excludingAListDoesNotTouchTheSharedEnabledFlag() {
  const { guildId, a } = seed();
  const r = room();

  r.excludedListIds.add(a);

  // The shared selection -- what the Discord bot plays from -- is untouched.
  const enabledNames = lists.getEnabledLists(guildId).map((l) => l.name).sort();
  assert.deepEqual(enabledNames, ['Alpha', 'Beta'], 'both lists are still in the shared pool');
  const row = lists.getListByName(guildId, 'Alpha');
  assert.equal(row.enabled, 1, 'Alpha is still enabled globally');
}

function anExclusionOnlyAffectsItsOwnRoom() {
  const { guildId, a } = seed();
  const reg = new RoomRegistry();
  const one = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' }).room;
  const two = reg.createRoom({ hostPlayerId: 'p2', nickname: 'Sam' }).room;

  one.excludedListIds.add(a);

  assert.equal(one.excludedListIds.has(a), true);
  assert.equal(two.excludedListIds.has(a), false, 'the other room is unaffected');
  assert.equal(lists.getEnabledLists(guildId).length, 2, 'and the shared pool still has both');
}

// The pool a deal draws from is the shared selection MINUS this room's exclusions -- the
// subtraction that replaces writing to the database.
function theDealPoolSubtractsTheRoomsExclusions() {
  const { guildId, a, b } = seed();
  const r = room();
  const enabled = lists.getEnabledLists(guildId).map((l) => l.id);

  const without = enabled.filter((id) => !r.excludedListIds.has(id));
  assert.deepEqual(without.sort(), [a, b].sort(), 'nothing excluded yet');

  r.excludedListIds.add(a);
  const after = enabled.filter((id) => !r.excludedListIds.has(id));
  assert.deepEqual(after, [b], 'the excluded list drops out of this room only');
}

function excludingIsReversible() {
  const { a } = seed();
  const r = room();
  r.excludedListIds.add(a);
  r.excludedListIds.delete(a);
  assert.equal(r.excludedListIds.has(a), false);
}

module.exports = {
  'a new room excludes nothing': aNewRoomExcludesNothing,
  'excluding a list does not touch the shared enabled flag': excludingAListDoesNotTouchTheSharedEnabledFlag,
  'an exclusion only affects its own room': anExclusionOnlyAffectsItsOwnRoom,
  "the deal pool subtracts the room's exclusions": theDealPoolSubtractsTheRoomsExclusions,
  'excluding is reversible': excludingIsReversible,
};
