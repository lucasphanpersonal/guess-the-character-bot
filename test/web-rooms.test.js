// Unit tests for the web room registry (src/web/rooms.js). Pure state, no socket.io, no
// network.

const { assert } = require('./harness');
const { RoomRegistry, MAX_PLAYERS, maxPlayersFor, CODE_LENGTH } = require('../src/web/rooms');

function creatingARoomSeatsTheHostAndReturnsACode() {
  const reg = new RoomRegistry();
  const { ok, room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  assert.equal(ok, true);
  assert.equal(room.code.length, CODE_LENGTH);
  assert.equal(room.hostPlayerId, 'p1');
  const state = room.publicState();
  assert.equal(state.players.length, 1);
  assert.equal(state.players[0].nickname, 'Alex');
  assert.equal(state.players[0].isHost, true);
  // A fresh seat has no live socket yet -- the socket layer attaches one on connect.
  assert.equal(state.players[0].connected, false);
}

function creatingARoomNeedsANickname() {
  const reg = new RoomRegistry();
  const res = reg.createRoom({ hostPlayerId: 'p1', nickname: '   ' });
  assert.equal(res.ok, false);
  assert.match(res.error, /nickname/i);
}

function joiningByCodeAddsASeatedPlayer() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  const res = reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  assert.equal(res.ok, true);
  assert.equal(res.reconnected, false);
  const nicks = room.publicState().players.map((p) => p.nickname);
  assert.deepEqual(nicks, ['Alex', 'Sam']);
}

function joiningIsCaseInsensitiveOnTheCode() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  const res = reg.joinRoom(room.code.toLowerCase(), { playerId: 'p2', nickname: 'Sam' });
  assert.equal(res.ok, true);
}

function joiningAnUnknownCodeFails() {
  const reg = new RoomRegistry();
  const res = reg.joinRoom('ZZZZ', { playerId: 'p2', nickname: 'Sam' });
  assert.equal(res.ok, false);
  assert.match(res.error, /no room/i);
}

function aKnownPlayerIdReconnectsToTheSameSeat() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  reg.attachConnection(room.code, 'p2', 'sock-A');
  reg.detachConnection(room.code, 'p2', 'sock-A'); // dropped

  // Same playerId comes back -- no new seat, rename honoured, and a fresh socket reconnects it.
  const res = reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sammy' });
  assert.equal(res.ok, true);
  assert.equal(res.reconnected, true);
  assert.equal(room.players.size, 2);
  reg.attachConnection(room.code, 'p2', 'sock-B');
  assert.equal(reg.isConnected(room.code, 'p2'), true);
  assert.equal(room.players.get('p2').nickname, 'Sammy');
}

function connectionsAreCountedPerSeat() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  // Two tabs / sockets on one seat.
  reg.attachConnection(room.code, 'p1', 's1');
  reg.attachConnection(room.code, 'p1', 's2');
  assert.equal(reg.isConnected(room.code, 'p1'), true);
  // Dropping one is not "offline" while the other holds it.
  assert.equal(reg.detachConnection(room.code, 'p1', 's1').nowOffline, false);
  assert.equal(reg.isConnected(room.code, 'p1'), true);
  // Dropping the last one is.
  assert.equal(reg.detachConnection(room.code, 'p1', 's2').nowOffline, true);
  assert.equal(reg.isConnected(room.code, 'p1'), false);
}

function aLateDisconnectAfterReconnectDoesNotFlipOffline() {
  // Reconnect ordering: the new socket connects before the old one's disconnect arrives.
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.attachConnection(room.code, 'p1', 'old');
  reg.attachConnection(room.code, 'p1', 'new'); // reconnected before old dropped
  const { nowOffline } = reg.detachConnection(room.code, 'p1', 'old'); // stale disconnect lands
  assert.equal(nowOffline, false);
  assert.equal(reg.isConnected(room.code, 'p1'), true);
}

function joiningIsCappedAtMaxPlayers() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Host' });
  for (let i = 2; i <= MAX_PLAYERS; i++) {
    assert.equal(reg.joinRoom(room.code, { playerId: `p${i}`, nickname: `P${i}` }).ok, true);
  }
  const overflow = reg.joinRoom(room.code, { playerId: 'pX', nickname: 'Late' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /full/i);
}

