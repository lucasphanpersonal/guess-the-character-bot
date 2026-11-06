// Test bots: players the server runs itself, so one person with one device can play a whole game.
//
// Lucas can't playtest alone, and every game here needs at least two people (Telephone, three). A
// bot is an ordinary player in every way that matters to the games: it connects over socket.io to
// this same server, joins by the room's code, wears a face, and acts only through the events a
// browser would send -- so every rule, limit and leak guard applies to it exactly as to a person,
// and nothing in the games knows bots exist. What it does with what it hears is its brain, one per
// game: ./guess/bot.js (both ways of playing Who Am I?) and ./draw/bot.js (Doodle Dash).
//
// It lives in this process, so it can do one thing no player can: read the room's own state (who it
// is wearing, what is being drawn) to play a plausible game -- right some of the time, wrong some of
// the time. It only ever reads; anything it changes goes through its socket like anyone's.
//
// Turned on per browser, never shown to anyone else: the Room menu's Add Bot appears only for a
// host whose browser has opened a page with `?bots` (shared/roommenu.js). The server accepts
// room:addBot from any host -- a bot is no more than one more tab would be -- and bounds it: one
// room's seats, MAX_BOTS across the server, a per-socket budget. WEB_BOTS=0 turns it off.
//
// A bot never outstays the people: it leaves as soon as nobody but bots holds a seat, and its room
// can be swept while only bots are connected (rooms.js sweepAbandoned ignores them).

const crypto = require('crypto');
const access = require('./roomAccess');
const { maxPlayersFor } = require('./rooms');
const { perSocket, SLOW_DOWN } = require('./rateLimit');

const ENABLED = process.env.WEB_BOTS !== '0';
// Every bot delay is multiplied by this: the socket check runs bots at a fraction of a person's pace.
const SPEED = Number(process.env.WEB_BOT_SPEED || 1);
const MAX_BOTS = 40;
const NAMESPACES = { party: '/', desk: '/desk', draw: '/draw' };
// Brains are required when first needed: each game's socket file requires this one to attach the
// Add Bot event, and a brain may read that game's modules.
const brainFor = (kind) => (kind === 'draw' ? require('./draw/bot') : require('./guess/bot'));

// Names a room can tell apart at a glance, each ending in "Bot" so nobody mistakes one for a person.
const NAMES = ['Beep Bot', 'Bloop Bot', 'Sprocket Bot', 'Widget Bot', 'Pixel Bot', 'Gizmo Bot', 'Bolt Bot', 'Fuzz Bot', 'Chip Bot', 'Dot Bot', 'Zap Bot', 'Noodle Bot'];

let server = null;
let registry = null;
const live = new Map(); // public id -> Bot

