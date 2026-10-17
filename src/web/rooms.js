// Room registry for the web frontend -- membership only.
//
// Deliberately transport-agnostic: nothing here imports socket.io or touches a network, so it
// is unit-testable in isolation (see test/web-rooms.test.js) and the socket layer
// (src/web/guess/socket.js) is a thin translation from events to these calls. This mirrors how the
// Discord side keeps Game/GameManager as plain state with the I/O pushed to the edges.
//
// What a web room needs that the core Discord `Lobby` doesn't model: a nickname per seat and a
// live connection flag per seat, because a phone dropping Wi-Fi mid-party is routine, not rare
// (see docs/mobile-app-plan.md#reconnection-matters-more-here-than-it-does-on-discord). Seats
// are keyed by a persistent client-generated playerId (stored in the browser), NOT by the
// socket id, so a reconnecting phone reclaims its exact seat instead of being seen as a new
// player. Character dealing and the turn loop live in gameSetup.js/turnLoop.js over a core
// `Game`; this file only gets people into the same room and keeps the roster live.

const { MAX_PLAYERS } = require('../core/game/Lobby');

// How many seats a room of each kind has. Guess the Character keeps the core's 8 -- the Discord
// game's, and a forehead game's natural size, everyone watching everyone. Drawing has no such
// shape: one draws, the rest guess, and a bigger room is only a bigger audience. 50 is "no limit"
// for any party while still a ceiling, and the ceiling is the only guard: roomAccess.js limits
// failed joins (guessing codes) and room creation per client, but not a successful join, so
// without one a script holding a room's code could fill it with seats faster than any host could
// remove them. Telephone grows with it -- every chain visits every seat -- which is the mode,
// not a cost to cap.
const MAX_PLAYERS_BY_KIND = { draw: 50 };
const maxPlayersFor = (kind) => MAX_PLAYERS_BY_KIND[kind] ?? MAX_PLAYERS;

// Unambiguous alphabet: no O/0, I/1, so a code read aloud across a room is unambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const NICK_MAX = 20;

