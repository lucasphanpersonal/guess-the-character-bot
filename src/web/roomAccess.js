// Getting a socket into a room -- shared by every web game's protocol.
//
// Creating, joining and identifying are the same for every game, and they are the part that
// faces strangers: nothing here is authenticated, anyone with the link can open a socket. So the
// unauthenticated actions that cost something are bounded here, once, rather than in a copy per
// game that could drift -- per connection AND per client (./rateLimit.js), because a new
// connection is free. Room codes are only 32^4, which is guessable by machine but not by a person,
// so these limits are what keep a stranger from walking into a game, not the code length.
//
// IDENTITY. A browser keeps a random secret (its "player id", in localStorage) and sends it in
// the handshake. That secret is never sent back out to anyone. The seat is keyed by a PUBLIC id
// derived from it with a server-side key, and that public id is what room state, rosters, views
// and kick targets carry. The secret used to BE the seat id and was published to the whole room:
// anyone who read the host's id off the roster could connect with it and become the host, and on
// the computers, joining as the next player shows you their board -- which has your own character
// on it. Deriving rather than storing keeps reconnects exact (same secret, same seat) with no
// table to keep; the key changes on a restart, which is fine because rooms do not survive one.

const crypto = require('crypto');
const { clientKey, createLimiter } = require('./rateLimit');

const MAX_ROOMS_PER_SOCKET = 5;
const MAX_FAILED_JOINS = 20;
const SECRET_MAX = 200;

const SEAT_KEY = crypto.randomBytes(32);

// Per client, so reconnecting does not reset them. Generous for real use: a party on one Wi-Fi
// shares an address, and a host may make a few rooms in an evening.
const failedJoinsByClient = createLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
const roomsByClient = createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });

/** The public seat id for a browser's secret. Deterministic for the life of the process. */
function publicIdOf(secret) {
  return `p_${crypto.createHmac('sha256', SEAT_KEY).update(String(secret)).digest('base64url').slice(0, 16)}`;
}

const clientOf = (socket) => clientKey(socket.handshake?.headers, socket.handshake?.address);

/**
 * Identifies a socket from the secret in its handshake, or refuses it (null).
 *
 * socket.data.playerId is the PUBLIC id from here on -- everything in the games keys seats by it.
 * The client is told its own public id ('hello'), since that is the id it will find itself under
 * in every roster and view.
 */
function identify(socket) {
  const secret = socket.handshake.auth?.playerId;
  if (typeof secret !== 'string' || !secret || secret.length > SECRET_MAX) {
    socket.emit('room:error', { error: 'Missing player id.' });
    socket.disconnect(true);
    return null;
  }
  const playerId = publicIdOf(secret);
  socket.data.playerId = playerId;
  socket.data.code = null;
  socket.data.client = clientOf(socket);
  socket.emit('hello', { you: playerId });
  return playerId;
}

// Seat the socket: its socket.io room, and the registry's live-connection count for the seat.
//
// A socket holds ONE room. One that creates or joins a second lets go of the first here -- its
// broadcasts and its live-connection mark -- because a disconnect only ever detaches the room it
// is in now. Without this the first room kept a connection that was never coming back, so the
// abandoned-room sweep (which only takes rooms with nobody connected) could never take it: four
// rooms per socket leaked for good, and sockets are free.
function seat(socket, registry, room) {
  const previous = socket.data.code;
  if (previous && previous !== room.code) {
    socket.leave(previous);
    registry.detachConnection(previous, socket.data.playerId, socket.id);
  }
  socket.data.code = room.code;
  socket.join(room.code);
  registry.attachConnection(room.code, socket.data.playerId, socket.id);
}

/** @returns {{ok: true, room} | {ok: false, error: string}} */
function createRoom(socket, registry, kind, nickname) {
  socket.data.created = (socket.data.created || 0) + 1;
  if (socket.data.created > MAX_ROOMS_PER_SOCKET || !roomsByClient.take(socket.data.client)) {
    return { ok: false, error: 'Too many rooms from this device. Try again in a few minutes.' };
  }
  const res = registry.createRoom({ hostPlayerId: socket.data.playerId, nickname, kind });
  if (!res.ok) return { ok: false, error: res.error };
  seat(socket, registry, res.room);
  return { ok: true, room: res.room };
}

/** @returns {{ok: true, room, reconnected: boolean} | {ok: false, error: string}} */
function joinRoom(socket, registry, kind, code, nickname) {
  if ((socket.data.failedJoins || 0) >= MAX_FAILED_JOINS || !failedJoinsByClient.allows(socket.data.client)) {
    return { ok: false, error: 'Too many failed attempts. Try again in a few minutes.' };
  }
  const res = registry.joinRoom(code, { playerId: socket.data.playerId, nickname, kind });
  if (!res.ok) {
    socket.data.failedJoins = (socket.data.failedJoins || 0) + 1;
    failedJoinsByClient.take(socket.data.client);
    return { ok: false, error: res.error };
  }
  seat(socket, registry, res.room);
  return { ok: true, room: res.room, reconnected: res.reconnected };
}

module.exports = { identify, createRoom, joinRoom, publicIdOf, MAX_ROOMS_PER_SOCKET, MAX_FAILED_JOINS };
