// Integration check for the web socket layer: `npm run check:web-socket`.
//
// Boots the real web server on an ephemeral port and drives two socket.io clients through the
// stage-1 lifecycle -- create, join, live broadcast, disconnect-keeps-seat, reconnect-reclaims-
// seat, host handoff on leave. Kept OUT of `npm test` on purpose: the unit suite is network-free
// (see README), and this one binds a localhost port. The room *logic* is unit-tested without a
// network in test/web-rooms.test.js; this proves the socket wiring end to end.

const os = require('os');
const path = require('path');

process.env.WEB_PORT = process.env.WEB_PORT || '4199';
// Never touch the real DB.
process.env.BOT_DB_PATH = process.env.BOT_DB_PATH || path.join(os.tmpdir(), 'gtc-ws-check.sqlite');

const { io } = require('socket.io-client');
const { server } = require('../src/web/server');

const PORT = Number(process.env.WEB_PORT);
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextState = (sock) => new Promise((r) => sock.once('room:state', r));

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) failed++;
};
const connect = (playerId) => {
  const sock = io(URL, { auth: { playerId } });
  return new Promise((r) => sock.on('connect', () => r(sock)));
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  const A = await connect('pA');
  let res = await A.emitWithAck('room:create', { nickname: 'Alex' });
  check(res.ok && res.state.players.length === 1, 'A creates a room, seated as host');
  const code = res.state.code;
  check(res.state.hostPlayerId === 'pA', 'host is A');

  const B = await connect('pB');
  const aSees2 = nextState(A);
  res = await B.emitWithAck('room:join', { code, nickname: 'Sam' });
  check(res.ok && res.state.players.length === 2, 'B joins, roster has 2');
  check((await aSees2).players.length === 2, 'A received a live broadcast when B joined');

  const aSeesOffline = nextState(A);
  B.close();
  const off = await aSeesOffline;
  const sam = off.players.find((p) => p.playerId === 'pB');
  check(sam && sam.connected === false, 'B disconnect keeps the seat, marked offline');
  check(off.players.length === 2, 'seat is retained on disconnect');

  const B2 = await connect('pB');
  res = await B2.emitWithAck('room:join', { code, nickname: 'Sam' });
  check(res.ok && res.reconnected === true, 'B reconnects and reclaims the same seat');
  check(res.state.players.length === 2, 'still 2 players after reconnect (no duplicate)');

  const bSeesHandoff = nextState(B2);
  await A.emitWithAck('room:leave', {});
  const handoff = await bSeesHandoff;
  check(handoff.hostPlayerId === 'pB', 'host handed off to B when A left');
  check(handoff.players.length === 1, 'A removed on explicit leave');

  A.close();
  B2.close();
  await wait(50);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL WS CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
