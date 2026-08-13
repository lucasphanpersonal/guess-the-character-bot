// Guess the Character -- web app server.
//
// The second frontend, alongside the Discord bot (src/discord). Both import their game state
// and content from the SAME shared core (src/core) -- see docs/mobile-app-plan.md#architecture.
//
// Stage 1 (current): socket.io rooms. Phones create/join a room by code, see a live roster,
// and reclaim their seat on reconnect. No character dealing or turn loop yet -- those are
// later stages that will build a core `Game` from a room's roster.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

// --- Shared core: the exact same modules the Discord bot uses -----------------------------
const GameManager = require('../core/game/GameManager');
const characterLists = require('../core/db/characterLists');
const { TurnRotationMode } = require('../core/game/roundMode');

// --- Web-only: transport + room membership + setup ----------------------------------------
const { RoomRegistry } = require('./rooms');
const { attachSockets } = require('./socket');
const gameSetup = require('./gameSetup');

const PORT = process.env.WEB_PORT || 4180;
// The core's content queries are scoped by an id (a Discord guild id, historically). A web
// party has no guild. If WEB_SCOPE isn't set, auto-pick the richest existing scope so a phone
// test can deal real characters straight away rather than from an empty 'web' scope. Per-room
// or per-account scoping is a later decision (see "Identity and leaderboard scope" in the plan).
function resolveScope() {
  if (process.env.WEB_SCOPE) return process.env.WEB_SCOPE;
  try {
    const top = characterLists.guildsRankedByContent()[0];
    if (top && top.enabledLists > 0) return top.guildId;
  } catch {
    /* fall through to the empty default */
  }
  return 'web';
}
const WEB_SCOPE = resolveScope();
const PUBLIC_DIR = path.join(__dirname, 'public');

const registry = new RoomRegistry();

// --- Setup service: resolves a pool, deals, and drives confirm/reroll via the core ---------
// Injected into the socket layer so socket.js stays transport-only (no DB access there).
const content = {
  demoteThreshold: characterLists.REROLL_DEMOTE_THRESHOLD,
  rerollOne: (listIds, excludeNames, difficulty, opts) =>
    characterLists.getRandomCharacterExcluding(listIds, [...excludeNames], difficulty, opts),
  recordReject: (characterId, playerId) => characterLists.recordReroll(characterId, playerId),
};

// `excluded` is the room's own opt-outs, applied on top of the shared selection rather than
// written back into it -- see the note on Room.excludedListIds.
function resolvePool({ poolType, category, excluded = new Set() }) {
  const keep = (lists) => lists.map((l) => l.id).filter((id) => !excluded.has(id));
  if (poolType === 'category' && category) {
    return { listIds: keep(characterLists.getEnabledListsByCategory(WEB_SCOPE, category)), label: category };
  }
  if (poolType === 'random') {
    const cat = characterLists.getRandomCategory(WEB_SCOPE);
    if (!cat) return { listIds: [], label: 'nothing enabled' };
    return { listIds: keep(characterLists.getEnabledListsByCategory(WEB_SCOPE, cat)), label: `Random: ${cat}` };
  }
  // Default: everything enabled in this scope.
  return { listIds: keep(characterLists.getEnabledLists(WEB_SCOPE)), label: 'Everything' };
}

