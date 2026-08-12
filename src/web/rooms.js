// Room registry for the web frontend -- membership only (stage 1).
//
// Deliberately transport-agnostic: nothing here imports socket.io or touches a network, so it
// is unit-testable in isolation (see test/web-rooms.test.js) and the socket layer
// (src/web/socket.js) is a thin translation from events to these calls. This mirrors how the
// Discord side keeps Game/GameManager as plain state with the I/O pushed to the edges.
//
// What a web room needs that the core Discord `Lobby` doesn't model: a nickname per seat and a
// live connection flag per seat, because a phone dropping Wi-Fi mid-party is routine, not rare
// (see docs/mobile-app-plan.md#reconnection-matters-more-here-than-it-does-on-discord). Seats
// are keyed by a persistent client-generated playerId (stored in the browser), NOT by the
// socket id, so a reconnecting phone reclaims its exact seat instead of being seen as a new
// player. Character dealing and the turn loop are later stages and will build a core `Game`
// from a room's roster; this file only gets people into the same room and keeps the roster live.

const { MAX_PLAYERS } = require('../core/game/Lobby');

// Unambiguous alphabet: no O/0, I/1, so a code read aloud across a room is unambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const NICK_MAX = 20;

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

function cleanNickname(nickname) {
  return String(nickname ?? '').trim().slice(0, NICK_MAX);
}

class Room {
  constructor(code, hostPlayerId) {
    this.code = code;
    this.hostPlayerId = hostPlayerId;
    this.status = 'lobby'; // 'lobby' -> (later) 'setup' | 'playing' | 'finished'
    this.createdAt = Date.now();
    // playerId -> { playerId, nickname, connected, joinedAt }
    this.players = new Map();
    // Stable join order, so the roster doesn't reshuffle on a Map re-render.
    this.order = [];
  }

  addSeat(playerId, nickname) {
    this.players.set(playerId, { playerId, nickname, connected: true, joinedAt: Date.now() });
    this.order.push(playerId);
  }

  removeSeat(playerId) {
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
  }

  /** Serializable snapshot to broadcast to every client in the room. */
  publicState() {
    return {
      code: this.code,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      players: this.order.map((id) => {
        const p = this.players.get(id);
        return {
          playerId: p.playerId,
          nickname: p.nickname,
          connected: p.connected,
          isHost: p.playerId === this.hostPlayerId,
        };
      }),
    };
  }
}

class RoomRegistry {
  constructor() {
    this.rooms = new Map(); // code -> Room
  }

  getRoom(code) {
    return this.rooms.get(String(code ?? '').toUpperCase()) || null;
  }

  createRoom({ hostPlayerId, nickname }) {
    if (!hostPlayerId) return { ok: false, error: 'Missing player id.' };
    const nick = cleanNickname(nickname);
    if (!nick) return { ok: false, error: 'Pick a nickname first.' };

    // Collisions are astronomically unlikely at this scale, but a bounded retry keeps codes
    // guaranteed-unique rather than probabilistically so.
    let code;
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = randomCode();
      if (!this.rooms.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) return { ok: false, error: 'Could not allocate a room code, try again.' };

    const room = new Room(code, hostPlayerId);
    room.addSeat(hostPlayerId, nick);
    this.rooms.set(code, room);
    return { ok: true, room };
  }

  /**
   * Join a room by code, or reclaim a seat in it.
   *
   * A known playerId always succeeds (this is the reconnect / rename path) and is never
   * rejected for a full room -- they already hold a seat. A new playerId is subject to the
   * lobby being open and not full.
   */
  joinRoom(code, { playerId, nickname }) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'No room with that code.' };
    if (!playerId) return { ok: false, error: 'Missing player id.' };
    const nick = cleanNickname(nickname);

    const existing = room.players.get(playerId);
    if (existing) {
      // Reconnect / rename: reclaim the same seat.
      existing.connected = true;
      if (nick) existing.nickname = nick;
      return { ok: true, room, reconnected: true };
    }

    if (!nick) return { ok: false, error: 'Pick a nickname first.' };
    // New seats can only be taken while the room is still gathering. A reconnecting known
    // player above is exempt, so dropping out and back mid-game will still work later.
    if (room.status !== 'lobby') return { ok: false, error: 'That game has already started.' };
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: 'That room is full.' };

    room.addSeat(playerId, nick);
    return { ok: true, room, reconnected: false };
  }

  /** Mark a seat connected/disconnected without giving it up (the reconnect-friendly path). */
  setConnected(code, playerId, connected) {
    const room = this.getRoom(code);
    if (!room) return null;
    const seat = room.players.get(playerId);
    if (!seat) return null;
    seat.connected = connected;
    return room;
  }

  /**
   * Leave for good (an explicit tap, not a dropped connection). Removes the seat, hands the
   * host role to the next player in order if the host left, and deletes the room once empty.
   *
   * @returns {{room: Room|null, deleted: boolean}} the room (null if it was deleted) so the
   *   caller knows whether there is anything left to broadcast to.
   */
  leaveRoom(code, playerId) {
    const room = this.getRoom(code);
    if (!room) return { room: null, deleted: false };
    if (!room.players.has(playerId)) return { room, deleted: false };

    room.removeSeat(playerId);

    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return { room: null, deleted: true };
    }
    if (room.hostPlayerId === playerId) {
      room.hostPlayerId = room.order[0]; // next in join order becomes host
    }
    return { room, deleted: false };
  }
}

module.exports = { RoomRegistry, Room, MAX_PLAYERS, randomCode, cleanNickname, CODE_LENGTH };
