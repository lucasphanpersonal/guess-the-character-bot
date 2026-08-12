// Guess the Character -- web app server (skeleton).
//
// This is the second frontend, alongside the Discord bot (src/discord). Both import their
// game state and content from the SAME shared core (src/core) -- see the boundary note in
// docs/mobile-app-plan.md#architecture and #whats-reusable-from-the-current-codebase.
//
// STATUS: scaffold only. It proves the core/discord/web split works end to end -- the server
// reuses the core DB layer and the core game state with no Discord dependency in sight -- and
// gives `npm run web` something runnable. The real transport (WebSocket rooms, the turn loop
// ported behind core/game/roundMode.js, forehead-mode tilt gestures) is the next stage; see
// the build order in the plan. Dependency-free on purpose for now: Node's built-in http, no
// socket.io yet, so nothing new is installed just to stand up the skeleton.

const http = require('http');
const fs = require('fs');
const path = require('path');

// --- Shared core: the exact same modules the Discord bot uses -----------------------------
// If either of these requires resolved into src/discord, the split would be leaking. They
// don't -- the core knows nothing about either frontend.
const GameManager = require('../core/game/GameManager');
const { listCategoriesWithCounts } = require('../core/db/characterLists');
const { TurnRotationMode } = require('../core/game/roundMode');

const PORT = process.env.WEB_PORT || 4180;

// The core's content queries are scoped by an id (a Discord guild id, historically). A web
// party has no guild, so it needs its own scope for list selection/curation. A single shared
// scope is fine for the skeleton; per-room or per-account scoping is a real decision flagged
// under "Identity and leaderboard scope" in the plan.
const WEB_SCOPE = process.env.WEB_SCOPE || 'web';

const PUBLIC_DIR = path.join(__dirname, 'public');

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendFile(res, file, contentType) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/' ) {
    return sendFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  // Proves the core content pipeline is reachable from the web frontend, read-only. Empty for
  // a fresh WEB_SCOPE until the list-curation UI (or a seed under this scope) exists -- the
  // point here is that the query PATH works, reusing characterLists.js verbatim.
  if (url.pathname === '/api/categories') {
    try {
      return sendJson(res, 200, {
        scope: WEB_SCOPE,
        categories: listCategoriesWithCounts(WEB_SCOPE),
      });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // Proves the shared game-state layer is reachable too: how many rooms (lobbies) are live.
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: GameManager.allLobbies().length,
      roundModes: ['turn-rotation'], // simultaneous mode is planned; the seam is in place
      turnRotationWired: typeof TurnRotationMode === 'function',
    });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Guard so this file can be require()d by a test without binding a port.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[web] Guess the Character web skeleton on http://localhost:${PORT}`);
    console.log(`[web] Sharing core with the Discord bot. Scope: ${WEB_SCOPE}`);
  });
}

module.exports = { server };
