// Integration check for the web socket layer: `npm run check:web-socket`.
//
// Boots the real web server on an ephemeral port and drives socket.io clients through the
// stage 1 lifecycle (rooms/membership/reconnect) and the stage 2 lifecycle (deal characters,
// reroll, confirm, ready). Kept OUT of `npm test` on purpose: the unit suite is network-free
// (see README) and this binds a localhost port and seeds a throwaway DB. The room and setup
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
    r = await S.emitWithAck('room:kick', { playerId: 'pKickHost' });
    check(!r.ok, 'kick: a non-host cannot remove anyone');
    r = await H.emitWithAck('room:kick', { playerId: 'pKickHost' });
    check(!r.ok, 'kick: the host cannot remove themselves');

    const kicked = nextEvent(S, 'room:kicked');
    const backToLobby = nextMatching(H, 'room:state', (st) => st.status === 'lobby');
    r = await H.emitWithAck('room:kick', { playerId: 'pKickStuck' });
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
    check(game.currentPlayerId === 'pPauseA', 'pause: the first turn belongs to the host');

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
    check(game.currentPlayerId === 'pPauseB', 'pause: the turn is handed to a non-host');
    Q.disconnect();
    await wait(150);
    check(game.pausedForDisconnect === true, 'pause: the new guesser dropping freezes the clock');
    await P2.emitWithAck('room:kick', { playerId: 'pPauseB' });
    await wait(150);
    check(game.currentPlayerId !== 'pPauseB', 'pause: removing the paused guesser advances the turn');
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

    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { pPickHost: { id: aang.id } } });
    check(!r.ok, 'host-picks: a pick for the host themselves is refused');
    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { pPickX: { id: aang.id }, pPickY: { name: 'aang' } } });
    check(!r.ok && /Xia/.test(r.error) && /Yuri/.test(r.error), 'host-picks: two spellings of one character are refused, naming both players');

    const playerEvents = { X: [], Y: [] };
    X.onAny((ev) => playerEvents.X.push(ev));
    Y.onAny((ev) => playerEvents.Y.push(ev));
    const hostEvents = [];
    H.onAny((ev) => hostEvents.push(ev));

    const hostSetup = nextMatching(H, 'host:state', (v) => v.phase === 'setup');
    const xSetup = nextEvent(X, 'setup:state');
    r = await H.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { pPickX: { id: aang.id }, pPickY: { name: 'Grandma Jean' } } });
    check(r.ok, 'host-picks: deal starts with one listed pick and one typed name');
    const hv = await hostSetup;
    check(hv.players.length === 2 && !hv.players.some((p) => p.playerId === 'pPickHost'), 'host-picks: the host is not dealt in');
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
    const first = hp.current.playerId === 'pPickX' ? X : Y;
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
      const own = JSON.stringify(finalOf(id)).slice(1, -1);
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
  const guesserId = guesser === W ? 'dW' : 'dX';
  const rulerId = guesser === W ? 'dX' : 'dW';
  const rulerView = guesser === W ? xView : wView;
  const guesserView = guesser === W ? wView : xView;
  const answer = rulerView.board.find((b) => b.playerId === guesserId).character.name;
  const rulerAnswer = guesserView.board.find((b) => b.playerId === rulerId).character.name;
  check(guesserView.board.find((b) => b.isMe).character === null, "the guesser's own card is face down");
  check(guesserView.buttons && guesserView.buttons.gotIt === false, 'a computer has no got-it button, only typing');

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
    r = await DH.emitWithAck('setup:start', { poolType: 'everything', difficulty: 'everything', hostPicks: true, picks: { dPick1: { name: 'Grandma Jean' } } });
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
  const drawCode = res.state.code;
  const Q = await connectDraw('rQ');
  res = await Q.emitWithAck('room:join', { code: drawCode, nickname: 'Quinn' });
  check(res.ok, 'a second player joins');
  const deskSock = await connectDesk('dZ');
  res = await deskSock.emitWithAck('room:join', { code: drawCode, nickname: 'Z' });
  check(!res.ok && /Draw the Character/.test(res.error), 'the guessing game cannot join a drawing room');
  deskSock.close();

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
  check(qView.mask && qView.mask.length === drawAnswer.length && !qView.mask.includes(drawAnswer[0] + drawAnswer[1]), 'the guesser sees blanks the length of the name');

  // Strokes: passed on when they are what the client could make, dropped when not.
  const strokeArrives = nextEvent(Q, 'draw:stroke');
  P.emit('draw:stroke', { id: 's1', color: '#e21b3c', size: 8, points: [[0.1, 0.1], [0.2, 0.25]] });
  const relayed = await strokeArrives;
  check(relayed.id === 's1' && relayed.points.length === 2, "the drawer's stroke reaches the guesser");
  P.emit('draw:stroke', { id: 's2', color: 'url(javascript:alert(1))', size: 8, points: [[0.3, 0.3]] });
  P.emit('draw:stroke', { id: 's3', color: '#e21b3c', size: 8, points: [[5, -2]] });
  Q.emit('draw:stroke', { id: 's4', color: '#e21b3c', size: 8, points: [[0.5, 0.5]] });
  await wait(150);
  check(!Q.received.some((e) => e.event === 'draw:stroke' && /"s[234]"/.test(e.json)), 'a bad colour, an off-canvas point and a non-drawer\'s stroke are all dropped');
  const reconnecting = await connectDraw('rQ');
  const caughtUp = nextEvent(reconnecting, 'draw:canvas');
  await reconnecting.emitWithAck('room:join', { code: drawCode, nickname: 'Quinn' });
  check((await caughtUp).strokes.length === 1, 'a reconnecting browser gets the picture so far');
  reconnecting.close();

  res = await Q.emitWithAck('draw:say', { text: 'Definitely Nobody' });
  check(res.ok && res.verdict === 'wrong', 'a wrong guess is wrong, and shown');
  const typoDraw = drawAnswer.slice(0, -1) + (drawAnswer.endsWith('x') ? 'y' : 'x');
  res = await Q.emitWithAck('draw:say', { text: typoDraw });
  check(res.ok && res.verdict === 'close', 'a typo is close -- told only to the guesser');
  check(!P.received.some((e) => e.json.includes(typoDraw)), 'the drawer never sees a close guess');

  const qGotIt = nextEvent(Q, 'draw:correct');
  const reveal1 = nextMatching(P, 'draw:state', (v) => v.phase === 'reveal');
  res = await Q.emitWithAck('draw:say', { text: drawAnswer.toUpperCase() });
  check(res.ok && res.verdict === 'correct' && res.points > 0, 'the right name scores');
  await qGotIt;
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
  check(second.drawer.playerId === 'rQ', 'after the reveal, the next player draws');
  const pDrawing2 = nextMatching(P, 'draw:state', (v) => v.phase === 'drawing');
  await Q.emitWithAck('draw:choose', { index: 0 });
  await pDrawing2;
  const drawOver = nextEvent(P, 'draw:over');
  await P.emitWithAck('draw:say', { text: second.choices[0].name });
  const final = await drawOver;
  check(final.standings.length === 2 && final.standings.every((s) => s.score > 0), 'after everyone has drawn once, the game ends with scores');

  const drawPage = await httpGet('/draw/');
  check(drawPage.status === 200 && drawPage.type.includes('text/html'), 'GET /draw/ serves the drawing client');
  check((await httpGet('/shared/theme.css')).type.includes('css'), 'GET /shared/theme.css serves the common look');
  check((await httpGet('/shared/common.js')).type.includes('javascript'), 'GET /shared/common.js serves the common helpers');
  P.close(); Q.close();

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

    check(!(await K2.emitWithAck('room:kick', { playerId: 'kGus' })).ok, 'draw kick: a non-host cannot remove anyone');
    check(!(await K1.emitWithAck('room:kick', { playerId: 'kHost' })).ok, 'draw kick: the host cannot remove themselves');
    check(!(await K1.emitWithAck('room:kick', { playerId: 'kNobody' })).ok, 'draw kick: only someone in the room can be removed');

    // In the lobby: out, told, and free to come back -- a removal is not a ban.
    let kicked = nextEvent(K3, 'room:kicked');
    let roster = nextMatching(K1, 'room:state', (s) => s.players.length === 2);
    res = await K1.emitWithAck('room:kick', { playerId: 'kGus' });
    check(res.ok, 'draw kick: the host removes a player from the lobby');
    check(typeof (await kicked).reason === 'string', 'draw kick: the removed player is told why');
    check(!(await roster).players.some((p) => p.playerId === 'kGus'), 'draw kick: the roster drops them');
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
    await K2.emitWithAck('draw:say', { text: kAnswer });
    await K3.emitWithAck('draw:say', { text: kAnswer });
    await devChoosing;

    // The player whose turn it is: the turn ends, the board keeps their score, the next one draws.
    kicked = nextEvent(K2, 'room:kicked');
    const devLeftReveal = nextMatching(K3, 'draw:state', (v) => v.phase === 'reveal');
    const gusChoosing = nextMatching(K3, 'draw:state', (v) => v.phase === 'choosing' && v.isDrawer);
    const devMark = K2.received.length;
    res = await K1.emitWithAck('room:kick', { playerId: 'kDev' });
    check(res.ok, 'draw kick: the host removes the player who is choosing');
    await kicked;
    const devReveal = await devLeftReveal;
    check(devReveal.lastTurn?.reason === 'drawer-left', 'draw kick: removing the drawer ends their turn');
    const devRow = devReveal.players.find((p) => p.playerId === 'kDev');
    check(devRow?.left === true && devRow.score > 0, 'draw kick: the board keeps their score, marked as left');
    check((await gusChoosing).drawer.playerId === 'kGus', 'draw kick: the turn passes to the next player');

    // Down to one: the game ends for the host, and the one removed is not shown the results.
    kicked = nextEvent(K3, 'room:kicked');
    const kOver = nextEvent(K1, 'draw:over');
    const gusMark = K3.received.length;
    res = await K1.emitWithAck('room:kick', { playerId: 'kGus' });
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

  C2.close(); D.close();
  await wait(50);
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nALL WEB CHECKS PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