const setup = {
  options() {
    const categories = characterLists
      .listCategoriesWithEnabledCounts(WEB_SCOPE)
      .filter((c) => c.enabled > 0)
      .map((c) => ({ category: c.category, enabled: c.enabled }));
    const difficulties = Object.entries(characterLists.DIFFICULTIES).map(([key, d]) => ({
      key,
      label: d.label,
      blurb: d.blurb,
    }));
    return { categories, difficulties, defaultDifficulty: characterLists.DEFAULT_DIFFICULTY };
  },

  // preferImages is OFF unless the host asks for it: restricting the draw to characters that
  // happen to have artwork silently shrinks the pool and biases it toward the better-documented
  // franchises, which is a real change to what the game deals. It is the host's call, not a default.
  start(room, { poolType = 'random', category = null, difficulty = characterLists.DEFAULT_DIFFICULTY, turnSeconds, preferImages = false } = {}) {
    const { listIds, label } = resolvePool({ poolType, category, excluded: room.excludedListIds });
    if (!listIds.length) return { ok: false, error: 'That selection has no playable lists.' };
    const n = room.players.size;
    const available = characterLists.countDistinctCharacters(listIds, difficulty);
    if (available < n) {
      return { ok: false, error: `${label} has only ${available} characters at this difficulty; need ${n}.` };
    }
    const characters = characterLists.getRandomCharacters(listIds, n, [], difficulty, { preferImages: !!preferImages });
    if (characters.length < n) return { ok: false, error: 'Could not deal enough distinct characters.' };

    const clampedTurnSeconds = gameSetup.clampTurnSeconds(turnSeconds);
    room.game = gameSetup.createSetup({
      order: [...room.order],
      guildId: WEB_SCOPE,
      listIds,
      difficulty,
      characters,
      preferImages: !!preferImages,
      ...(clampedTurnSeconds !== undefined ? { turnSeconds: clampedTurnSeconds } : {}),
    });
    room.poolLabel = label;
    // Remembered so "Rematch (same settings)" can re-deal without the host reconfiguring.
    room.lastSetup = { poolType, category, difficulty, turnSeconds: room.game.turnSeconds, preferImages: !!preferImages };
    return { ok: true, label };
  },

  // Curation for this room only. Shows the lists already in the shared playable selection and
  // lets the host drop some for THIS game; it never writes to the shared `enabled` column, so a
  // party can't reshape what the Discord server gets dealt.
  listsInCategory(category, room) {
    return characterLists
      .listsForFilter(WEB_SCOPE, category)
      .filter((l) => l.enabled === 1)
      .map((l) => ({ id: l.id, name: l.name, count: l.character_count, playing: !room.excludedListIds.has(l.id) }));
  },
  // The id arrives from a client, so it is NOT trusted -- it must name a list that really is in
  // this scope's playable selection before the room may act on it.
  toggleList(listId, room) {
    const [list] = characterLists.getListsByIds([listId]);
    if (!list || list.guild_id !== WEB_SCOPE || list.enabled !== 1) return { ok: false, error: 'Unknown list.' };
    if (room.excludedListIds.has(list.id)) room.excludedListIds.delete(list.id);
    else room.excludedListIds.add(list.id);
    return { ok: true, playing: !room.excludedListIds.has(list.id) };
  },

  view: (game, viewerId, names) => gameSetup.buildView(game, viewerId, names),
  reroll: (game, viewerId) =>
    gameSetup.applyReroll(game, viewerId, {
      content,
      listIds: game.lobby.listIds,
      difficulty: game.lobby.difficulty,
      preferImages: game.lobby.preferImages,
    }),
  confirm: (game, viewerId) => gameSetup.applyConfirm(game, viewerId),
  unlock: (game, viewerId) => gameSetup.applyUnlock(game, viewerId),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

// Serves a file from PUBLIC_DIR, guarding against path traversal outside it.
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Proves the core content pipeline is reachable, read-only. Empty for a fresh WEB_SCOPE
  // until list curation exists under it -- the point is that the query PATH works.
  if (url.pathname === '/api/categories') {
    try {
      return sendJson(res, 200, { scope: WEB_SCOPE, categories: characterLists.listCategoriesWithCounts(WEB_SCOPE) });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // QR of a join URL, so a phone can scan instead of typing the room code. Returns SVG so it
  // scales crisply; the lobby points an <img> straight at it.
  if (url.pathname === '/api/qr') {
    const text = url.searchParams.get('text') || '';
    if (!text || text.length > 512) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad qr text');
    }
    return require('qrcode')
      .toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(svg);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('qr failed');
      });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: registry.rooms.size,
      lobbies: GameManager.allLobbies().length,
      roundModes: ['turn-rotation'],
      turnRotationWired: typeof TurnRotationMode === 'function',
    });
  }

  return serveStatic(res, url.pathname);
}

// Mobile browsers only expose motion/orientation sensors (the tilt-to-win gestures) over a
// secure context. So with WEB_HTTPS=1 (npm run web:secure) we serve HTTPS on WEB_HTTPS_PORT
// ALONGSIDE the plain HTTP server -- not instead of it. That way the familiar http://<ip>:4180
// keeps working (game plays fully via the tap fallback) and https://<ip>:4443 is there when you
// want tilt. Serving https-only on the main port made a mistyped http:// URL fail silently.
const USE_HTTPS = process.env.WEB_HTTPS === '1' || process.env.WEB_HTTPS === 'true';
const HTTPS_PORT = Number(process.env.WEB_HTTPS_PORT || 4443);

function lanIPv4s() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  return ips;
}

// A cached self-signed cert for localhost + every LAN IPv4, so the same cert works whether a
// phone hits the machine by IP or the machine hits itself by localhost.
function devTlsOptions() {
  const dir = path.join(__dirname, '..', '..', 'data');
  const keyPath = path.join(dir, 'dev-tls.key');
  const certPath = path.join(dir, 'dev-tls.cert');
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
  } catch {
    /* regenerate below */
  }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIPv4s().map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'gtc-dev' }], { days: 3650, keySize: 2048, altNames });
  try {
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
  } catch {
    /* non-fatal: run with an in-memory cert */
  }
  return { key: pems.private, cert: pems.cert };
}

// Plain HTTP is always served (what phones have been using for stages 1-3). HTTPS is additive.
const server = http.createServer(requestHandler);
const io = new Server(server); // serves its browser client at /socket.io/socket.io.js
attachSockets(io, { registry, setup });

// The same io handles both servers, so players on http and https share rooms.
const httpsServer = USE_HTTPS ? https.createServer(devTlsOptions(), requestHandler) : null;
if (httpsServer) io.attach(httpsServer);

if (require.main === module) {
  // Bind to 0.0.0.0 explicitly so other devices on the LAN (phones) can connect, not just
  // this machine. Node defaults to this, but stating it makes the intent obvious.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[web] Guess the Character (sharing core with the Discord bot). Scope: ${WEB_SCOPE}`);
    console.log(`[web]   HTTP  (game, tap fallback):`);
    console.log(`[web]     on this machine:  http://localhost:${PORT}`);
    for (const ip of lanIPv4s()) console.log(`[web]     on your phone:    http://${ip}:${PORT}   (same Wi-Fi)`);
    if (!USE_HTTPS) console.log('[web] For tilt-to-win on phones, run `npm run web:secure` (adds HTTPS).');
  });
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[web]   HTTPS (needed for tilt/motion on phones):`);
      for (const ip of lanIPv4s()) console.log(`[web]     on your phone:    https://${ip}:${HTTPS_PORT}   (accept the cert warning once)`);
    });
  }
  console.log('[web] If a phone can\'t connect, allow Node.js through Windows Firewall on Private networks.');
}

module.exports = { server, io, registry };
