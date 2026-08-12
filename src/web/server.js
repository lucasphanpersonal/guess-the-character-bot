// Guess the Character -- web app server.
//
// The second frontend, alongside the Discord bot (src/discord). Both import their game state
// and content from the SAME shared core (src/core) -- see docs/mobile-app-plan.md#architecture.
//
// Stage 1 (current): socket.io rooms. Phones create/join a room by code, see a live roster,
// and reclaim their seat on reconnect. No character dealing or turn loop yet -- those are
// later stages that will build a core `Game` from a room's roster.

const http = require('http');
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
  rerollOne: (listIds, excludeNames, difficulty) =>
    characterLists.getRandomCharacterExcluding(listIds, [...excludeNames], difficulty),
  recordReject: (characterId, playerId) => characterLists.recordReroll(characterId, playerId),
};

function resolvePool({ poolType, category }) {
  if (poolType === 'category' && category) {
    return { listIds: characterLists.getEnabledListsByCategory(WEB_SCOPE, category).map((l) => l.id), label: category };
  }
  if (poolType === 'random') {
    const cat = characterLists.getRandomCategory(WEB_SCOPE);
    if (!cat) return { listIds: [], label: 'nothing enabled' };
    return { listIds: characterLists.getEnabledListsByCategory(WEB_SCOPE, cat).map((l) => l.id), label: `🎲 ${cat}` };
  }
  // Default: everything enabled in this scope.
  return { listIds: characterLists.getEnabledLists(WEB_SCOPE).map((l) => l.id), label: 'Everything' };
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

  start(room, { poolType = 'random', category = null, difficulty = characterLists.DEFAULT_DIFFICULTY } = {}) {
    const { listIds, label } = resolvePool({ poolType, category });
    if (!listIds.length) return { ok: false, error: 'That selection has no playable lists.' };
    const n = room.players.size;
    const available = characterLists.countDistinctCharacters(listIds, difficulty);
    if (available < n) {
      return { ok: false, error: `${label} has only ${available} characters at this difficulty; need ${n}.` };
    }
    const characters = characterLists.getRandomCharacters(listIds, n, [], difficulty);
    if (characters.length < n) return { ok: false, error: 'Could not deal enough distinct characters.' };

    room.game = gameSetup.createSetup({
      order: [...room.order],
      guildId: WEB_SCOPE,
      listIds,
      difficulty,
      characters,
    });
    room.poolLabel = label;
    return { ok: true, label };
  },

  view: (game, viewerId, names) => gameSetup.buildView(game, viewerId, names),
  reroll: (game, viewerId) =>
    gameSetup.applyReroll(game, viewerId, {
      content,
      listIds: game.lobby.listIds,
      difficulty: game.lobby.difficulty,
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

const server = http.createServer((req, res) => {
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
});

const io = new Server(server); // same-origin; serves its browser client at /socket.io/socket.io.js
attachSockets(io, { registry, setup });

// Every non-internal IPv4 address, so the startup log can print a URL a phone on the same
// Wi-Fi can actually reach -- localhost is only reachable from this machine.
function lanUrls() {
  const urls = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${PORT}`);
    }
  }
  return urls;
}

if (require.main === module) {
  // Bind to 0.0.0.0 explicitly so other devices on the LAN (phones) can connect, not just
  // this machine. Node defaults to this, but stating it makes the intent obvious.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[web] Guess the Character (sharing core with the Discord bot). Scope: ${WEB_SCOPE}`);
    console.log(`[web]   on this machine:  http://localhost:${PORT}`);
    for (const url of lanUrls()) {
      console.log(`[web]   on your phone:    ${url}   (same Wi-Fi)`);
    }
    console.log('[web] If a phone can\'t connect, allow Node.js through Windows Firewall on Private networks.');
  });
}

module.exports = { server, io, registry };
