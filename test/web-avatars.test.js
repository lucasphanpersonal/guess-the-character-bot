// The players' faces: the art (src/web/shared/avatars.js) and how a room hands them out
// (src/web/rooms.js). The server takes its count from the art file, so the art is checked here too:
// a sprite with a short row or an ink nobody defined draws wrong on every page and nothing else
// would notice.

const { assert } = require('./harness');
const Avatars = require('../src/web/shared/avatars');
const { RoomRegistry } = require('../src/web/rooms');

const roomOf = (n, kind = 'draw') => {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p0', nickname: 'P0', kind });
  for (let i = 1; i < n; i++) reg.joinRoom(room.code, { playerId: `p${i}`, nickname: `P${i}`, kind });
  return { reg, room };
};
const faces = (room) => room.publicState().players.map((p) => p.avatar);

module.exports = {
  'every sprite is a whole grid of known inks, with a name and a square'() {
    assert.ok(Avatars.count >= 8, `enough faces for a full Guess room (${Avatars.count})`);
    assert.equal(new Set(Avatars.names).size, Avatars.count, 'names are distinct');
    for (const s of [...Avatars.sprites, Avatars.nobody]) {
      assert.equal(s.rows.length, Avatars.grid, `${s.name} has ${Avatars.grid} rows`);
      for (const row of s.rows) {
        assert.equal(row.length, Avatars.grid, `${s.name}: "${row}" is ${Avatars.grid} wide`);
        for (const ch of row) {
          assert.ok(ch === '.' || ch in s.ink || ch in Avatars.inks, `${s.name}: ink "${ch}" is defined`);
        }
      }
      assert.match(s.bg, /^#[0-9a-f]{6}$/i, `${s.name} has a square`);
    }
  },

  'the markup holds only numbers and our own colours'() {
    const svg = Avatars.svg(0, 36);
    assert.match(svg, /^<svg class="avatar" width="36" height="36"/);
    // Anything the room could send is drawn as Nobody, never interpolated.
    for (const bad of [-1, Avatars.count, 1.5, '0', '<img>', null, undefined]) {
      assert.equal(Avatars.svg(bad), Avatars.svg(-1), `${String(bad)} draws as Nobody`);
    }
  },

  'everyone in a room starts with a face of their own'() {
    const { room } = roomOf(8, 'party');
    const f = faces(room);
    assert.ok(f.every((n) => Avatars.valid(n)), 'every seat has a real face');
    assert.equal(new Set(f).size, 8, 'no two alike');
  },

  'a newcomer gets the face their browser asked for when it is free, and another when it is not'() {
    const reg = new RoomRegistry();
    const { room } = reg.createRoom({ hostPlayerId: 'a', nickname: 'A', avatar: 3 });
    assert.equal(room.players.get('a').avatar, 3);
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'B', avatar: 3 });
    assert.notEqual(room.players.get('b').avatar, 3, 'taken, so another');
    assert.ok(Avatars.valid(room.players.get('b').avatar));
    // A reconnect keeps the face it wears, whatever it asks for.
    const before = room.players.get('b').avatar;
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'B', avatar: (before + 1) % Avatars.count });
    assert.equal(room.players.get('b').avatar, before);
  },

  'picking a free face takes it; a worn one is refused by name'() {
    const reg = new RoomRegistry();
    const { room } = reg.createRoom({ hostPlayerId: 'a', nickname: 'Alex', avatar: 0 });
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'Bo', avatar: 1 });
    assert.deepEqual(room.setAvatar('b', 5), { ok: true, avatar: 5 });
    assert.equal(room.publicState().players[1].avatar, 5);
    const res = room.setAvatar('b', 0);
    assert.equal(res.ok, false);
    assert.match(res.error, /Alex/);
    assert.match(res.error, new RegExp(Avatars.nameOf(0)));
    assert.equal(room.players.get('b').avatar, 5, 'unchanged');
    // Your own face again is fine.
    assert.equal(room.setAvatar('b', 5).ok, true);
    for (const bad of [-1, Avatars.count, 'cat', null, 2.5]) assert.equal(room.setAvatar('b', bad).ok, false, String(bad));
    assert.equal(room.setAvatar('nobody', 2).ok, false);
  },

  'a room with more people than faces shares them rather than refusing'() {
    const { room } = roomOf(Avatars.count + 4);
    const f = faces(room);
    assert.equal(new Set(f).size, Avatars.count, 'every face is worn before any is shared');
    // Every face is worn, so any face may be picked.
    const mine = room.players.get('p0').avatar;
    assert.equal(room.setAvatar('p0', (mine + 1) % Avatars.count).ok, true);
  },
};
