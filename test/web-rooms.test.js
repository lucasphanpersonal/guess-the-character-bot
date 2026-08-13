// Unit tests for the web room registry (src/web/rooms.js). Pure state, no socket.io, no
// network -- the same discipline the Discord game tests use with fake Discord objects.

const { assert } = require('./harness');
const { RoomRegistry, MAX_PLAYERS, CODE_LENGTH } = require('../src/web/rooms');

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

module.exports = {
  'creating a room seats the host and returns a code': creatingARoomSeatsTheHostAndReturnsACode,
  'creating a room needs a nickname': creatingARoomNeedsANickname,
  'joining by code adds a seated player': joiningByCodeAddsASeatedPlayer,
  'joining is case-insensitive on the code': joiningIsCaseInsensitiveOnTheCode,
  'joining an unknown code fails': joiningAnUnknownCodeFails,
  'a known playerId reconnects to the same seat': aKnownPlayerIdReconnectsToTheSameSeat,
  'connections are counted per seat': connectionsAreCountedPerSeat,
  'a late disconnect after reconnect does not flip offline': aLateDisconnectAfterReconnectDoesNotFlipOffline,
  'joining is capped at MAX_PLAYERS': joiningIsCappedAtMaxPlayers,
  'a started room refuses new players but lets known ones reconnect':
    aStartedRoomRefusesNewPlayersButLetsKnownOnesReconnect,
  'a finished room accepts a replacement player': aFinishedRoomAcceptsAReplacementPlayer,
  'a room mid-game still refuses new players': aRoomMidGameStillRefusesNewPlayers,
  'disconnecting keeps the seat and shows in state': disconnectingKeepsTheSeatAndShowsInState,
  'leaving reassigns host in join order': leavingReassignsHostInJoinOrder,
  'leaving as the last player deletes the room': leavingAsTheLastPlayerDeletesTheRoom,
  'nicknames are trimmed and length-capped': nicknamesAreTrimmedAndLengthCapped,
};
