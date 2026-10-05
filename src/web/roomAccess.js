// Getting a socket into a room -- shared by every web game's protocol.
//
// Creating, joining and identifying are the same for every game, and they are the part that
// faces strangers: nothing here is authenticated, anyone with the link can open a socket. So the
// two unauthenticated actions that cost something are bounded per connection, once, here, rather
// than in a copy per game that could drift. Room codes are only 32^4, which is guessable by
// machine but not by a person, so the join limit is what keeps a stranger from walking into a
// game rather than the code length.

const MAX_ROOMS_PER_SOCKET = 5;
const MAX_FAILED_JOINS = 20;

/**
 * The persistent player id a client sends in its handshake, or null after refusing the socket.
 * Seats are keyed by this, never the socket id, so a reconnect reclaims the same seat.
 */
function identify(socket) {
  const playerId = socket.handshake.auth?.playerId;
  if (!playerId) {
    socket.emit('room:error', { error: 'Missing player id.' });
    socket.disconnect(true);
    return null;
  }
  socket.data.playerId = playerId;
  socket.data.code = null;
  return playerId;
}

// Seat the socket: its socket.io room, and the registry's live-connection count for the seat.
function seat(socket, registry, room) {
  socket.data.code = room.code;
  socket.join(room.code);
  registry.attachConnection(room.code, socket.data.playerId, socket.id);
}

/** @returns {{ok: true, room} | {ok: false, error: string}} */
function createRoom(socket, registry, kind, nickname) {
  socket.data.created = (socket.data.created || 0) + 1;
  if (socket.data.created > MAX_ROOMS_PER_SOCKET) {
    return { ok: false, error: 'Too many rooms from this device. Reload the page.' };
  }
  const res = registry.createRoom({ hostPlayerId: socket.data.playerId, nickname, kind });
  if (!res.ok) return { ok: false, error: res.error };
  seat(socket, registry, res.room);
  return { ok: true, room: res.room };
}

/** @returns {{ok: true, room, reconnected: boolean} | {ok: false, error: string}} */
function joinRoom(socket, registry, kind, code, nickname) {
  if ((socket.data.failedJoins || 0) >= MAX_FAILED_JOINS) {
    return { ok: false, error: 'Too many failed attempts. Reload the page.' };
  }
  const res = registry.joinRoom(code, { playerId: socket.data.playerId, nickname, kind });
  if (!res.ok) {
    socket.data.failedJoins = (socket.data.failedJoins || 0) + 1;
    return { ok: false, error: res.error };
  }
  seat(socket, registry, res.room);
  return { ok: true, room: res.room, reconnected: res.reconnected };
}

module.exports = { identify, createRoom, joinRoom, MAX_ROOMS_PER_SOCKET, MAX_FAILED_JOINS };
