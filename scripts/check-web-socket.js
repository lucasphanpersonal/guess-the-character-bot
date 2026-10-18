// Integration check for the web socket layer: `npm run check:web-socket`.
//
// Boots the real web server on an ephemeral port and drives socket.io clients through the
// stage 1 lifecycle (rooms/membership/reconnect) and the stage 2 lifecycle (deal characters,
// reroll, confirm, ready). Kept OUT of `npm test` on purpose: the unit suite is network-free
// (see docs/architecture.md) and this binds a localhost port and seeds a throwaway DB. The room and setup
// *logic* are unit-tested without a network in test/web-rooms.test.js and test/web-setup.test.js;
// this proves the socket wiring end to end.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WEB_PORT = process.env.WEB_PORT || '4199';
process.env.WEB_SCOPE = process.env.WEB_SCOPE || 'gtc-check-scope';
process.env.WEB_GRACE_SECONDS = process.env.WEB_GRACE_SECONDS || '1'; // short grace so the check stays quick
process.env.WEB_DRAW_REVEAL_SECONDS = process.env.WEB_DRAW_REVEAL_SECONDS || '1'; // and a short reveal between drawings
const OWN_DB = !process.env.BOT_DB_PATH; // did we pick the path, or did the caller?
process.env.BOT_DB_PATH = process.env.BOT_DB_PATH || path.join(os.tmpdir(), 'gtc-ws-check.sqlite');

// Start from an empty throwaway DB every run. Without this the second run dies on a UNIQUE
// violation against its own leftover seed -- a check that only works once is not a check.
// Only ever removes the temp DB this script created; never a caller-supplied BOT_DB_PATH.
if (OWN_DB) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(process.env.BOT_DB_PATH + suffix); } catch { /* not there yet */ }
  }
}

// Seed a tiny content scope BEFORE requiring the server (which resolves WEB_SCOPE at load).
const characterLists = require('../src/compendium/characterLists');
// The whole cast this check deals from. Assertions about "did we get a real character?" read
// this same constant -- keeping a second hand-written copy of the names is how a fixture that
// grew a seventh character turned into a check that failed one run in seven.
const SEEDED_NAMES = ['Aang', 'Bulma', 'Cloud', 'Dexter', 'Eren', 'Finn', 'Pictured'];

function seedContent() {
  const list = characterLists.createList(process.env.WEB_SCOPE, 'Test Toons', 'seed', 'TestToons', { enabled: true });
  for (const name of SEEDED_NAMES) {
    // 'Pictured' carries an image so the /img route can be asserted POSITIVELY. A 404-only
    // check would pass even if the route were deleted, since the static handler 404s too --
    // which is exactly how a deleted /img route once slipped through green checks.
    const image = name === 'Pictured' ? 'https://example.invalid/pic.png' : null;
    characterLists.addCharacter(list, name, 'seed', image);
  }
}
seedContent();

