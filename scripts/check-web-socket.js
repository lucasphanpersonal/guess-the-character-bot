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
  // One character carries an image so the /img route can be asserted POSITIVELY. A 404-only
  // check would pass even if the route were deleted, since the static handler 404s too --
  // which is exactly how a deleted /img route once slipped through green checks.
  characterLists.addCharacter(list, 'Pictured', 'seed', 'https://example.invalid/pic.png');
}
seedContent();

const { io } = require('socket.io-client');
const { server } = require('../src/web/server');

const PORT = Number(process.env.WEB_PORT);
const URL = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextEvent = (sock, ev) => new Promise((r) => sock.once(ev, r));
const nextMatching = (sock, ev, pred) =>
  new Promise((r) => { const on = (x) => { if (pred(x)) { sock.off(ev, on); r(x); } }; sock.on(ev, on); });
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

  // ---- list curation (host-only config-screen addition) --------------------------------
  res = await C.emitWithAck('setup:categoryLists', { category: 'TestToons' });
  check(res.ok && res.lists.length === 1 && res.lists[0].name === 'Test Toons' && res.lists[0].playing === true,
    'host can list a category\'s lists with per-room playing state');
  const nonHost = await D.emitWithAck('setup:categoryLists', { category: 'TestToons' });
  check(nonHost.ok === false, 'a non-host cannot curate lists');
  const listId = res.lists[0].id;
  const toggled = await C.emitWithAck('setup:toggleList', { listId });
  check(toggled.ok && toggled.playing === false, 'host drops a list for this room');
  // The shared `enabled` column must be untouched -- that is the whole point of the change.
  const stillEnabled = characterLists.getEnabledLists(process.env.WEB_SCOPE).some((l) => l.id === listId);
  check(stillEnabled, 'the shared pool is NOT modified by a room-level exclusion');
  await C.emitWithAck('setup:toggleList', { listId }); // restore for the deal below

  const beforeReroll = cView.checking.character.name;
  const cReroll = nextEvent(C, 'setup:state');
  res = await C.emitWithAck('setup:reroll', {});
  check(res.ok, 'C rerolls the character they check');
  const rerolled = await cReroll;
  check(rerolled.rerollsLeft === -1, 'rerolls are unlimited (budget stays -1)');
  check(rerolled.canUndo === true, 'undo becomes available after a reroll');

  const cUndo = nextEvent(C, 'setup:state');
  res = await C.emitWithAck('setup:undo', {});
  check(res.ok && res.restored === beforeReroll, 'undo reports the character it put back');
  const undone = await cUndo;
  check(undone.checking.character.name === beforeReroll, 'undo restores the previous character');
  check(undone.canUndo === false, 'undo is unavailable again with an empty history');

  // ---- a game action fired during SETUP must not resolve anything ----------------------
  // The Game object already exists in this phase and its currentTurnIndex is 0, so the first
  // player in the order is "current" before any turn has started. This once let a stray tilt
  // finish that player with zero turns and end the game from the reroll screen.
  const strayGotIt = await C.emitWithAck('game:gotit', {});
  check(strayGotIt.ok === false, 'game:gotit during setup is refused');
  const strayPass = await C.emitWithAck('game:pass', {});
  check(strayPass.ok === false, 'game:pass during setup is refused');
  const strayGiveUp = await C.emitWithAck('game:giveup', {});
  check(strayGiveUp.ok === false, 'game:giveup during setup is refused');

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

  // ---- Stage 5: pause on the current player's disconnect, resume on reconnect ----------
  console.log('\n# stage 5 — reconnect resilience');
  const dSeesPaused = nextMatching(D, 'game:state', (s) => s.paused === true);
  C.close(); // the current player drops mid-turn
  check((await dSeesPaused).paused === true, 'current player dropping pauses the turn');
  const C2 = await connect('pC'); // same playerId reconnects on a fresh socket
  const dSeesResumed = nextMatching(D, 'game:state', (s) => s.paused === false);
  await C2.emitWithAck('room:join', { code: code2, nickname: 'Kira' });
  check((await dSeesResumed).paused === false, 'their reconnect resumes the turn');

  // ---- finish the game on the reconnected socket ----
  const over = nextEvent(C2, 'game:over');
  const dReveal = nextEvent(D, 'game:reveal');
  const cFinished = nextMatching(C2, 'game:state', (s) => s.me && s.me.finished === true);
  res = await C2.emitWithAck('game:gotit', {}); // host finishes on turn 1
  check(res.ok && res.reveal.turns === 1, 'host declares "got it" on turn 1 after reconnect');
  const cf = await cFinished;
  check(cf.me.finished === true && !!cf.me.character, 'the finisher gets a "you got it" state with their reveal');
  const rev = await dReveal;
  check(rev.kind === 'got' && rev.turns === 1, 'the reveal reaches the other player');
  await wait(30);
  await D.emitWithAck('game:gotit', {}); // other player finishes -> game over
  const result = await over;
  check(result.winners.length >= 1, 'game reaches game:over with a result');
  check(result.standings.length === 2, 'final standings cover both players');
  check(result.standings.every((s) => s.character && s.character.name), 'final standings reveal each character');

  // ---- Stage 6: rematch with the same settings ----------------------------------------
  console.log('\n# stage 6 — rematch');
  const c2Setup = nextEvent(C2, 'setup:state');
  res = await C2.emitWithAck('game:rematch', {});
  check(res.ok, 'host rematches with the same settings');
  const rematchView = await c2Setup;
  check(rematchView.checking && !!rematchView.checking.character.name, 'rematch re-deals a fresh confirm phase');

  // ---- HTTP routes: not covered by the unit suite (network-free) or by the socket events
  // above. A refactor once deleted the /img route outright and every check still passed, so
  // the routes that serve actual bytes are asserted here.
  console.log('\n# http routes');
  const httpGet = async (path) => {
    const r = await fetch(`${URL}${path}`, { redirect: 'manual' });
    return { status: r.status, type: r.headers.get('content-type') || '' };
  };
  const seededChar = characterLists
    .getCharactersForLists(characterLists.getEnabledLists(process.env.WEB_SCOPE).map((l) => l.id))
    .find((c) => c.image_url);
  const page = await httpGet('/');
  check(page.status === 200 && page.type.includes('text/html'), 'GET / serves the client');
  const app = await httpGet('/app.js');
  check(app.status === 200 && app.type.includes('javascript'), 'GET /app.js serves the client script');
  const health = await httpGet('/api/health');
  check(health.status === 200, 'GET /api/health responds');
  const qr = await httpGet('/api/qr?room=ABCD');
  check(qr.status === 200 && qr.type.includes('svg'), 'GET /api/qr renders an SVG');
  check((await httpGet('/api/qr?text=https://evil.example')).status === 400, 'GET /api/qr refuses arbitrary text');
  if (seededChar) {
    const img = await httpGet(`/img/${seededChar.id}`);
    // 200 from cache, or 302 upstream when the fixture URL is not fetchable -- both mean the
    // route exists and resolved the id. A 404 would mean it is gone.
    check(img.status === 200 || img.status === 302, 'GET /img/<id> resolves a character image');
  }
  check((await httpGet('/img/999999999')).status === 404, 'GET /img/<unknown> is a clean 404');
  check((await httpGet('/../.env')).status === 404, 'path traversal is refused');

  // The join QR is built from this origin. Behind a TLS-terminating proxy the hop to us is
  // plain HTTP, and a QR that encodes http:// silently costs whoever scans it their tilt
  // controls -- browsers only expose motion sensors in a secure context.
  const proxied = await fetch(`${URL}/api/health`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
  }).then((r) => r.json());
  check(proxied.joinUrlBase === 'https://example.test', 'join URL honours a proxy that terminated TLS');
  const direct = await fetch(`${URL}/api/health`).then((r) => r.json());
  check(direct.joinUrlBase.startsWith('http://'), 'join URL is plain http when not proxied');

  C2.close(); D.close();
  await wait(50);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL WEB CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
