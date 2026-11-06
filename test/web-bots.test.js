// Test bots (src/web/bots.js): how a room treats a bot seat, and the pieces of the brains that are
// pure. The bots playing whole games over real sockets is the socket check's (# test bots).

const { assert } = require('./harness');
const { RoomRegistry } = require('../src/web/rooms');
const { typo } = require('../src/web/guess/bot');
const { doodle, pieces } = require('../src/web/draw/bot');
const { cleanPieceForTest } = (() => {
  // The server's own check on a piece, so a bot's drawing is held to exactly what a page's is.
  const { COLOURS, SIZES } = require('../src/web/draw/socket');
  return {
    cleanPieceForTest: (p) =>
      typeof p.id === 'string' && p.id.length > 0 && p.id.length <= 24 && COLOURS.has(p.color) && SIZES.has(p.size) &&
      p.points.length > 0 && p.points.length <= 400 && p.points.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1),
  };
})();

module.exports = {
  'a bot seat is published as one, and only a bot seat'() {
    const reg = new RoomRegistry();
    const { room } = reg.createRoom({ hostPlayerId: 'h', nickname: 'Host', kind: 'desk' });
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'Beep Bot', kind: 'desk', bot: true });
    reg.joinRoom(room.code, { playerId: 'p', nickname: 'Pat', kind: 'desk' });
    const players = room.publicState().players;
    assert.equal(players.find((p) => p.playerId === 'b').bot, true);
    assert.equal(players.find((p) => p.playerId === 'p').bot, undefined, 'a person carries no bot field at all');
    assert.equal(players.find((p) => p.playerId === 'h').bot, undefined);
  },

  'a host who leaves hands the room to the next person, never to a bot'() {
    const reg = new RoomRegistry();
    const { room } = reg.createRoom({ hostPlayerId: 'h', nickname: 'Host', kind: 'desk' });
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'Beep Bot', kind: 'desk', bot: true });
    reg.joinRoom(room.code, { playerId: 'p', nickname: 'Pat', kind: 'desk' });
    reg.leaveRoom(room.code, 'h');
    assert.equal(room.hostPlayerId, 'p', 'the person, though the bot joined first');
    reg.leaveRoom(room.code, 'p');
    assert.equal(room.hostPlayerId, 'b', 'with only bots left, one holds it until they go');
  },

  'a room with only bots connected is swept like an empty one'() {
    const reg = new RoomRegistry();
    const { room } = reg.createRoom({ hostPlayerId: 'h', nickname: 'Host', kind: 'draw' });
    reg.joinRoom(room.code, { playerId: 'b', nickname: 'Beep Bot', kind: 'draw', bot: true });
    reg.attachConnection(room.code, 'b', 'sock-b');
    const t0 = Date.now();
    assert.equal(reg.sweepAbandoned(1000, t0 + 2000), 1, 'the bot being connected does not keep it');
    assert.equal(reg.getRoom(room.code), null);

    const again = reg.createRoom({ hostPlayerId: 'h', nickname: 'Host', kind: 'draw' }).room;
    reg.attachConnection(again.code, 'h', 'sock-h');
    assert.equal(reg.sweepAbandoned(1000, t0 + 2000), 0, 'a person being connected still does');
  },

  'a bot typo is two letters swapped, and still the same letters'() {
    const t = typo('Hermione Granger');
    assert.notEqual(t, 'Hermione Granger');
    assert.equal([...t].sort().join(''), [...'Hermione Granger'].sort().join(''));
    assert.equal(typo('Al'), 'Al', 'too short to slip on: left alone');
  },

  "a bot's doodle is only what a page could send: palette, sizes, the canvas"() {
    const colours = ['#1b1033', '#e21b3c', '#ffffff'];
    const sizes = [3, 8, 18, 36];
    for (let n = 0; n < 20; n++) {
      const strokes = doodle({ colours, sizes });
      assert.ok(strokes.length >= 5, 'a face, two eyes, a smile and a scribble');
      assert.ok(strokes.every((s) => s.color !== '#ffffff'), 'never the eraser');
      const sent = pieces(strokes, `bxyz${n}`);
      assert.ok(sent.every(cleanPieceForTest), 'every piece passes the server\'s own check');
      assert.equal(new Set(sent.map((p) => p.id)).size, strokes.length, 'one id per stroke');
    }
  },
};