const { io } = require('socket.io-client');
const { server, registry } = require('../src/web/server');
// Seats are published under a public id derived from the secret each client connects with
// (src/web/roomAccess.js), so every id this check compares or targets goes through it.
const { publicIdOf: pub } = require('../src/web/roomAccess');

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

  // ---- Seat identity: the secret a browser connects with is never published ---------------
  console.log('\n# seat identity');
  {
    // Long, unmistakable secrets, so a substring search can only find them if they were sent.
    const HOST_SECRET = 'host-secret-7f3a9c1e5d';
    const GUEST_SECRET = 'guest-secret-2b8d4f6a0c';
    const listen = (secret) => new Promise((r) => {
      const sock = io(URL, { auth: { playerId: secret } });
      sock.heard = [];
      sock.onAny((ev, payload) => sock.heard.push({ ev, json: JSON.stringify(payload ?? null) }));
      sock.on('connect', () => r(sock));
    });
    const hello = (sock) => new Promise((r) => (sock.heard.find((h) => h.ev === 'hello') ? r(JSON.parse(sock.heard.find((h) => h.ev === 'hello').json)) : sock.once('hello', r)));
    const H = await listen(HOST_SECRET);
    const G = await listen(GUEST_SECRET);
    check((await hello(H)).you === pub(HOST_SECRET), 'identity: a browser is told its public seat id');
    let r = await H.emitWithAck('room:create', { nickname: 'Hana' });
    const idCode = r.state.code;
    r = await G.emitWithAck('room:join', { code: idCode, nickname: 'Gil' });
    check(r.ok && r.state.hostPlayerId === pub(HOST_SECRET), 'identity: rosters name seats by public id');
    await new Promise((res) => setTimeout(res, 100));
    const everything = [...H.heard, ...G.heard].map((h) => h.json).join('\n');
    check(!everything.includes(HOST_SECRET) && !everything.includes(GUEST_SECRET), 'identity: no payload to anyone carries a secret');

    // Connecting with the host's PUBLIC id -- the thing everyone can see -- is just a new person.
    const impostor = await listen(pub(HOST_SECRET));
    r = await impostor.emitWithAck('room:join', { code: idCode, nickname: 'Hana' });
    const seats = registry.getRoom(idCode).players;
    check(r.ok && r.reconnected === false && seats.size === 3 && r.state.hostPlayerId === pub(HOST_SECRET),
      "identity: the host's public id gets an impostor a new seat, never the host's");
    const kick = await impostor.emitWithAck('room:kick', { playerId: pub(GUEST_SECRET) });
    check(!kick.ok, 'identity: ...and no host powers');

    // Room-code lookups are limited per client (the proxy's client address), not per socket.
    const asClient = (ip) => fetch(`${URL}/api/room?code=ZZZZ`, { headers: { 'cf-connecting-ip': ip } }).then((x) => x.status);
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push(await asClient('203.0.113.7'));
    check(statuses.slice(0, 30).every((s) => s === 404) && statuses[30] === 429, `lookups: the 31st in a minute from one client is refused (${statuses[30]})`);
    check((await asClient('203.0.113.8')) === 404, 'lookups: ...while another client is unaffected');
    [H, G, impostor].forEach((s) => s.close());

    // A socket that hops rooms lets go of the one it left, so an abandoned room can be swept. It
    // used to keep a live-connection mark there forever.
    const hopper = await listen('room-hopper-secret');
    const first = await hopper.emitWithAck('room:create', { nickname: 'Hop' });
    const second = await hopper.emitWithAck('room:create', { nickname: 'Hop' });
    const stillHeld = registry.isConnected(first.state.code, pub('room-hopper-secret'));
    hopper.close();
    await new Promise((res) => setTimeout(res, 150));
    check(!stillHeld && !registry.isConnected(second.state.code, pub('room-hopper-secret')),
      'rooms: a socket that moves on lets go of the room it left, so it can be swept');
  }

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
  const off = (await aSeesOffline).players.find((p) => p.playerId === pub('pB'));
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
  let cView = await cSetup;
  const dView = await dSetup;
  check(SEEDED_NAMES.includes(cView.checking.character.name), 'C sees a real character to check');
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
  // The picker's All / None: many at once, host only, and every id must check out.
  check((await D.emitWithAck('setup:setLists', { listIds: [listId], playing: false })).ok === false, 'a non-host cannot switch lists in bulk');
  res = await C.emitWithAck('setup:setLists', { listIds: [listId], playing: false });
  check(res.ok && res.playing[0] === false, 'host switches a category\'s lists off in one go');
  res = await C.emitWithAck('setup:setLists', { listIds: [listId, 987654321], playing: true });
  check(res.ok === false && (await C.emitWithAck('setup:categoryLists', { category: 'TestToons' })).lists[0].playing === false,
    'one unknown id in a bulk request changes nothing');
  res = await C.emitWithAck('setup:setLists', { listIds: [listId], playing: true });
  check(res.ok && res.playing[0] === true, 'and back on');

  // What a host's browser remembers switching off goes back off in a new room -- off only, the
  // rest still applied when one remembered list has since gone.
  check((await D.emitWithAck('setup:keepOff', { listIds: [listId] })).ok === false, 'a non-host cannot re-apply remembered lists');
  res = await C.emitWithAck('setup:keepOff', { listIds: [listId, 987654321] });
  check(res.ok && res.off.length === 1 && res.off[0] === listId, 'remembered lists go back off; a gone one is skipped, not fatal');
  check((await C.emitWithAck('setup:categoryLists', { category: 'TestToons' })).lists[0].playing === false, 'and the picker then shows them off');
  await C.emitWithAck('setup:setLists', { listIds: [listId], playing: true }); // back on for the deal below

  // Host can call off a deal from the reroll phase; a non-host cannot.
  const notHostCancel = await D.emitWithAck('setup:cancel', {});
  check(notHostCancel.ok === false, 'a non-host cannot cancel setup');
  const backToLobby = roomStatus(D, 'lobby');
  check((await C.emitWithAck('setup:cancel', {})).ok === true, 'host cancels the deal');
  const lobbyState = await backToLobby;
  check(lobbyState.players.length === 2, 'everyone keeps their seat after a cancel');
  check((await C.emitWithAck('setup:cancel', {})).ok === false, 'cancelling twice is refused');

  // Re-deal so the rest of the walkthrough has a game to play.
  const cSetup2 = nextEvent(C, 'setup:state');
  check((await C.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything' })).ok,
    'host re-deals after cancelling');
  cView = await cSetup2;

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
  // A laptop that sleeps through the countdown: this process (server included) stops dead past both
  // the countdown's end and the watchdog's next tick, so both are overdue when it wakes. Either may
  // run first; the game must begin once, and charge the first player exactly one turn.
  const turnCounts = [];
  const countTurns = (v) => { if (v.phase === 'playing') turnCounts.push(v.current.turnNumber); };
  C.on('game:state', countTurns);
  const sleepUntil = Date.now() + (cd.seconds + 4) * 1000;
  while (Date.now() < sleepUntil) { /* the machine is asleep */ }
  const firstView = await cPlay;
  // Anything a second begin would have sent. Longer when a harness delays the countdown's timer on
  // purpose so the watchdog provably goes first (the order a real sleep only sometimes produces).
  await wait(Number(process.env.CHECK_COUNTDOWN_SETTLE_MS ?? 500));
  C.off('game:state', countTurns);
  check(turnCounts.length > 0 && turnCounts.every((n) => n === 1),
    `a sleep through the countdown begins the game once: the first player is on turn 1 (${turnCounts.join(', ')})`);
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
  // A player who never confirms used to be able to hold a room forever: the game starts only
  // when everyone has locked in, and locking in now requires a working motion sensor. This is
  // the escape hatch, checked end to end because it is the only thing standing between one
  // laptop and a dead party.
  console.log('\n# host can break a stuck confirm phase');
  {
    const H = await connect('pKickHost');
    let r = await H.emitWithAck('room:create', { nickname: 'Host' });
    const code = r.state.code;
    const S = await connect('pKickStuck');
    await S.emitWithAck('room:join', { code, nickname: 'Stuck' });

    const hSetup = nextEvent(H, 'setup:state');
    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything' });
    check(r.ok, 'kick: deal starts');
    const view = await hSetup;
    check(view.waitingPlayers?.length === 2, 'kick: the confirm view names who it is waiting on');

    // Only the host, and never yourself.
    r = await S.emitWithAck('room:kick', { playerId: pub('pKickHost') });
    check(!r.ok, 'kick: a non-host cannot remove anyone');
    r = await H.emitWithAck('room:kick', { playerId: pub('pKickHost') });
    check(!r.ok, 'kick: the host cannot remove themselves');

    const kicked = nextEvent(S, 'room:kicked');
    const backToLobby = nextMatching(H, 'room:state', (st) => st.status === 'lobby');
    r = await H.emitWithAck('room:kick', { playerId: pub('pKickStuck') });
    check(r.ok, 'kick: the host removes the player who never confirmed');
    await kicked;
    check(true, 'kick: the removed player is told, not silently cut off');
    const lobby = await backToLobby;
    check(lobby.players.length === 1, 'kick: the room drops back to a lobby without them');
    H.close(); S.close();
  }

  // ---- The disconnect pause must not outlive the turn it was taken for -------------------
  // A dropped phone freezes the current player's clock. That pause belongs to one player's one
  // turn, and both ways out of it were once left half-done: another player leaving re-armed the
  // clock while the game still called itself paused, and removing the paused player advanced
  // the turn but left the guard armed to rewrite the NEXT player's deadline 30s later. While
  // the flag is wrongly set the wearer loses all three turn cues at once (bar, ticks, buzz), so
  // this is asserted on server state rather than on what any one client happened to render.
  console.log('\n# the disconnect pause belongs to one turn');
  {
    const P = await connect('pPauseA');
    let r = await P.emitWithAck('room:create', { nickname: 'Pia' });
    const code = r.state.code;
    const Q = await connect('pPauseB');
    await Q.emitWithAck('room:join', { code, nickname: 'Quinn' });
    const R = await connect('pPauseC');
    await R.emitWithAck('room:join', { code, nickname: 'Rae' });

    r = await P.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything' });
    check(r.ok, 'pause: deal starts');
    const playing = roomStatus(Q, 'playing');
    for (const s of [P, Q, R]) await s.emitWithAck('setup:confirm', {});
    await playing;
    await wait(50);

    const game = registry.getRoom(code).game;
    check(game.currentPlayerId === pub('pPauseA'), 'pause: the first turn belongs to the host');

    // A hidden tab counts the clock down on throttled timers and drifts; this is how it asks
    // for the truth on the way back, so it has to answer with a real remaining time.
    const resynced = nextEvent(P, 'game:state');
    const fresh = await P.emitWithAck('game:resync', {});
    check(fresh.ok, 'resync: the server answers a returning tab');
    check(typeof (await resynced).turnRemaining === 'number', 'resync: the answer carries the real clock');

    // The current player drops: the clock freezes.
    P.disconnect();
    await wait(150);
    check(game.pausedForDisconnect === true && !game.turnEndsAt, 'pause: a dropped guesser freezes the clock');

    // Someone who is NOT the guesser leaves. The turn never moved, so nothing about it changes.
    await R.emitWithAck('room:leave', {});
    await wait(150);
    check(game.pausedForDisconnect === true, 'pause: another player leaving keeps the pause');
    check(!game.turnEndsAt, 'pause: another player leaving does NOT restart the frozen clock');

    // The paused player is removed, so the turn advances -- and the pause goes with it.
    const P2 = await connect('pPauseA');
    await P2.emitWithAck('room:join', { code, nickname: 'Pia' });
    await wait(100);
    await P2.emitWithAck('game:pass', {}); // hand the turn to Quinn, who is not the host
    await wait(100);
    check(game.currentPlayerId === pub('pPauseB'), 'pause: the turn is handed to a non-host');
    Q.disconnect();
    await wait(150);
    check(game.pausedForDisconnect === true, 'pause: the new guesser dropping freezes the clock');
    await P2.emitWithAck('room:kick', { playerId: pub('pPauseB') });
    await wait(150);
    check(game.currentPlayerId !== pub('pPauseB'), 'pause: removing the paused guesser advances the turn');
    check(game.pausedForDisconnect === false, 'pause: the pause does not outlive the turn it belonged to');
    check(!!game.turnEndsAt, 'pause: the new turn gets a real deadline');
    P2.close(); Q.close(); R.close();
  }

  // ---- Host-picks mode: the host chooses everyone's character and sits the game out --------
  // The host's view carries EVERY character in play, so the property that matters most is who
  // receives it: every event every player gets is recorded, and none may be host:state. The
  // host, in turn, must never be handed a player's setup, game state or forehead countdown.
  console.log('\n# host picks the characters and sits out');
  {
    const H = await connect('pPickHost');
    let r = await H.emitWithAck('room:create', { nickname: 'Hana' });
    const code = r.state.code;
    const X = await connect('pPickX');
    await X.emitWithAck('room:join', { code, nickname: 'Xia' });

    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: {} });
    check(!r.ok, 'host-picks: refused with only one player besides the host');

    const Y = await connect('pPickY');
    await Y.emitWithAck('room:join', { code, nickname: 'Yuri' });

    const found = await fetch(`${URL}/api/browse/search?q=Aang`).then((res) => res.json());
    const aang = found.characters.find((c) => c.name === 'Aang');
    check(!!aang && Number.isInteger(aang.id) && !!aang.list, 'host-picks: search finds a listed character, with its id and list');
    check((await fetch(`${URL}/api/browse/search?q=A`).then((res) => res.json())).characters.length === 0, 'host-picks: a one-letter search returns nothing rather than the library');

    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { [pub('pPickHost')]: { id: aang.id } } });
    check(!r.ok, 'host-picks: a pick for the host themselves is refused');
    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { [pub('pPickX')]: { id: aang.id }, [pub('pPickY')]: { name: 'aang' } } });
    check(!r.ok && /Xia/.test(r.error) && /Yuri/.test(r.error), 'host-picks: two spellings of one character are refused, naming both players');

    const playerEvents = { X: [], Y: [] };
    X.onAny((ev) => playerEvents.X.push(ev));
    Y.onAny((ev) => playerEvents.Y.push(ev));
    const hostEvents = [];
    H.onAny((ev) => hostEvents.push(ev));

    const hostSetup = nextMatching(H, 'host:state', (v) => v.phase === 'setup');
    const xSetup = nextEvent(X, 'setup:state');
    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { [pub('pPickX')]: { id: aang.id }, [pub('pPickY')]: { name: 'Grandma Jean' } } });
    check(r.ok, 'host-picks: deal starts with one listed pick and one typed name');
    const hv = await hostSetup;
    check(hv.players.length === 2 && !hv.players.some((p) => p.playerId === pub('pPickHost')), 'host-picks: the host is not dealt in');
    check(hv.players.find((p) => p.name === 'Xia')?.character.name === 'Aang', 'host-picks: the listed pick lands on its player');
    check(hv.players.find((p) => p.name === 'Yuri')?.character.name === 'Grandma Jean', 'host-picks: the typed name lands on its player');
    const xv = await xSetup;
    check(xv.rerollAllowed === false, 'host-picks: players cannot reroll the host\'s choice');
    check(!(await X.emitWithAck('setup:reroll', {})).ok, 'host-picks: a reroll request is refused server-side too');

    const xCountdown = nextEvent(X, 'game:countdown');
    const hostCountdown = nextMatching(H, 'host:state', (v) => v.phase === 'countdown');
    const hostPlaying = nextMatching(H, 'host:state', (v) => v.phase === 'playing');
    await X.emitWithAck('setup:confirm', {});
    await Y.emitWithAck('setup:confirm', {});
    await xCountdown;
    check((await hostCountdown).seconds >= 0, 'host-picks: the host gets their own countdown');
    const hp = await hostPlaying;
    check(hp.players.length === 2 && hp.players.every((p) => p.character?.name), 'host-picks: the host watches every character in play');

    check(!(await H.emitWithAck('game:gotit', {})).ok, 'host-picks: the host cannot resolve a turn');

    // A host who reloads mid-game has to land back on their own view, not a player's.
    H.disconnect();
    const H2 = await connect('pPickHost');
    const back = [];
    H2.onAny((ev) => back.push(ev));
    const rejoined = nextMatching(H2, 'host:state', (v) => v.phase === 'playing');
    await H2.emitWithAck('room:join', { code, nickname: 'Hana' });
    check(!!(await rejoined), 'host-picks: a reconnecting host is handed their view back');

    const over = nextEvent(H2, 'game:over');
    const first = hp.current.playerId === pub('pPickX') ? X : Y;
    const second = first === X ? Y : X;
    await first.emitWithAck('game:gotit', {});
    await wait(50);
    await second.emitWithAck('game:gotit', {});
    const result = await over;
    check(result.hostPicked === true && result.standings.length === 2, 'host-picks: game over reaches the host, marked hand-picked');
    check(!(await H2.emitWithAck('game:rematch', {})).ok, 'host-picks: "same settings" refuses to re-deal the same picks');

    const leaked = [...playerEvents.X, ...playerEvents.Y].filter((ev) => ev === 'host:state');
    check(leaked.length === 0, `host-picks: no player ever received the host's view (${leaked.length} leaked)`);
    const misdelivered = [...hostEvents, ...back].filter((ev) => ev === 'setup:state' || ev === 'game:state' || ev === 'game:countdown');
    check(misdelivered.length === 0, `host-picks: the host never got a player's view (${misdelivered.join(', ') || 'none'})`);
    H2.close(); X.close(); Y.close();
  }

  // ---- Pick for each other: nothing dealt, every player picks for the one they check --------
  // Everyone sees every character but their own, so the leak to guard is a player being sent
  // the character someone else picked for them. Every payload each player receives before play
  // is searched for their own final character.
  console.log('\n# pick for each other');
  {
    const E1 = await connect('pEach1');
    let r = await E1.emitWithAck('room:create', { nickname: 'Uma' });
    const code = r.state.code;
    const E2 = await connect('pEach2');
    await E2.emitWithAck('room:join', { code, nickname: 'Vic' });
    const E3 = await connect('pEach3');
    await E3.emitWithAck('room:join', { code, nickname: 'Wes' });
    const socks = { pEach1: E1, pEach2: E2, pEach3: E3 };
    const got = { pEach1: [], pEach2: [], pEach3: [] };
    for (const [id, sock] of Object.entries(socks)) sock.onAny((ev, payload) => got[id].push(JSON.stringify(payload ?? null)));

    const firstViews = Object.fromEntries(Object.entries(socks).map(([id, sock]) => [id, nextEvent(sock, 'setup:state')]));
    r = await E1.emitWithAck('setup:start', { poolType: 'categories', categories: ['TestToons'], difficulty: 'everything', eachPicks: true });
    check(r.ok && r.label === 'Picked for each other', 'each-picks: the host starts a game where everyone picks');
    const v1 = await firstViews.pEach1;
    check(v1.checkerPicks === true && v1.checking.character === null && v1.canConfirm === false, 'each-picks: every seat starts empty');
    const refused = await E1.emitWithAck('setup:confirm', {});
    check(!refused.ok && /Pick a character/.test(refused.error), 'each-picks: nobody locks in with an empty seat');

    // Who checks whom, from the server's own views.
    const targetOf = {};
    for (const [id, p] of Object.entries(firstViews)) targetOf[id] = (await p).checking.ownerId;

    const found = await fetch(`${URL}/api/browse/search?q=Bulma`).then((res) => res.json());
    const bulma = found.characters.find((c) => c.name === 'Bulma');
    r = await E1.emitWithAck('setup:pick', { id: bulma.id });
    check(r.ok, 'each-picks: a library character is picked by id');
    r = await E2.emitWithAck('setup:pick', { name: 'Grandma Jean' });
    check(r.ok, 'each-picks: any typed name is picked');
    r = await E3.emitWithAck('setup:reroll', {});
    check(r.ok, 'each-picks: Random fills an empty seat from the pool');

    const room = registry.getRoom(code);
    const finalOf = (id) => room.game.headByPlayer[id]?.name;
    check(finalOf(targetOf.pEach1) === 'Bulma' && finalOf(targetOf.pEach2) === 'Grandma Jean' && SEEDED_NAMES.includes(finalOf(targetOf.pEach3)),
      'each-picks: every pick lands on the player its picker checks');

    const playing = roomStatus(E1, 'countdown');
    for (const sock of Object.values(socks)) await sock.emitWithAck('setup:confirm', {});
    check(!!(await playing), 'each-picks: once every seat is filled and everyone is in, play begins');

    const leaks = Object.keys(socks).filter((id) => {
      const own = JSON.stringify(finalOf(pub(id))).slice(1, -1);
      const beforePlay = got[id].slice(0, got[id].findIndex((j) => j.includes('"status":"countdown"')));
      return beforePlay.some((j) => j.includes(own));
    });
    check(leaks.length === 0, `each-picks: nobody was sent the character picked for them${leaks.length ? ` (${leaks.join(', ')})` : ''}`);
    check(room.lastSetup.eachPicks === true && room.lastSetup.categories[0] === 'TestToons', 'each-picks: remembered for a rematch, with its categories');
    await E1.emitWithAck('setup:cancel', {});
    E1.close(); E2.close(); E3.close();
  }

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
  // Cloudflare turns no-cache on scripts into a 4-hour max-age, so a page's scripts and styles
  // carry their file's version in the URL -- or a player runs today's page on yesterday's script.
  const pageHtml = await fetch(`${URL}/`).then((r) => r.text());
  const deskHtml = await fetch(`${URL}/desk/`).then((r) => r.text());
  check(/src="\/?app\.js\?v=\d+"/.test(pageHtml) && /src="\/?tilt\.js\?v=\d+"/.test(pageHtml), "the phones' page loads its scripts by version");
  check(/href="\/shared\/theme\.css\?v=\d+"/.test(deskHtml) && /src="app\.js\?v=\d+"/.test(deskHtml), 'the computer page loads its shared styles and script by version');
  check(/src="\/socket\.io\/socket\.io\.js"/.test(pageHtml), "socket.io's own client is left alone");
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

  // Compendium. Read-only, so the risk is a broken route rather than broken state -- and the
  // scope check matters as much here as on /img, since listId comes from a client.
  const cats = await fetch(`${URL}/api/browse/categories`).then((r) => r.json());
  check(Array.isArray(cats.categories) && cats.categories.length > 0, 'browse: categories load');
  const someCat = cats.categories[0].category;
  const listing = await fetch(`${URL}/api/browse/lists?category=${encodeURIComponent(someCat)}`).then((r) => r.json());
  check(listing.lists.length > 0 && listing.lists[0].name, 'browse: a category lists its titles');
  const someList = listing.lists[0];
  const chars = await fetch(`${URL}/api/browse/characters?listId=${someList.id}&limit=3`).then((r) => r.json());
  check(chars.characters.length > 0 && typeof chars.total === 'number', 'browse: a list pages its characters');
  check(chars.characters.length <= 3, 'browse: the page limit is honoured');
  check((await httpGet('/api/browse/lists')).status === 400, 'browse: lists without a category is refused');
  check((await httpGet('/api/browse/characters?listId=999999999')).status === 404, 'browse: an unknown list is refused');

  // The join QR is built from this origin. Behind a TLS-terminating proxy the hop to us is
  // plain HTTP, and a QR that encodes http:// silently costs whoever scans it their tilt
  // controls -- browsers only expose motion sensors in a secure context.
  const proxied = await fetch(`${URL}/api/health`, {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' },
  }).then((r) => r.json());
  check(proxied.joinUrlBase === 'https://example.test', 'join URL honours a proxy that terminated TLS');
  const direct = await fetch(`${URL}/api/health`).then((r) => r.json());
  check(direct.joinUrlBase.startsWith('http://'), 'join URL is plain http when not proxied');

  // ---- Desk: Guess the Character on computers (/desk namespace) ------------------------------
  //
  // The same game played the other way round: everybody's character on screen but your own, and
  // typed guesses. The leak that would ruin it is a payload naming your own character, so EVERY
  // event each player receives is recorded and searched, not just the obvious fields.
  console.log('\n# desk — computers: board, typed guesses, rulings');
  const connectDesk = (pid) => {
    const sock = io(`${URL}/desk`, { auth: { playerId: pid } });
    sock.received = [];
    sock.onAny((event, payload) => sock.received.push({ event, json: JSON.stringify(payload ?? null) }));
    return new Promise((r) => sock.on('connect', () => r(sock)));
  };
  const W = await connectDesk('dW');
  res = await W.emitWithAck('room:create', { nickname: 'Wren' });
  check(res.ok && res.state.kind === 'desk', 'a computer creates a desk room');
  const deskCode = res.state.code;
  // The home page's computer join box asks which game a code is for. Asserted positively: a 404
  // alone would pass with the route deleted.
  const lookup = await fetch(`${URL}/api/room?code=${deskCode.toLowerCase()}`);
  const found = await lookup.json();
  check(lookup.status === 200 && found.path === '/desk/' && found.kind === 'desk' && Object.keys(found).length === 2,
    'GET /api/room says which game a code is for, and nothing more');
  check((await fetch(`${URL}/api/room?code=ZZZZ`)).status === 404, 'GET /api/room 404s an unknown code');
  const X = await connectDesk('dX');
  res = await X.emitWithAck('room:join', { code: deskCode, nickname: 'Xia' });
  check(res.ok && res.state.players.length === 2, 'a second computer joins it');

  // One registry, two games: neither may walk into the other's room.
  const phone = await connect('pPhone');
  res = await phone.emitWithAck('room:join', { code: deskCode, nickname: 'Phone' });
  check(!res.ok && /computer/.test(res.error), "a phone cannot join a computer's room, and is told why");
  res = await W.emitWithAck('room:join', { code: code2, nickname: 'Wren' });
  check(!res.ok && /phone/.test(res.error), "a computer cannot join a phone's room");
  phone.close();
  // ...and its own room again, which that refusal must not have cost it.
  res = await W.emitWithAck('room:join', { code: deskCode, nickname: 'Wren' });
  check(res.ok && res.reconnected, 'the desk host still holds its own seat');

  const wSetup = nextEvent(W, 'setup:state');
  const xSetup = nextEvent(X, 'setup:state');
  res = await W.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', turnSeconds: 60 });
  check(res.ok, 'the desk host deals');
  await Promise.all([wSetup, xSetup]);

  // No countdown on a computer: the game begins the moment both are in.
  const wFirst = nextEvent(W, 'game:state');
  const xFirst = nextEvent(X, 'game:state');
  await W.emitWithAck('setup:confirm', {});
  await X.emitWithAck('setup:confirm', {});
  const [wView, xView] = await Promise.all([wFirst, xFirst]);
  check(wView.phase === 'playing' && wView.board.length === 2, 'play starts straight away, with a board of two');
  const guesser = wView.isMyTurn ? W : X;
  const ruler = guesser === W ? X : W;
  const guesserId = guesser === W ? pub('dW') : pub('dX');
  const rulerId = guesser === W ? pub('dX') : pub('dW');
  const rulerView = guesser === W ? xView : wView;
  const guesserView = guesser === W ? wView : xView;
  const answer = rulerView.board.find((b) => b.playerId === guesserId).character.name;
  const rulerAnswer = guesserView.board.find((b) => b.playerId === rulerId).character.name;
  check(guesserView.board.find((b) => b.isMe).character === null, "the guesser's own card is face down");
  check(guesserView.buttons && guesserView.buttons.gotIt === false, 'a computer has no got-it button, only typing');

  // Setup actions are over once play begins. Unlock + confirm used to re-run the start of play --
  // charging the guesser a turn and resetting their clock -- and unlock + reroll swapped the
  // character they were wearing mid-turn. Sent by the player NOT guessing, who is the one with a motive.
  const turnBefore = guesserView.current.turnNumber;
  const lateUnlock = await ruler.emitWithAck('setup:unlock', {});
  const lateConfirm = await ruler.emitWithAck('setup:confirm', {});
  const lateReroll = await ruler.emitWithAck('setup:reroll', {});
  const afterLate = await new Promise((resolve) => ruler.emit('game:resync', {}, () => resolve(ruler.received.filter((e) => e.event === 'game:state').at(-1))));
  const lateView = JSON.parse(afterLate.json);
  check(
    !lateUnlock.ok && !lateConfirm.ok && !lateReroll.ok &&
      lateView.current.turnNumber === turnBefore &&
      lateView.board.find((b) => b.playerId === guesserId).character.name === answer,
    `mid-game setup actions are refused: no extra turn, no swapped character (${[lateUnlock, lateConfirm, lateReroll].map((r) => r.ok).join('/')})`
  );

  // A miss: costs nothing, the turn goes on, and everyone sees it in the log.
  const rulerSeesMiss = nextMatching(ruler, 'game:state', (v) => v.guesses.length === 1);
  res = await guesser.emitWithAck('game:guess', { text: 'Definitely Nobody' });
  check(res.ok && res.verdict === 'wrong', 'a wrong guess is judged wrong');
  check((await rulerSeesMiss).current.playerId === guesserId, '...and the turn goes on');

  // A typo: close, so the OTHER player rules. Their view says what it is held up against.
  const typo = answer.slice(0, -1) + (answer.endsWith('x') ? 'y' : 'x');
  const rulerSeesRuling = nextMatching(ruler, 'game:state', (v) => !!v.ruling);
  res = await guesser.emitWithAck('game:guess', { text: typo });
  check(res.ok && res.verdict === 'close', `a typo ("${typo}" for "${answer}") is close`);
  const ruling = (await rulerSeesRuling).ruling;
  check(ruling.canRule && ruling.answer.name === answer, 'the other player is asked to rule, and shown the answer');
  res = await guesser.emitWithAck('game:rule', { id: ruling.id, accept: true });
  check(!res.ok, 'the guesser cannot rule on their own guess');
  const revealed = nextEvent(guesser, 'game:reveal');
  res = await ruler.emitWithAck('game:rule', { id: ruling.id, accept: true });
  check(res.ok && res.accepted, 'the other player accepts it');
  const reveal = await revealed;
  check(reveal.kind === 'got' && reveal.playerId === guesserId && reveal.character.name === answer, 'an accepted ruling is "got it", revealed');

  // The second player, exactly right, ends the game.
  const deskOver = nextEvent(W, 'game:over');
  await nextMatching(ruler, 'game:state', (v) => v.isMyTurn);
  res = await ruler.emitWithAck('game:guess', { text: rulerAnswer.toLowerCase() });
  check(res.ok && res.verdict === 'correct', 'an exact guess, in any case, is correct');
  const deskResult = await deskOver;
  check(deskResult.standings.length === 2 && deskResult.winners.some((w) => w.playerId === guesserId), 'the game ends with the first to get it winning');

  // The leak check, over everything each computer was sent before its own reveal.
  const leakedTo = (sock, pid, own) => {
    const until = sock.received.findIndex((e) => e.event === 'game:reveal' && JSON.parse(e.json).playerId === pid);
    const before = until === -1 ? sock.received : sock.received.slice(0, until);
    return before.filter((e) => e.json.includes(JSON.stringify(own).slice(1, -1)));
  };
  const leaks = [...leakedTo(guesser, guesserId, answer), ...leakedTo(ruler, rulerId, rulerAnswer)];
  check(leaks.length === 0, `no computer was ever sent its own character before getting it${leaks.length ? `: ${leaks.map((e) => e.event).join(', ')}` : ''}`);

  const deskPage = await httpGet('/desk/');
  check(deskPage.status === 200 && deskPage.type.includes('text/html'), 'GET /desk/ serves the computer client');
  check((await httpGet('/desk/app.js')).type.includes('javascript'), 'GET /desk/app.js serves its script');
  check((await httpGet('/desk')).status === 301, 'GET /desk redirects to /desk/, so relative links resolve');
  W.close(); X.close();

  // ---- Draw the Character (/draw namespace) ------------------------------------------------
  //
  // One draws, the other guesses. What must never happen: the answer -- or the other two
  // characters the drawer was offered -- reaching a guesser before they have it.
  // ---- Desk: I'll pick them. The same protocol as the phones, through the desk namespace and its
  // board view -- which must never carry the host's view to a player.
  console.log("\n# desk — I'll pick them");
  {
    const DH = await connectDesk('dPickHost');
    let r = await DH.emitWithAck('room:create', { nickname: 'Hal' });
    const code = r.state.code;
    const D1 = await connectDesk('dPick1');
    await D1.emitWithAck('room:join', { code, nickname: 'Ivy' });
    const D2 = await connectDesk('dPick2');
    await D2.emitWithAck('room:join', { code, nickname: 'Jon' });
    const hostSetup = nextMatching(DH, 'host:state', (v) => v.phase === 'setup');
    r = await DH.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { [pub('dPick1')]: { name: 'Grandma Jean' } } });
    check(r.ok, "desk host-picks: the host deals one typed pick and one random");
    const hv = await hostSetup;
    check(hv.players.length === 2 && hv.players.find((p) => p.name === 'Ivy')?.character.name === 'Grandma Jean', 'desk host-picks: the host sees the picks, and is not dealt in');
    const playing = nextMatching(DH, 'host:state', (v) => v.phase === 'playing');
    await D1.emitWithAck('setup:confirm', {});
    await D2.emitWithAck('setup:confirm', {});
    const hp = await playing;
    check(hp.players.every((p) => p.character?.name) && typeof hp.turnRemaining === 'number', 'desk host-picks: the host watches every character and the clock');
    const sentToPlayers = [...D1.received, ...D2.received].filter((e) => e.event === 'host:state').length;
    check(sentToPlayers === 0, `desk host-picks: no player received the host's view (${sentToPlayers})`);
    check(!DH.received.some((e) => e.event === 'setup:state' || e.event === 'game:state'), "desk host-picks: the host never got a player's view");
    check(!D1.received.some((e) => e.event === 'game:state' && e.json.includes('Grandma Jean')), 'desk host-picks: Ivy is never shown her own pick');
    DH.close(); D1.close(); D2.close();
  }

  // ---- Desk: the host removes someone mid-game. The Room menu offers it at every stage, so the
  // server must take it at every stage -- here, the one with most to undo: a turn loop running.
  console.log('\n# desk — the host removes someone mid-game');
  {
    const KH = await connectDesk('dKickHost');
    let r = await KH.emitWithAck('room:create', { nickname: 'Kim' });
    const code = r.state.code;
    const K1 = await connectDesk('dKick1');
    await K1.emitWithAck('room:join', { code, nickname: 'Lou' });
    const K2 = await connectDesk('dKick2');
    await K2.emitWithAck('room:join', { code, nickname: 'Max' });
    await KH.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', turnSeconds: 60 });
    const started = nextMatching(KH, 'game:state', (v) => v.phase === 'playing');
    for (const s of [KH, K1, K2]) await s.emitWithAck('setup:confirm', {});
    await started;
    const kicked = nextEvent(K2, 'room:kicked');
    const maxOut = nextMatching(KH, 'game:state', (v) => v.board.find((b) => b.playerId === pub('dKick2'))?.status === 'gave_up');
    r = await KH.emitWithAck('room:kick', { playerId: pub('dKick2') });
    check(r.ok, 'desk kick: the host can remove a player mid-game');
    check(!!(await Promise.race([kicked, wait(2000).then(() => null)])), 'desk kick: the removed player is told');
    const after = await Promise.race([maxOut, wait(2000).then(() => null)]);
    check(after?.phase === 'playing', 'desk kick: they drop out, as if they had left, and the game carries on');
    KH.close(); K1.close(); K2.close();
  }

  // ---- Desk: the host's pause. The clock stops, nobody's turn moves, and a turn that ends while
  // paused (here: the guesser removed) arms the next one frozen.
  console.log('\n# desk — the host pauses and continues');
  {
    const PH = await connectDesk('dPauseHost');
    let r = await PH.emitWithAck('room:create', { nickname: 'Pat' });
    const code = r.state.code;
    const P1 = await connectDesk('dPause1');
    await P1.emitWithAck('room:join', { code, nickname: 'Quin' });
    const P2 = await connectDesk('dPause2');
    await P2.emitWithAck('room:join', { code, nickname: 'Rae' });
    await PH.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', turnSeconds: 60 });
    const started = nextMatching(PH, 'game:state', (v) => v.phase === 'playing');
    for (const s of [PH, P1, P2]) await s.emitWithAck('setup:confirm', {});
    let first = await started;
    const socks = { [pub('dPauseHost')]: PH, [pub('dPause1')]: P1, [pub('dPause2')]: P2 };
    // The guesser must be someone the host can remove: if the host goes first, they pass.
    if (first.current.playerId === pub('dPauseHost')) {
      const moved = nextMatching(PH, 'game:state', (v) => v.current.playerId !== pub('dPauseHost'));
      await PH.emitWithAck('game:pass', {});
      first = await moved;
    }
    const guesser = socks[first.current.playerId];
    check(!(await P1.emitWithAck('room:pause', { paused: true })).ok || P1 === PH, 'pause: only the host can pause');
    const pausedRoom = nextMatching(P2, 'room:state', (s) => s.paused === true);
    const frozen = nextMatching(PH, 'game:state', (v) => v.hostPaused === true);
    r = await PH.emitWithAck('room:pause', { paused: true });
    check(r.ok && r.paused === true, 'pause: the host pauses a running game');
    check(!!(await Promise.race([pausedRoom, wait(2000).then(() => null)])), 'pause: every screen is told the room is paused');
    const f1 = await frozen;
    await wait(1200);
    const again = await PH.emitWithAck('game:resync', {});
    const f2 = PH.received.filter((e) => e.event === 'game:state').map((e) => JSON.parse(e.json)).pop();
    check(again.ok && f2.turnRemaining === f1.turnRemaining, `pause: the clock stands still (${f1.turnRemaining}s, then ${f2.turnRemaining}s)`);
    check(!(await guesser.emitWithAck('game:pass', {})).ok, "pause: the guesser's turn cannot move");
    // The guesser is removed while paused: the next turn starts, and starts frozen, with its whole clock.
    const next = nextMatching(PH, 'game:state', (v) => v.current.playerId !== first.current.playerId);
    await PH.emitWithAck('room:kick', { playerId: first.current.playerId });
    const n = await Promise.race([next, wait(2000).then(() => null)]);
    check(n?.hostPaused === true && n.turnRemaining === 60, `pause: a turn that begins while paused begins frozen, with its whole clock (${n?.turnRemaining}s)`);
    await wait(1200);
    await PH.emitWithAck('game:resync', {});
    const still = PH.received.filter((e) => e.event === 'game:state').map((e) => JSON.parse(e.json)).pop();
    check(still.turnRemaining === 60, `pause: and stays frozen (${still.turnRemaining}s)`);
    const running = nextMatching(PH, 'game:state', (v) => v.hostPaused === false);
    r = await PH.emitWithAck('room:pause', { paused: false });
    const after = await Promise.race([running, wait(2000).then(() => null)]);
    check(r.ok && after && after.turnRemaining > 0, 'pause: Continue starts the clock again');
    await wait(1500);
    await PH.emitWithAck('game:resync', {});
    const later = PH.received.filter((e) => e.event === 'game:state').map((e) => JSON.parse(e.json)).pop();
    check(later.turnRemaining < after.turnRemaining, `pause: and it runs (${after.turnRemaining}s, then ${later.turnRemaining}s)`);
    PH.close(); P1.close(); P2.close();
  }

  // ---- Desk: a table that has gone quiet. Two full rounds of turns time out with nobody touching
  // anything and the game pauses itself: no clock runs, and anyone -- not only the host, who may be
  // one of the people who wandered off -- carries on. Then the room is deleted with its game still
  // running, and its clock must stop with it.
  console.log('\n# desk — a deserted game pauses itself');
  {
    const QH = await connectDesk('dQuietHost');
    let r = await QH.emitWithAck('room:create', { nickname: 'Sol' });
    const code = r.state.code;
    const Q1 = await connectDesk('dQuiet1');
    await Q1.emitWithAck('room:join', { code, nickname: 'Tam' });
    await QH.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', turnSeconds: 60 });
    const started = nextMatching(QH, 'game:state', (v) => v.phase === 'playing');
    for (const s of [QH, Q1]) await s.emitWithAck('setup:confirm', {});
    await started;
    const live = registry.getRoom(code);
    // Fast-forward the quiet: all but the last of two rounds' timeouts already counted, then one
    // real one, through the watchdog, as a turn that ran out while everyone was away.
    live.game.idleTimeouts = 2 * live.game.activePlayers.length - 1;
    const quiet = nextMatching(Q1, 'room:state', (st) => st.idlePaused === true);
    live.game.turnEndsAt = Date.now() - 1;
    const q = await Promise.race([quiet, wait(6000).then(() => null)]);
    check(q?.paused === true, 'deserted: two quiet rounds pause the game');
    check(live.turnTimer == null && live.game.turnEndsAt == null, 'deserted: and no clock runs while nobody is there');
    const host = live.hostPlayerId === pub('dQuietHost') ? QH : Q1;
    const other = host === QH ? Q1 : QH;
    check(!(await other.emitWithAck('room:pause', { paused: true })).ok, 'deserted: a player who is not the host still cannot pause');
    const resumed = nextMatching(host, 'room:state', (st) => st.paused === false);
    r = await other.emitWithAck('room:pause', { paused: false });
    check(r.ok && !!(await Promise.race([resumed, wait(2000).then(() => null)])), 'deserted: anyone can carry on, not only the host');
    check(live.game.idleTimeouts === 0 && live.game.turnEndsAt > Date.now() && !!live.turnTimer,
      'deserted: carrying on starts the clock, and the quiet count afresh');
    // Deleted with its game running -- the sweep's case: seats nobody has given up -- and the clock goes too.
    for (const id of [...live.players.keys()]) registry.leaveRoom(code, id);
    check(!registry.getRoom(code) && live.turnTimer == null && live.pauseGuard == null, 'a deleted room takes its turn clock with it');
    QH.close(); Q1.close();
  }

  console.log('\n# draw — one draws, everyone else guesses');
  const connectDraw = (pid) => {
    const sock = io(`${URL}/draw`, { auth: { playerId: pid } });
    sock.received = [];
    sock.onAny((event, payload) => sock.received.push({ event, json: JSON.stringify(payload ?? null) }));
    return new Promise((r) => sock.on('connect', () => r(sock)));
  };
  const P = await connectDraw('rP');
  res = await P.emitWithAck('room:create', { nickname: 'Pia' });
  check(res.ok && res.state.kind === 'draw', 'a draw room is created');
  // The palette is published, not re-declared: the client draws its swatches from this.
  const { PALETTE: drawPalette } = require('../src/web/draw/socket');
  check(JSON.stringify(res.state.palette) === JSON.stringify(drawPalette) && res.state.sizes?.length > 0,
    `a draw room's state carries the palette and brush sizes (${res.state.palette?.length} colours)`);
  const drawCode = res.state.code;
  const Q = await connectDraw('rQ');
  res = await Q.emitWithAck('room:join', { code: drawCode, nickname: 'Quinn' });
  check(res.ok, 'a second player joins');
  const deskSock = await connectDesk('dZ');
  res = await deskSock.emitWithAck('room:join', { code: drawCode, nickname: 'Z' });
  check(!res.ok && /Draw the Character/.test(res.error), 'the guessing game cannot join a drawing room');
  check(res.kind === 'draw', 'and is told which game it is, so a page can send the player there');
  deskSock.close();
  // The phones' join box forwards a Draw code to /draw/ on exactly this answer.
  const phoneSock = await connect('rPhoneToDraw');
  res = await phoneSock.emitWithAck('room:join', { code: drawCode, nickname: 'Phone' });
  check(!res.ok && res.kind === 'draw', `a phone typing a Draw code learns it is Draw (${JSON.stringify(res)})`);
  phoneSock.close();

  const pFirst = nextEvent(P, 'draw:state');
  const qFirst = nextEvent(Q, 'draw:state');
  res = await P.emitWithAck('draw:start', { poolType: 'everything', difficulty: 'everything', rounds: 1, drawSeconds: 60 });
  check(res.ok, 'the host starts a one-round game');
  const [pState, qState] = await Promise.all([pFirst, qFirst]);
  check(pState.phase === 'choosing' && pState.isDrawer && pState.choices.length >= 1, 'the first drawer is offered characters');
  check(qState.choices === null && qState.character === null, "the guesser sees neither the choices nor the answer");
  const offered = pState.choices.map((c) => c.name);

  // New choices: the drawer only, and never the faces just turned down. The seed has seven
  // characters, so three offered leaves four to offer anew.
  check(!(await Q.emitWithAck('draw:reroll', {})).ok, 'a guesser cannot ask for new choices');
  const pRerolled = nextMatching(P, 'draw:state', (v) => v.phase === 'choosing' && v.choices?.[0]?.name !== offered[0]);
  res = await P.emitWithAck('draw:reroll', {});
  check(res.ok, 'the drawer asks for new choices');
  const newChoices = (await pRerolled).choices.map((c) => c.name);
  check(newChoices.length >= 1 && newChoices.every((n) => !offered.includes(n)), 'the new choices are all new');
  check((await pRerolled).rerollsLeft === -1, 'new choices are unlimited');
  offered.push(...newChoices); // the guesser must see none of these either

  const qDrawing = nextMatching(Q, 'draw:state', (v) => v.phase === 'drawing');
  const pDrawing = nextMatching(P, 'draw:state', (v) => v.phase === 'drawing');
  res = await P.emitWithAck('draw:choose', { index: 0 });
  check(res.ok, 'the drawer chooses');
  const qView = await qDrawing;
  const drawAnswer = newChoices[0];
  check((await pDrawing).character?.name === drawAnswer, 'the drawer keeps the character (its reference picture) while drawing');
  // The blanks wait for half time (the schedule itself is test/draw.test.js's, on a fake clock):
  // here, that none is sent early and the page is told when they come.
  check(qView.mask === null && qView.maskAt === Math.round(qView.drawSeconds / 2), `the guesser gets no blanks before half time, only when they come (${qView.maskAt}s)`);
  // Expected from the compendium, not restated: whatever the fixture says this character is from.
  // The fixture is one category, so the room knows it already and it shows from the start.
  const drawOrigin = characterLists.getCharacterOrigin(process.env.WEB_SCOPE, drawAnswer);
  check(
    drawOrigin?.category && qView.clue?.category === drawOrigin.category && qView.clue.work === null &&
      qView.clue.workAt === (drawOrigin.work ? Math.round(qView.drawSeconds / 4) : null),
    `one category in the room: the kind of work from the start, the work held for the last quarter (${JSON.stringify(qView.clue)})`
  );

  // Strokes: passed on when they are what the client could make, dropped when not.
  const strokeArrives = nextEvent(Q, 'draw:stroke');
  P.emit('draw:stroke', { id: 's1', color: '#e21b3c', size: 8, points: [[0.1, 0.1], [0.2, 0.25]] });
  const relayed = await strokeArrives;
  check(relayed.id === 's1' && relayed.points.length === 2, "the drawer's stroke reaches the guesser");
  // Every colour on offer must also be one the server draws -- the last one, taken from the
  // palette rather than named here, so a colour added later is covered too.
  const lastColour = drawPalette[drawPalette.length - 2][0]; // the last before the eraser
  const colourArrives = nextEvent(Q, 'draw:stroke');
  P.emit('draw:stroke', { id: 's1b', color: lastColour, size: 8, points: [[0.4, 0.4]] });
  check((await colourArrives).color === lastColour, `a stroke in any palette colour is drawn (${lastColour})`);
  // The bucket: a fill relays whole, and keeps its kind; one with two points is not a fill.
  const fillArrives = nextEvent(Q, 'draw:stroke');
  P.emit('draw:stroke', { id: 'f1', kind: 'fill', color: '#ffd60a', points: [[0.5, 0.5]] });
  const fill = await fillArrives;
  check(fill.id === 'f1' && fill.kind === 'fill' && fill.points.length === 1, 'a fill reaches the guesser as a fill');
  P.emit('draw:stroke', { id: 'f2', kind: 'fill', color: '#ffd60a', points: [[0.1, 0.1], [0.2, 0.2]] });
  P.emit('draw:stroke', { id: 's2', color: 'url(javascript:alert(1))', size: 8, points: [[0.3, 0.3]] });
  P.emit('draw:stroke', { id: 's3', color: '#e21b3c', size: 8, points: [[5, -2]] });
  Q.emit('draw:stroke', { id: 's4', color: '#e21b3c', size: 8, points: [[0.5, 0.5]] });
  await wait(150);
  check(!Q.received.some((e) => e.event === 'draw:stroke' && /"(s[234]|f2)"/.test(e.json)), 'a bad colour, an off-canvas point, a malformed fill and a non-drawer\'s stroke are all dropped');
  const reconnecting = await connectDraw('rQ');
  const caughtUp = nextEvent(reconnecting, 'draw:canvas');
  await reconnecting.emitWithAck('room:join', { code: drawCode, nickname: 'Quinn' });
  const caughtIds = (await caughtUp).strokes.map((s) => s.id).join(',');
  check(caughtIds === 's1,s1b,f1', `a reconnecting browser gets the picture so far, fills included, and only what was drawn (${caughtIds})`);
  reconnecting.close();

  res = await Q.emitWithAck('draw:say', { text: 'Definitely Nobody' });
  check(res.ok && res.verdict === 'wrong', 'a wrong guess is wrong, and shown');
  // Reactions: a guesser's floats to everyone, the drawer's own and unknown kinds are refused.
  {
    const toDrawer = nextEvent(P, 'draw:reaction');
    res = await Q.emitWithAck('draw:react', { kind: 'star' });
    const got = await Promise.race([toDrawer, wait(2000).then(() => null)]);
    check(res.ok && got?.kind === 'star' && Object.keys(got).length === 1, 'reactions: a guesser\'s reaction reaches the drawer, and says nothing else');
    check(!(await P.emitWithAck('draw:react', { kind: 'star' })).ok, 'reactions: the drawer does not react to their own drawing');
    check(!(await Q.emitWithAck('draw:react', { kind: 'pikachu' })).ok, 'reactions: only the fixed few -- none can carry a word');
  }
  // The host's pause, mid-drawing: the clock stands still and nothing is played until Continue.
  {
    const pausedView = nextMatching(Q, 'draw:state', (v) => v.paused === true);
    res = await P.emitWithAck('room:pause', { paused: true });
    check(res.ok && res.paused === true, 'draw pause: the host pauses mid-drawing');
    const pv = await Promise.race([pausedView, wait(2000).then(() => null)]);
    check(!!pv, 'draw pause: the guesser sees the game paused');
    check(!(await Q.emitWithAck('draw:say', { text: drawAnswer })).ok, 'draw pause: no guess counts while paused');
    check(!(await Q.emitWithAck('room:pause', { paused: false })).ok, 'draw pause: only the host can continue');
    const runningView = nextMatching(Q, 'draw:state', (v) => v.paused === false);
    res = await P.emitWithAck('room:pause', { paused: false });
    const rv = await Promise.race([runningView, wait(2000).then(() => null)]);
    check(res.ok && rv && rv.secondsLeft >= pv.secondsLeft - 1, `draw pause: Continue picks up where it stopped (${pv.secondsLeft}s, then ${rv?.secondsLeft}s)`);
  }
  const typoDraw = drawAnswer.slice(0, -1) + (drawAnswer.endsWith('x') ? 'y' : 'x');
  const drawerSeesClose = nextMatching(P, 'draw:state', (v) => v.chat.some((m) => m.text === typoDraw));
  const qSince = Q.received.length;
  res = await Q.emitWithAck('draw:say', { text: typoDraw });
  check(res.ok && res.verdict === 'close', 'a typo is close');
  // Raced against a clock: before this was fixed the drawer was never sent it, and a bare wait hangs.
  const closeView = await Promise.race([drawerSeesClose, wait(2000).then(() => null)]);
  const closeLine = closeView?.chat.find((m) => m.text === typoDraw);
  check(closeLine?.kind === 'close', 'the drawer sees the close guess, marked close, as it happens');
  await wait(100);
  check(!Q.received.slice(qSince).some((e) => e.json.includes(typoDraw)), 'and no one still guessing is sent it -- the guesser has their ack');

  // A one-word guess is judged against the drawn character's own show, which the server must hand
  // the rules: the cast of the fixture's one list, every name in it.
  const drawGame = registry.getRoom(drawCode).game;
  const cast = drawGame.castOf?.(drawGame.character);
  check(cast?.size === SEEDED_NAMES.length && cast.sharesWord('aang', 'bulma') === true,
    `draw: a guess of one word is judged against the character's own show (${cast?.size} names)`);

  const qGotIt = nextEvent(Q, 'draw:correct');
  const reveal1 = nextMatching(P, 'draw:state', (v) => v.phase === 'reveal');
  res = await Q.emitWithAck('draw:say', { text: drawAnswer.toUpperCase() });
  check(res.ok && res.verdict === 'correct' && res.points > 0, 'the right name scores');
  const qGot = await qGotIt;
  check(qGot.playerId === pub('rQ'), "draw:correct says who got it, so the guesser's own page can tell");
  check(qGot.nth === 1, `draw:correct counts who has it, for the climbing cue (first: ${qGot.nth})`);
  check((await reveal1).lastTurn.character.name === drawAnswer, 'everyone guessed, so the turn ends with the reveal');
  const guesserLeaks = (() => {
    const until = Q.received.findIndex((e) => e.event === 'draw:correct');
    const before = Q.received.slice(0, until);
    return offered.filter((name) => before.some((e) => e.json.includes(JSON.stringify(name).slice(1, -1))));
  })();
  check(guesserLeaks.length === 0, `the guesser was never sent the answer or the other choices${guesserLeaks.length ? `: ${guesserLeaks.join(', ')}` : ''}`);

  // The second turn: Quinn draws, and the game ends after it (one round).
  const qChoosing = nextMatching(Q, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
  const second = await qChoosing;
  check(second.drawer.playerId === pub('rQ'), 'after the reveal, the next player draws');
  // Quinn has the blanks spell another name, one Quinn accepts: it reaches the guesser only at the end.
  const pDrawing2 = nextMatching(P, 'draw:state', (v) => v.phase === 'drawing');
  const qDrawing2 = nextMatching(Q, 'draw:state', (v) => v.phase === 'drawing');
  await Q.emitWithAck('draw:choose', { index: 0, alsoAccept: 'Zed Prime', shownAs: 'Zed Prime' });
  await pDrawing2;
  check((await qDrawing2).shownAs === 'Zed Prime', 'the drawer picks what the blanks spell, and sees it');
  const drawOver = nextEvent(P, 'draw:over');
  const pSince = P.received.length;
  await P.emitWithAck('draw:say', { text: second.choices[0].name });
  const final = await drawOver;
  const pBefore = P.received.slice(0, pSince);
  check(!pBefore.some((e) => e.json.includes('Zed Prime')), 'the guesser is never sent the spelling before getting it');
  check(final.gallery?.[1]?.character?.name === 'Zed Prime' && final.gallery[1].character.realName === second.choices[0].name,
    'the gallery names the drawing as the blanks spelled it, with the real name beside it');
  check(final.standings.length === 2 && final.standings.every((s) => s.score > 0), 'after everyone has drawn once, the game ends with scores');
  // The gallery: both drawings, in order, the first with the strokes Pia drew (the bad ones dropped).
  const g1 = final.gallery?.[0];
  check(final.gallery?.length === 2 && g1.drawer === 'Pia' && g1.character?.name === drawAnswer && g1.strokes.length === caughtIds.split(',').length,
    `the end screen gets every drawing, its strokes and its character (${final.gallery?.length} drawings, ${g1?.strokes.length} strokes)`);
  check(g1.got.length === 1 && g1.got[0].name === 'Quinn' && g1.guessers === 1, 'and who got each one');
  check(Array.isArray(final.accolades) && final.accolades.some((a) => a.title === 'Speed Demon'), `and the accolades (${final.accolades?.map((a) => a.title).join(', ')})`);
  // The vote: Quinn votes for Pia's drawing; everyone gets the tally, nobody who voted for what.
  {
    const tally = nextEvent(P, 'draw:votes');
    res = await Q.emitWithAck('draw:vote', { drawing: 0 });
    const t = await Promise.race([tally, wait(2000).then(() => null)]);
    check(res.ok && res.mine === 0 && t?.counts?.[0] === 1 && !('mine' in t), 'the vote: counted, and only the tally goes out');
    check(!(await P.emitWithAck('draw:vote', { drawing: 0 })).ok, 'the vote: never for your own drawing');
  }

  const drawPage = await httpGet('/draw/');
  check(drawPage.status === 200 && drawPage.type.includes('text/html'), 'GET /draw/ serves the drawing client');
  check((await httpGet('/shared/theme.css')).type.includes('css'), 'GET /shared/theme.css serves the common look');
  check((await httpGet('/shared/common.js')).type.includes('javascript'), 'GET /shared/common.js serves the common helpers');
  // Positively: the static handler 404s a missing file too, so look for what the file defines.
  const soundJs = await fetch(`${URL}/shared/sound.js`).then(async (r) => ({ ok: r.ok, body: await r.text() }));
  check(soundJs.ok && soundJs.body.includes('window.GTCSound'), 'GET /shared/sound.js serves the computer games\' sound');
  for (const game of ['/desk/', '/draw/']) {
    const html = await fetch(`${URL}${game}`).then((r) => r.text());
    check(html.includes('/shared/sound.js') && html.includes('id="soundToggle"'), `${game} loads the sound and has its switch`);
  }
  // Leaving and removing live in the Room menu, in every game. Positively: the file and its use.
  const roomMenuJs = await fetch(`${URL}/shared/roommenu.js`).then(async (r) => ({ ok: r.ok, body: await r.text() }));
  check(roomMenuJs.ok && roomMenuJs.body.includes('window.GTCRoomMenu'), 'GET /shared/roommenu.js serves the Room menu');
  for (const game of ['/', '/desk/', '/draw/']) {
    const html = await fetch(`${URL}${game}`).then((r) => r.text());
    check(html.includes('/shared/roommenu.js') && html.includes('id="roomBtn"'), `${game} loads the Room menu and has its button`);
  }
  P.close(); Q.close();

  // ---- Draw: Telephone. Three play at once, each on a chain; nobody is sent another chain's work
  // until the replay. Searched in whole payloads, every event each player received.
  console.log('\n# draw — telephone');
  {
    const T1 = await connectDraw('tTel1');
    let r = await T1.emitWithAck('room:create', { nickname: 'Tia' });
    const code = r.state.code;
    const T2 = await connectDraw('tTel2');
    await T2.emitWithAck('room:join', { code, nickname: 'Uma' });
    const socks = [T1, T2];
    r = await T1.emitWithAck('draw:start', { mode: 'telephone', poolType: 'everything', difficulty: 'everything', drawSeconds: 60 });
    check(!r.ok && /at least 3/.test(r.error), `telephone: needs three players, and says so (${r.error})`);
    const T3 = await connectDraw('tTel3');
    await T3.emitWithAck('room:join', { code, nickname: 'Vic' });
    socks.push(T3);
    const firstViews = socks.map((s) => nextMatching(s, 'tel:state', (v) => v.phase === 'pick'));
    r = await T1.emitWithAck('draw:start', { mode: 'telephone', poolType: 'everything', difficulty: 'everything', drawSeconds: 60 });
    check(r.ok, `telephone: three players start a game${r.ok ? '' : ` (${r.error})`}`);
    if (!r.ok) throw new Error('telephone did not start');
    const picks = await Promise.all(firstViews);
    // Up to three each; the fixture's small pool has fewer to go round -- derived, not restated.
    const each = Math.min(3, Math.floor(SEEDED_NAMES.length / 3));
    check(picks.every((v) => v.task?.kind === 'pick' && v.task.choices.length === each), `telephone: everyone gets choices to start a chain from (${each} each from a pool of ${SEEDED_NAMES.length})`);
    const allChoices = picks.flatMap((v) => v.task.choices.map((c) => c.name));
    check(new Set(allChoices).size === allChoices.length, 'telephone: nobody is offered a character anyone else is');
    check(!(await T1.emitWithAck('draw:say', { text: 'hello' })).ok, "telephone: the classic game's events do nothing here");
    // Everyone picks their first; the draw step follows at once.
    const drawViews = socks.map((s) => nextMatching(s, 'tel:state', (v) => v.phase === 'draw'));
    for (const s of socks) await s.emitWithAck('tel:pick', { index: 0 });
    const draws = await Promise.all(drawViews);
    const started = picks.map((v) => v.task.choices[0].name);
    // Seat i draws chain i-1: the character the previous seat picked.
    check(draws.every((v, i) => v.task?.kind === 'draw' && v.task.prompt === started[(i + 2) % 3]), 'telephone: each draws the character the seat before them picked');
    // The leak: in play, each player was only ever sent their own pick and the one name passed to them.
    const leaks = socks.map((s, i) => {
      const seen = s.received.filter((e) => e.event === 'tel:state').map((e) => e.json).join(' ');
      return started.filter((name, j) => j !== i && j !== (i + 2) % 3 && seen.includes(JSON.stringify(name).slice(1, -1)));
    }).flat();
    check(leaks.length === 0, `telephone: nobody is sent a chain they are not working on${leaks.length ? `: ${leaks.join(', ')}` : ''}`);
    // A stroke each, then hand in; then the guesses.
    T1.emit('tel:stroke', { id: 'a1', color: '#e21b3c', size: 8, points: [[0.1, 0.1], [0.6, 0.6]] });
    T1.emit('tel:stroke', { id: 'a2', kind: 'fill', color: '#ffd60a', points: [[0.5, 0.2]] });
    await wait(100);
    const guessViews = socks.map((s) => nextMatching(s, 'tel:state', (v) => v.phase === 'guess'));
    for (const s of socks) await s.emitWithAck('tel:submit', {});
    const guesses = await Promise.all(guessViews);
    // Tia drew alone; her drawing (a line and a fill) goes on, at the guess step, to one guesser.
    const withDrawing = guesses.filter((v) => v.task?.drawing?.length === 2);
    check(withDrawing.length === 1, "telephone: Tia's drawing, fill and all, reaches exactly one guesser");
    // ...and to nobody before then: no stroke relayed, no view carrying her line while she drew it.
    const beforeGuess = (sock) => {
      const i = sock.received.findIndex((e) => e.event === 'tel:state' && JSON.parse(e.json).phase === 'guess');
      return sock.received.slice(0, i < 0 ? undefined : i);
    };
    check([T2, T3].every((sock) => !beforeGuess(sock).some((e) => e.event === 'draw:stroke' || e.json.includes('[0.6,0.6]'))),
      'telephone: a drawing is not relayed while it is made');
    const replayViews = socks.map((s) => nextMatching(s, 'tel:state', (v) => v.phase === 'replay'));
    await T1.emitWithAck('tel:submit', { text: 'a red line' });
    await T2.emitWithAck('tel:submit', { text: '' });
    await T3.emitWithAck('tel:submit', { text: started[0] });
    const replays = await Promise.all(replayViews);
    check(replays.every((v) => v.replay?.chain === 0 && v.replay.entries.length === 1 && v.replay.madeIt === null), 'telephone: the replay starts at the first card of the first chain, the ending kept back');
    check(!(await T2.emitWithAck('tel:next', {})).ok, 'telephone: only the host moves the replay on');
    for (let i = 0; i < 12; i++) await T1.emitWithAck('tel:next', {});
    await wait(150);
    const albumView = T2.received.filter((e) => e.event === 'tel:state').map((e) => JSON.parse(e.json)).pop();
    check(albumView.phase === 'over' && albumView.album?.length === 3 && albumView.album.every((c) => c.entries.length === 3),
      'telephone: then the album -- every chain, start, drawing and guess');
    const roomAfter = T1.received.filter((e) => e.event === 'room:state').map((e) => JSON.parse(e.json)).pop();
    check(roomAfter.status === 'finished', 'telephone: the room is finished, so the host can rematch or change settings');
    const again = nextMatching(T2, 'tel:state', (v) => v.phase === 'pick');
    r = await T1.emitWithAck('draw:rematch', {});
    check(r.ok && !!(await Promise.race([again, wait(2000).then(() => null)])), 'telephone: a rematch is another Telephone game');
    T1.close(); T2.close(); T3.close();
  }

  // ---- Draw: the host removes a player ----------------------------------------------------------
  // Someone who walks away keeps their seat, and every turn of theirs runs a full clock with nobody
  // drawing. Mid-game a removal is a departure: the turn ends if it was theirs, and below two
  // players the game ends. The removed browser is told -- and then hears nothing more, because a
  // view arriving after it reached the start screen would put it straight back into the game.
  console.log('\n# draw — the host removes a player');
  {
    const K1 = await connectDraw('kHost'); // the host, and the first to draw
    res = await K1.emitWithAck('room:create', { nickname: 'Hana' });
    const kCode = res.state.code;
    const K2 = await connectDraw('kDev');
    const K3 = await connectDraw('kGus');
    await K2.emitWithAck('room:join', { code: kCode, nickname: 'Dev' });
    await K3.emitWithAck('room:join', { code: kCode, nickname: 'Gus' });

    // Drawing has the same remembered opt-outs as guessing (shared/pickers.js serves both).
    const drawList = (await K1.emitWithAck('setup:categoryLists', { category: 'TestToons' })).lists[0].id;
    check(!(await K2.emitWithAck('setup:keepOff', { listIds: [drawList] })).ok, 'draw: a non-host cannot re-apply remembered lists');
    res = await K1.emitWithAck('setup:keepOff', { listIds: [drawList] });
    check(res.ok && res.off[0] === drawList && (await K1.emitWithAck('setup:categoryLists', { category: 'TestToons' })).lists[0].playing === false,
      'draw: the host\'s remembered lists go back off in a new room');
    await K1.emitWithAck('setup:setLists', { listIds: [drawList], playing: true }); // the game below deals from it

    check(!(await K2.emitWithAck('room:kick', { playerId: pub('kGus') })).ok, 'draw kick: a non-host cannot remove anyone');
    check(!(await K1.emitWithAck('room:kick', { playerId: pub('kHost') })).ok, 'draw kick: the host cannot remove themselves');
    check(!(await K1.emitWithAck('room:kick', { playerId: pub('kNobody') })).ok, 'draw kick: only someone in the room can be removed');

    // In the lobby: out, told, and free to come back -- a removal is not a ban.
    let kicked = nextEvent(K3, 'room:kicked');
    let roster = nextMatching(K1, 'room:state', (s) => s.players.length === 2);
    res = await K1.emitWithAck('room:kick', { playerId: pub('kGus') });
    check(res.ok, 'draw kick: the host removes a player from the lobby');
    check(typeof (await kicked).reason === 'string', 'draw kick: the removed player is told why');
    check(!(await roster).players.some((p) => p.playerId === pub('kGus')), 'draw kick: the roster drops them');
    res = await K3.emitWithAck('room:join', { code: kCode, nickname: 'Gus' });
    check(res.ok && res.state.players.length === 3, 'draw kick: a removed player can join the lobby again');

    // Hana draws first; both others guess it, and Dev is choosing next.
    const hanaChoosing = nextMatching(K1, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
    res = await K1.emitWithAck('draw:start', { poolType: 'everything', difficulty: 'everything', rounds: 1, drawSeconds: 60 });
    check(res.ok, 'draw kick: a three-player game starts');
    const kAnswer = (await hanaChoosing).choices[0].name;
    const gusSeesDrawing = nextMatching(K3, 'draw:state', (v) => v.phase === 'drawing');
    await K1.emitWithAck('draw:choose', { index: 0 });
    await gusSeesDrawing;
    const devChoosing = nextMatching(K2, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
    // Matched by who: the ack comes before the broadcast, so Dev's own may still be on its way.
    const secondGot = nextMatching(K1, 'draw:correct', (e) => e.playerId === pub('kGus'));
    await K2.emitWithAck('draw:say', { text: kAnswer });
    await K3.emitWithAck('draw:say', { text: kAnswer });
    check((await secondGot).nth === 2, 'draw kick: the second to get it is counted second, a step up the climb');
    await devChoosing;

    // The player whose turn it is: the turn ends, the board keeps their score, the next one draws.
    kicked = nextEvent(K2, 'room:kicked');
    const devLeftReveal = nextMatching(K3, 'draw:state', (v) => v.phase === 'reveal');
    const gusChoosing = nextMatching(K3, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
    const devMark = K2.received.length;
    res = await K1.emitWithAck('room:kick', { playerId: pub('kDev') });
    check(res.ok, 'draw kick: the host removes the player who is choosing');
    await kicked;
    const devReveal = await devLeftReveal;
    check(devReveal.lastTurn?.reason === 'drawer-left', 'draw kick: removing the drawer ends their turn');
    const devRow = devReveal.players.find((p) => p.playerId === pub('kDev'));
    check(devRow?.left === true && devRow.score > 0, 'draw kick: the board keeps their score, marked as left');
    check((await gusChoosing).drawer.playerId === pub('kGus'), 'draw kick: the turn passes to the next player');

    // Down to one: the game ends for the host, and the one removed is not shown the results.
    kicked = nextEvent(K3, 'room:kicked');
    const kOver = nextEvent(K1, 'draw:over');
    const gusMark = K3.received.length;
    res = await K1.emitWithAck('room:kick', { playerId: pub('kGus') });
    check(res.ok, 'draw kick: the host removes the next drawer too');
    await kicked;
    const kFinal = await kOver;
    check(kFinal.standings.length === 3 && kFinal.standings.filter((s) => s.left).length === 2, 'draw kick: with one player left the game ends, standings keeping everyone');
    await wait(150);
    // Everything each removed browser was sent from the moment it was removed: the notice, and no
    // game view or results. (The leave path had the same hole: a leaver was sent one more view.)
    for (const [who, sock, mark] of [['Dev', K2, devMark], ['Gus', K3, gusMark]]) {
      const after = sock.received.slice(mark).map((e) => e.event);
      check(after.includes('room:kicked') && !after.some((e) => e === 'draw:state' || e === 'draw:over' || e === 'room:state'),
        `draw kick: ${who} heard nothing more of the room after removal (${after.join(', ')})`);
    }
    K1.close(); K2.close(); K3.close();
  }

  // ---- Draw: a whole party, not eight -------------------------------------------------------
  // The guessing games keep the core's 8; a drawing room takes far more, and still has a ceiling.
  // Twelve over sockets, then a game started with all of them in it.
  console.log('\n# draw — a big room');
  {
    const host = await connectDraw('bigHost');
    res = await host.emitWithAck('room:create', { nickname: 'Host' });
    const bigCode = res.state.code;
    const cap = res.state.maxPlayers;
    check(cap > 8, `draw: a drawing room publishes a ceiling above eight (${cap})`);
    const guests = [];
    for (let i = 1; i < 12; i++) {
      const g = await connectDraw(`bigGuest${i}`);
      guests.push(g);
      res = await g.emitWithAck('room:join', { code: bigCode, nickname: `Guest ${i}` });
      if (!res.ok) break;
    }
    check(res.ok && res.state.players.length === 12, `draw: twelve players in one room (${res.state?.players?.length ?? res.error})`);
    const firstView = nextEvent(guests[10], 'draw:state');
    res = await host.emitWithAck('draw:start', { poolType: 'everything', difficulty: 'everything', rounds: 1, drawSeconds: 60 });
    check(res.ok, 'draw: a twelve-player game starts');
    check((await firstView).players.length === 12, 'draw: and everyone is on the board');
    host.close(); for (const g of guests) g.close();
  }

  // ---- Draw: a guesser gives up -------------------------------------------------------------
  console.log('\n# draw — giving up on a drawing');
  {
    const G1 = await connectDraw('gHost'); // the host, and the drawer
    let res = await G1.emitWithAck('room:create', { nickname: 'Gia' });
    const code = res.state.code;
    const G2 = await connectDraw('gTwo');
    await G2.emitWithAck('room:join', { code, nickname: 'Gus' });
    const G3 = await connectDraw('gThree');
    await G3.emitWithAck('room:join', { code, nickname: 'Gwen' });
    const choosing = nextMatching(G1, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
    await G1.emitWithAck('draw:start', { poolType: 'everything', difficulty: 'everything', rounds: 1, drawSeconds: 60 });
    await choosing;
    const drawing = nextMatching(G1, 'draw:state', (v) => v.phase === 'drawing');
    await G1.emitWithAck('draw:choose', { index: 0 });
    const answer = (await drawing).character.name;

    check(!(await G1.emitWithAck('draw:giveup', {})).ok, 'give up: the drawer cannot give up on their own drawing');
    const told = nextEvent(G3, 'draw:gaveup');
    const g2Knows = nextMatching(G2, 'draw:state', (v) => v.gaveUpIt);
    res = await G2.emitWithAck('draw:giveup', {});
    const g2View = await g2Knows;
    check(res.ok && g2View.character?.name === answer, 'give up: the guesser who gives up is shown the answer');
    check((await told).playerId === pub('gTwo'), 'give up: the room is told who gave up');
    check(!(await G2.emitWithAck('draw:giveup', {})).ok, 'give up: ...once');
    check(g2View.phase === 'drawing', 'give up: with someone still guessing, the turn goes on');

    // Gwen is still guessing: nothing she has been sent may name the answer.
    const leaked = G3.received.filter((e) => e.json.includes(JSON.stringify(answer).slice(1, -1)));
    check(leaked.length === 0, `give up: nobody still guessing is sent the answer (${leaked.map((e) => e.event).join(', ')})`);

    const ended = nextMatching(G1, 'draw:state', (v) => v.phase === 'reveal');
    await G3.emitWithAck('draw:giveup', {});
    const reveal = (await ended).lastTurn;
    check(reveal?.reason === 'given-up' && reveal.gaveUp.length === 2, 'give up: once nobody is left guessing, the turn ends early, and says who gave up');
    G1.close(); G2.close(); G3.close();
  }

  C2.close(); D.close();
  await wait(50);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL WEB CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