// Drawing has no forehead-game shape to keep: it takes a whole party -- and still has a ceiling,
// published in the room state for the client to show.
function aDrawingRoomTakesAWholePartyButStillHasACeiling() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'd1', nickname: 'Host', kind: 'draw' });
  const cap = maxPlayersFor('draw');
  assert.ok(cap > MAX_PLAYERS, 'more than the guessing games');
  assert.equal(room.publicState().maxPlayers, cap);
  for (let i = 2; i <= cap; i++) {
    assert.equal(reg.joinRoom(room.code, { playerId: `d${i}`, nickname: `D${i}`, kind: 'draw' }).ok, true, `seat ${i}`);
  }
  const overflow = reg.joinRoom(room.code, { playerId: 'dX', nickname: 'Late', kind: 'draw' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /full/i);
  // And the guessing games are where they were.
  assert.equal(maxPlayersFor('party'), MAX_PLAYERS);
  assert.equal(maxPlayersFor('desk'), MAX_PLAYERS);
}

function aStartedRoomRefusesNewPlayersButLetsKnownOnesReconnect() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  room.status = 'playing';

  const stranger = reg.joinRoom(room.code, { playerId: 'p3', nickname: 'Late' });
  assert.equal(stranger.ok, false);
  assert.match(stranger.error, /already started/i);

  const known = reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  assert.equal(known.ok, true);
  assert.equal(known.reconnected, true);
}

// A finished room is BETWEEN games. Refusing new players there meant that when somebody left
// after a game, the host could not rematch (too few players) and could not fix it either --
// the replacement was turned away at the door.
function aFinishedRoomAcceptsAReplacementPlayer() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  room.status = 'finished';

  const res = reg.joinRoom(room.code, { playerId: 'p3', nickname: 'Kira' });
  assert.equal(res.ok, true, 'a new player can join a finished room');
  assert.equal(room.players.size, 3);
}

function aRoomMidGameStillRefusesNewPlayers() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  room.status = 'playing';
  const res = reg.joinRoom(room.code, { playerId: 'pX', nickname: 'Late' });
  assert.equal(res.ok, false);
  assert.match(res.error, /already started/i);
}

function disconnectingKeepsTheSeatAndShowsInState() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  reg.attachConnection(room.code, 'p2', 's2');
  const { nowOffline } = reg.detachConnection(room.code, 'p2', 's2');
  assert.equal(nowOffline, true);
  assert.equal(room.players.size, 2);
  const sam = room.publicState().players.find((p) => p.playerId === 'p2');
  assert.equal(sam.connected, false);
}

function leavingReassignsHostInJoinOrder() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  reg.joinRoom(room.code, { playerId: 'p3', nickname: 'Kira' });

  const { room: after, deleted } = reg.leaveRoom(room.code, 'p1');
  assert.equal(deleted, false);
  assert.equal(after.hostPlayerId, 'p2'); // next in join order
  assert.equal(after.publicState().players.find((p) => p.isHost).nickname, 'Sam');
}

function leavingAsTheLastPlayerDeletesTheRoom() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  const { room: after, deleted } = reg.leaveRoom(room.code, 'p1');
  assert.equal(deleted, true);
  assert.equal(after, null);
  assert.equal(reg.getRoom(room.code), null);
}

function nicknamesAreTrimmedAndLengthCapped() {
  const reg = new RoomRegistry();
  const long = 'x'.repeat(50);
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: `  ${long}  ` });
  assert.equal(room.players.get('p1').nickname.length, 20);
}

// A game in progress still lists a player who has left -- in its turn order, its reveal, and the
// final standings -- and all of those read names off the roster. Losing the name there turned
// them into "Player" on the results screen they are still on.
function aDepartedPlayerKeepsTheirNameForTheStandings() {
  const reg = new RoomRegistry();
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });

  reg.leaveRoom(room.code, 'p2');
  assert.equal(room.players.has('p2'), false);
  assert.equal(room.departedNames.get('p2'), 'Sam');

  // Coming back retakes the seat; the roster is what names them again.
  reg.joinRoom(room.code, { playerId: 'p2', nickname: 'Sam' });
  assert.equal(room.players.get('p2').nickname, 'Sam');
}

// Each game's socket layer stops its own timers through this. Fired however a room goes, and
// only when it goes: a room that merely lost one of its players still has a game to run.
function everyWayARoomIsDeletedIsAnnounced() {
  const reg = new RoomRegistry();
  const gone = [];
  reg.onRoomDeleted((room) => gone.push(room.code));

  const { room: left } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  reg.joinRoom(left.code, { playerId: 'p2', nickname: 'Sam' });
  reg.leaveRoom(left.code, 'p1');
  assert.deepEqual(gone, [], 'one of two leaving deletes nothing');
  reg.leaveRoom(left.code, 'p2');
  assert.deepEqual(gone, [left.code], 'the last to leave deletes it');

  const { room: swept } = reg.createRoom({ hostPlayerId: 'p3', nickname: 'Kira' });
  assert.equal(reg.sweepAbandoned(1000, swept.createdAt + 2000), 1);
  assert.deepEqual(gone, [left.code, swept.code], 'and so does the sweep');
}