// Which game a room is, and what to tell someone whose device opened the other one. One registry
// holds every web game's rooms, so a code means one room -- but a phone that joins a computer
// room would be dealt into a game its client cannot draw, so each game only joins its own kind.
const KINDS = {
  party: 'a phone game. Join it from a phone, at the main address',
  desk: 'a computer game. Open it on a computer, at /desk/',
  draw: 'Draw the Character. Open it at /draw/',
};

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
  constructor(code, hostPlayerId, kind = 'party') {
    this.code = code;
    this.hostPlayerId = hostPlayerId;
    this.kind = kind;
    this.status = 'lobby'; // 'lobby' -> (later) 'setup' | 'playing' | 'finished'
    this.createdAt = Date.now();
    // Lists this room has chosen not to play with. Per-room ON PURPOSE: the obvious
    // implementation was to switch lists off in the web's playable selection, but every room
    // deals from that selection, so one party host unticking "Naruto" would silently and
    // permanently change what every later party gets -- and the web app is reachable by anyone
    // with the room link. (It was worse still when the selection was an `enabled` column the
    // Discord bot shared.) An exclusion set keeps the choice where it belongs: this room, this
    // session. What makes a host's ticks "stay" is their own browser re-applying them to each new
    // room they host (shared/pickers.js, content.js keepListsOff) -- still never the selection.
    this.excludedListIds = new Set();
    // playerId -> { playerId, nickname, connected, joinedAt }
    this.players = new Map();
    // Names of people who have given up their seat. A game in progress still lists them in its
    // turn order, its reveals and its final standings, and those read the roster for names -- so
    // without this someone who leaves or is removed mid-game turns into "Player" on the results
    // screen they are still on.
    this.departedNames = new Map();
    // Stable join order, so the roster doesn't reshuffle on a Map re-render.
    this.order = [];
  }

  addSeat(playerId, nickname) {
    // `conns` is the set of live socket ids for this seat. A seat is "connected" while any
    // socket holds it -- so a second tab, or a reconnect whose new socket arrives before the old
    // one's disconnect, never flips the player to offline. See attach/detachConnection.
    this.players.set(playerId, { playerId, nickname, joinedAt: Date.now(), conns: new Set() });
    this.order.push(playerId);
  }

  removeSeat(playerId) {
    const seat = this.players.get(playerId);
    if (seat?.nickname) this.departedNames.set(playerId, seat.nickname);
    this.players.delete(playerId);
    this.order = this.order.filter((id) => id !== playerId);
  }

  /** Serializable snapshot to broadcast to every client in the room. */
  publicState() {
    return {
      code: this.code,
      kind: this.kind,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      // The host has stopped the clock (room:pause). On the game, because it lasts the game;
      // published here because every screen in the room shows it, whatever the game.
      paused: this.status === 'playing' && !!this.game?.hostPaused,
      // Published rather than hardcoded in the client, which had its own copy of "8".
      maxPlayers: maxPlayersFor(this.kind),
      players: this.order.map((id) => {
        const p = this.players.get(id);
        return {
          playerId: p.playerId,
          nickname: p.nickname,
          connected: p.conns.size > 0,
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

  /** Every live room, for the timer watchdog to sweep. */
  allRooms() {
    return [...this.rooms.values()];
  }

  /**
   * Drops rooms nobody is connected to any more.
   *
   * A room is only deleted on an explicit leave, and a socket that simply goes away just marks
   * its seat offline (that is what makes reconnects work). So a client that creates a room and
   * vanishes leaves it in memory for good -- and creating rooms is free and unauthenticated, so
   * that is a memory leak anyone with the URL can drive. Measured: one client made 60 rooms in
   * 12ms. Sweeping empty-of-people rooms after a grace period bounds it without shortening any
   * real disconnection, since a party that all drops off Wi-Fi has the full TTL to come back.
   */
  sweepAbandoned(ttlMs = 30 * 60 * 1000, now = Date.now()) {
    let removed = 0;
    for (const room of [...this.rooms.values()]) {
      const anyConnected = [...room.players.values()].some((p) => p.conns.size > 0);
      if (anyConnected) {
        room.lastSeen = now;
        continue;
      }
      room.lastSeen ??= room.createdAt;
      if (now - room.lastSeen > ttlMs) {
        this.rooms.delete(room.code);
        removed++;
      }
    }
    return removed;
  }

  createRoom({ hostPlayerId, nickname, kind = 'party' }) {
    if (!hostPlayerId) return { ok: false, error: 'Missing player id.' };
    if (!KINDS[kind]) return { ok: false, error: 'Unknown game.' };
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

    const room = new Room(code, hostPlayerId, kind);
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
  joinRoom(code, { playerId, nickname, kind = 'party' }) {
    const room = this.getRoom(code);
    if (!room) return { ok: false, error: 'No room with that code.' };
    if (!playerId) return { ok: false, error: 'Missing player id.' };
    // Before the seat logic, so not even a known player reclaims a seat through the wrong game.
    if (room.kind !== kind) return { ok: false, error: `That room is ${KINDS[room.kind]}.`, kind: room.kind };
    const nick = cleanNickname(nickname);

    const existing = room.players.get(playerId);
    if (existing) {
      // Reconnect / rename: reclaim the same seat. The connection itself is registered by the
      // socket layer via attachConnection, so nothing about "connected" is set here.
      if (nick) existing.nickname = nick;
      return { ok: true, room, reconnected: true };
    }

    if (!nick) return { ok: false, error: 'Pick a nickname first.' };
    // New seats can be taken while the room is gathering, and again once a game has FINISHED --
    // a finished room is between games, and refusing there meant that when somebody left, the
    // rematch was blocked for want of a player nobody was allowed to supply. A reconnecting
    // known player is exempt either way, so dropping out and back mid-game still works.
    if (room.status !== 'lobby' && room.status !== 'finished') {
      return { ok: false, error: 'That game has already started.' };
    }
    if (room.players.size >= maxPlayersFor(room.kind)) return { ok: false, error: 'That room is full.' };

    room.addSeat(playerId, nick);
    return { ok: true, room, reconnected: false };
  }

  /** Register a live socket for a seat. Returns the room, or null if seat/room is gone. */
  attachConnection(code, playerId, connId) {
    const room = this.getRoom(code);
    const seat = room?.players.get(playerId);
    if (!seat) return null;
    seat.conns.add(connId);
    return room;
  }

  /**
   * Drop a socket from a seat (a disconnect). The seat is kept either way -- only an explicit
   * leave gives it up. `nowOffline` is true when this was the seat's LAST live socket, which is
   * the moment the roster dot goes grey and (for the current player) the turn clock should pause.
   *
   * @returns {{room: Room|null, nowOffline: boolean}}
   */
  detachConnection(code, playerId, connId) {
    const room = this.getRoom(code);
    const seat = room?.players.get(playerId);
    if (!seat) return { room: null, nowOffline: false };
    const had = seat.conns.delete(connId);
    return { room, nowOffline: had && seat.conns.size === 0 };
  }

  /** Whether a seat currently has any live socket. */
  isConnected(code, playerId) {
    return (this.getRoom(code)?.players.get(playerId)?.conns.size ?? 0) > 0;
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

module.exports = { RoomRegistry, Room, MAX_PLAYERS, maxPlayersFor, randomCode, cleanNickname, CODE_LENGTH, KINDS };
