// Integration check for the web socket layer: `npm run check:web-socket`.
//
// Boots the real web server on an ephemeral port and drives socket.io clients through the
// stage 1 lifecycle (rooms/membership/reconnect) and the stage 2 lifecycle (deal characters,
// reroll, confirm, ready). Kept OUT of `npm test` on purpose: the unit suite is network-free
// (see README) and this binds a localhost port and seeds a throwaway DB. The room and setup
// *logic* are unit-tested without a network in test/web-rooms.test.js and test/web-setup.test.js;
// this proves the socket wiring end to end.

const os = require('os');
const path = require('path');

process.env.WEB_PORT = process.env.WEB_PORT || '4199';
process.env.WEB_SCOPE = process.env.WEB_SCOPE || 'gtc-check-scope';
process.env.WEB_GRACE_SECONDS = process.env.WEB_GRACE_SECONDS || '1'; // short grace so the check stays quick
process.env.BOT_DB_PATH = process.env.BOT_DB_PATH || path.join(os.tmpdir(), 'gtc-ws-check.sqlite');

// Seed a tiny content scope BEFORE requiring the server (which resolves WEB_SCOPE at load).
const characterLists = require('../src/core/db/characterLists');
function seedContent() {
  const list = characterLists.createList(process.env.WEB_SCOPE, 'Test Toons', 'seed', 'TestToons', { enabled: true });
  for (const name of ['Aang', 'Bulma', 'Cloud', 'Dexter', 'Eren', 'Finn']) {
    characterLists.addCharacter(list, name, 'seed', null);
  }
}
seedContent();

const { io } = require('socket.io-client');
const { server } = require('../src/web/server');

const PORT = Number(process.env.WEB_PORT);
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextEvent = (sock, ev) => new Promise((r) => sock.once(ev, r));
const roomStatus = (sock, status) =>
  new Promise((r) => {
    const on = (s) => { if (s.status === status) { sock.off('room:state', on); r(s); } };
    sock.on('room:state', on);
  });

let failed = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failed++; };
const connect = (playerId) => {
  const sock = io(URL, { auth: { playerId } });
  return new Promise((r) => sock.on('connect', () => r(sock)));
};

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  // ---- Stage 1: membership + reconnect --------------------------------------------------
  console.log('\n# stage 1 — rooms & reconnect');
  const A = await connect('pA');
  let res = await A.emitWithAck('room:create', { nickname: 'Alex' });
  check(res.ok && res.state.players.length === 1, 'A creates a room, seated as host');
  const code = res.state.code;

  const B = await connect('pB');
  const aSees2 = nextEvent(A, 'room:state');
  res = await B.emitWithAck('room:join', { code, nickname: 'Sam' });
  check(res.ok && res.state.players.length === 2, 'B joins, roster has 2');
  check((await aSees2).players.length === 2, 'A got a live broadcast when B joined');

  const aSeesOffline = nextEvent(A, 'room:state');
  B.close();
  const off = (await aSeesOffline).players.find((p) => p.playerId === 'pB');
  check(off && off.connected === false, 'B disconnect keeps the seat, marked offline');

  const B2 = await connect('pB');
  res = await B2.emitWithAck('room:join', { code, nickname: 'Sam' });
  check(res.ok && res.reconnected === true && res.state.players.length === 2, 'B reconnects to the same seat');

  A.close(); B2.close();
  await wait(50);

  // ---- Stage 2: deal, reroll, confirm, ready -------------------------------------------
  console.log('\n# stage 2 — setup / confirm / reroll');
  const C = await connect('pC');
  res = await C.emitWithAck('room:create', { nickname: 'Kira' });
  const code2 = res.state.code;
  const D = await connect('pD');
  await D.emitWithAck('room:join', { code: code2, nickname: 'Lee' });

  const cSetup = nextEvent(C, 'setup:state');
  const dSetup = nextEvent(D, 'setup:state');
  res = await C.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything' });
  check(res.ok, 'host deals characters (setup:start ok)');
  const cView = await cSetup;
  const dView = await dSetup;
  const seeded = ['Aang', 'Bulma', 'Cloud', 'Dexter', 'Eren', 'Finn'];
  check(seeded.includes(cView.checking.character.name), 'C sees a real character to check');
  check(cView.reference.length === 0, 'with 2 players the reference list is empty');
  check(cView.checking.character.name !== dView.checking.character.name, 'the two players check different characters');

  const cReroll = nextEvent(C, 'setup:state');
  res = await C.emitWithAck('setup:reroll', {});
  check(res.ok, 'C rerolls the character they check');
  check((await cReroll).rerollsLeft === -1, 'rerolls are unlimited (budget stays -1)');

  // ---- Stage 3 + 4: countdown, then the turn loop --------------------------------------
  console.log('\n# stage 3/4 — grace countdown + turn loop');
  const cCountdown = nextEvent(C, 'game:countdown');
  const cPlay = nextEvent(C, 'game:state');
  await C.emitWithAck('setup:confirm', {});
  await D.emitWithAck('setup:confirm', {});
  const cd = await cCountdown;
  check(cd.seconds >= 1, 'a grace countdown fires before the reveal (forehead moment)');
  const firstView = await cPlay;
  check(firstView.phase === 'playing' && firstView.isMyTurn === true, 'after the countdown, game starts, host up first');
  check(firstView.wearing === null, 'the guesser is not shown the guesser-card (tap fallback)');
  check(firstView.myCharacter && !!firstView.myCharacter.name, 'forehead mode gets the viewer\'s own character');
  check(firstView.turnRemaining > 0, 'a turn clock is running');

  const over = nextEvent(C, 'game:over');
  const dReveal = nextEvent(D, 'game:reveal');
  res = await C.emitWithAck('game:gotit', {}); // host finishes on turn 1
  check(res.ok && res.reveal.turns === 1, 'host declares "got it" on turn 1');
  const rev = await dReveal;
  check(rev.kind === 'got' && rev.turns === 1, 'the reveal reaches the other player');
  await wait(30);
  await D.emitWithAck('game:gotit', {}); // other player finishes -> game over
  const result = await over;
  check(result.winners.length >= 1, 'game reaches game:over with a result');
  check(result.standings.length === 2, 'final standings cover both players');

  C.close(); D.close();
  await wait(50);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL WEB CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