// A teardown that throws must not stop the room going, or the others' teardowns running.
function aFailingTeardownDoesNotKeepTheRoom() {
  const reg = new RoomRegistry();
  let ran = false;
  reg.onRoomDeleted(() => { throw new Error('boom'); });
  reg.onRoomDeleted(() => { ran = true; });
  const { room } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    reg.leaveRoom(room.code, 'p1');
  } finally {
    console.warn = warn;
  }
  assert.equal(reg.getRoom(room.code), null);
  assert.equal(ran, true);
}

// The host keeper restarts the server to deploy only when nobody would lose a room by it.
function activityCountsRoomsWithAPersonInThemAndThoseMidGame() {
  const reg = new RoomRegistry();
  assert.deepEqual(reg.activity(), { occupied: 0, inGame: 0 });
  const { room: empty } = reg.createRoom({ hostPlayerId: 'p1', nickname: 'Alex' });
  assert.deepEqual(reg.activity(), { occupied: 0, inGame: 0 }, 'a seat nobody is connected to is nobody');
  reg.attachConnection(empty.code, 'p1', 's1');
  assert.deepEqual(reg.activity(), { occupied: 1, inGame: 0 }, 'a lobby with someone in it');
  const { room: game } = reg.createRoom({ hostPlayerId: 'p2', nickname: 'Sam' });
  reg.attachConnection(game.code, 'p2', 's2');
  for (const status of ['setup', 'countdown', 'playing']) {
    game.status = status;
    assert.deepEqual(reg.activity(), { occupied: 2, inGame: 1 }, status);
  }
  game.status = 'finished';
  assert.deepEqual(reg.activity(), { occupied: 2, inGame: 0 }, 'the results screen is not a game in progress');
  game.status = 'playing';
  reg.detachConnection(game.code, 'p2', 's2');
  game.addSeat('bot1', 'Bot', 0, { bot: true });
  game.players.get('bot1').conns.add('bot-sock');
  assert.deepEqual(reg.activity(), { occupied: 1, inGame: 0 }, 'a bot is not somebody being there');
}

module.exports = {
  'every way a room is deleted is announced': everyWayARoomIsDeletedIsAnnounced,
  'a failing teardown does not keep the room': aFailingTeardownDoesNotKeepTheRoom,
  'creating a room seats the host and returns a code': creatingARoomSeatsTheHostAndReturnsACode,
  'creating a room needs a nickname': creatingARoomNeedsANickname,
  'joining by code adds a seated player': joiningByCodeAddsASeatedPlayer,
  'joining is case-insensitive on the code': joiningIsCaseInsensitiveOnTheCode,
  'joining an unknown code fails': joiningAnUnknownCodeFails,
  'a known playerId reconnects to the same seat': aKnownPlayerIdReconnectsToTheSameSeat,
  'connections are counted per seat': connectionsAreCountedPerSeat,
  'a late disconnect after reconnect does not flip offline': aLateDisconnectAfterReconnectDoesNotFlipOffline,
  'joining is capped at MAX_PLAYERS': joiningIsCappedAtMaxPlayers,
  'a drawing room takes a whole party, but still has a ceiling': aDrawingRoomTakesAWholePartyButStillHasACeiling,
  'a started room refuses new players but lets known ones reconnect':
    aStartedRoomRefusesNewPlayersButLetsKnownOnesReconnect,
  'a finished room accepts a replacement player': aFinishedRoomAcceptsAReplacementPlayer,
  'a room mid-game still refuses new players': aRoomMidGameStillRefusesNewPlayers,
  'disconnecting keeps the seat and shows in state': disconnectingKeepsTheSeatAndShowsInState,
  'leaving reassigns host in join order': leavingReassignsHostInJoinOrder,
  'leaving as the last player deletes the room': leavingAsTheLastPlayerDeletesTheRoom,
  'nicknames are trimmed and length-capped': nicknamesAreTrimmedAndLengthCapped,
  'a departed player keeps their name for the standings': aDepartedPlayerKeepsTheirNameForTheStandings,
  'activity counts rooms with a person in them, and those mid-game': activityCountsRoomsWithAPersonInThemAndThoseMidGame,
};