/** server.js hands over the HTTP server (for its port, once listening) and the room registry. */
function configure(opts) {
  server = opts.server ?? server;
  registry = opts.registry ?? registry;
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

class Bot {
  constructor(kind, code, nickname) {
    this.kind = kind;
    this.code = code;
    this.nickname = nickname;
    this.secret = `bot-${crypto.randomBytes(16).toString('hex')}`;
    this.id = access.publicIdOf(this.secret);
    this.timers = new Map(); // tag -> timeout
    this.state = {}; // whatever the brain keeps
    this.stopped = false;
  }

  /** The room, read in place. For deciding only: a bot changes nothing except through its socket. */
  room() {
    return registry?.getRoom(this.code) ?? null;
  }

  /** Run fn after a person-like pause (ms, scaled by WEB_BOT_SPEED), once per tag at a time. */
  once(tag, ms, fn) {
    if (this.stopped || this.timers.has(tag)) return;
    const t = setTimeout(() => {
      this.timers.delete(tag);
      if (this.stopped) return;
      try {
        fn();
      } catch (err) {
        console.warn(`[bots] ${this.nickname} tripped:`, err.message);
      }
    }, Math.max(0, ms * SPEED));
    t.unref?.();
    this.timers.set(tag, t);
  }

  cancel(tag) {
    const t = this.timers.get(tag);
    if (t) clearTimeout(t);
    this.timers.delete(tag);
  }

  pending(prefix) {
    return [...this.timers.keys()].some((tag) => tag.startsWith(prefix));
  }

  cancelAll(prefix = '') {
    for (const tag of [...this.timers.keys()]) if (tag.startsWith(prefix)) this.cancel(tag);
  }

  emit(event, payload = {}) {
    if (!this.stopped) this.socket?.emit(event, payload, () => {});
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelAll();
    clearInterval(this.watch);
    live.delete(this.id);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
  }

  // Gone from the room (removed, or the room was swept), or the last person has left: either way
  // there is nobody to play for.
  checkRoom() {
    const room = this.room();
    if (!room || !room.players.has(this.id)) return this.stop();
    if (![...room.players.values()].some((p) => !p.bot)) {
      this.emit('room:leave');
      // The leave is sent before the socket closes; a disconnect after it is harmless either way.
      setTimeout(() => this.stop(), 50).unref?.();
    }
  }
}

/** Seat one bot in `room`. @returns {Promise<{ok: boolean, error?: string, name?: string}>} */
function spawn(room) {
  const port = server?.address?.()?.port;
  if (!port) return Promise.resolve({ ok: false, error: 'Bots are not available on this server.' });
  const taken = new Set([...room.players.values()].map((p) => p.nickname));
  const name = NAMES.find((n) => !taken.has(n)) ?? `Bot ${room.players.size + 1}`;
  const bot = new Bot(room.kind, room.code, name);
  live.set(bot.id, bot);

  // Required here rather than at the top: socket.io-client is only needed once someone asks for a bot.
  const { io } = require('socket.io-client');
  const socket = io(`http://127.0.0.1:${port}${NAMESPACES[room.kind]}`, {
    auth: { playerId: bot.secret, botKey: access.botKey() },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  bot.socket = socket;
  brainFor(room.kind).attach(bot, { rand, pick });
  socket.on('room:kicked', () => bot.stop());
  socket.on('disconnect', () => bot.stop());
  socket.on('room:state', (s) => {
    bot.roomState = s;
    if (!s.players.some((p) => !p.bot)) bot.checkRoom();
  });

  return new Promise((resolve) => {
    const fail = (error) => {
      bot.stop();
      resolve({ ok: false, error });
    };
    const timer = setTimeout(() => fail('The bot could not connect.'), 5000);
    socket.once('connect_error', () => {
      clearTimeout(timer);
      fail('The bot could not connect.');
    });
    socket.once('connect', () => {
      socket.emit('room:join', { code: room.code, nickname: name }, (res) => {
        clearTimeout(timer);
        if (!res?.ok) return fail(res?.error || 'The bot could not join.');
        bot.roomState = res.state;
        bot.watch = setInterval(() => bot.checkRoom(), 5000);
        bot.watch.unref?.();
        resolve({ ok: true, name });
      });
    });
  });
}

// Adding is a host's tap, a few times per game at most.
const addBudget = perSocket({ max: 6, windowMs: 5000 });
const MAX_PER_ROOM = 11; // a Draw room takes 50 seats; a test needs nowhere near that many

/** The Room menu's Add Bot, for every game. Called from each game's connection handler. */
function attachControls(socket, { registry: reg }) {
  socket.on('room:addBot', async (_p, ack) => {
    if (!ENABLED) return ack?.({ ok: false, error: 'Bots are switched off on this server.' });
    if (!addBudget(socket)) return ack?.(SLOW_DOWN);
    const room = reg.getRoom(socket.data.code);
    if (!room) return ack?.({ ok: false, error: 'Not in a room.' });
    if (room.hostPlayerId !== socket.data.playerId || socket.data.bot) return ack?.({ ok: false, error: 'Only the host can add bots.' });
    if (room.status !== 'lobby' && room.status !== 'finished') return ack?.({ ok: false, error: 'Bots can join between games, not during one.' });
    if (room.players.size >= maxPlayersFor(room.kind)) return ack?.({ ok: false, error: 'That room is full.' });
    if ([...room.players.values()].filter((p) => p.bot).length >= MAX_PER_ROOM) return ack?.({ ok: false, error: `That's ${MAX_PER_ROOM} bots already.` });
    if (live.size >= MAX_BOTS) return ack?.({ ok: false, error: 'Too many bots are playing on this server right now.' });
    return ack?.(await spawn(room));
  });
}

module.exports = { configure, attachControls, spawn, ENABLED, liveCount: () => live.size };
