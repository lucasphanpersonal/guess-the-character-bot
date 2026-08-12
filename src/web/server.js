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
const { Server } = require('socket.io');

// --- Shared core: the exact same modules the Discord bot uses -----------------------------
const GameManager = require('../core/game/GameManager');
const { listCategoriesWithCounts } = require('../core/db/characterLists');
const { TurnRotationMode } = require('../core/game/roundMode');

// --- Web-only: transport + room membership ------------------------------------------------
const { RoomRegistry } = require('./rooms');
const { attachSockets } = require('./socket');

const PORT = process.env.WEB_PORT || 4180;
// The core's content queries are scoped by an id (a Discord guild id, historically). A web
// party has no guild, so it needs its own scope. Per-room/account scoping is a later decision
// (see "Identity and leaderboard scope" in the plan).
const WEB_SCOPE = process.env.WEB_SCOPE || 'web';
const PUBLIC_DIR = path.join(__dirname, 'public');

const registry = new RoomRegistry();

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
      return sendJson(res, 200, { scope: WEB_SCOPE, categories: listCategoriesWithCounts(WEB_SCOPE) });
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
attachSockets(io, registry);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[web] Guess the Character on http://localhost:${PORT}`);
    console.log(`[web] Sharing core with the Discord bot. Scope: ${WEB_SCOPE}`);
  });
}

module.exports = { server, io, registry };
