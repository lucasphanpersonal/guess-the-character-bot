// Guess the Character -- the web server, and everything its games share.
//
// The second frontend, alongside the Discord bot (src/discord). Both import their game state
// from the shared core (src/core) and their content from the compendium (src/compendium) -- see
// docs/mobile-app-plan.md#architecture.
//
// It hosts the web GAMES and owns what they have in common: the HTTP(S) servers and the one
// socket.io instance, static files, character artwork through a local read-through cache, the
// compendium's browse endpoints, the join QR, and the room registry (one registry, so a room
// code means one room whichever game it is). Each game is a module under this directory that
// brings its own client and its own socket protocol:
//
//   party/   the phone game -- foreheads and tilt. Served at the site root.
//
// What a game needs from the content comes from ./content.js, never from the compendium
// directly, so what the web deals from is decided in one place.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Server } = require('socket.io');

const GameManager = require('../core/game/GameManager');
const characterLists = require('../compendium/characterLists');
const { TurnRotationMode } = require('../core/game/roundMode');

const { RoomRegistry } = require('./rooms');
const { WEB_SCOPE } = require('./content');
const imageCache = require('./imageCache');
const party = require('./party');

const PORT = process.env.WEB_PORT || 4180;
// Party mode owns the site root: it was the only game when the links and QR codes out there were
// made, and the client is unversioned.
const PUBLIC_DIR = party.publicDir;

const registry = new RoomRegistry();

// At module load, not inside the run-as-script guard: the socket check requires this file
// rather than spawning it, and an uninitialised cache silently redirects everything upstream.
const cachedImages = imageCache.init();

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * The origin a client actually reached this server on.
 *
 * req.socket.encrypted only knows about OUR listener, and behind a reverse proxy (the Cloudflare
 * tunnel, say) TLS terminates at the proxy and the hop to us is plain HTTP -- so it reports
 * "http" for a visitor who is browsing https. That mattered: the join QR was built from it and
 * encoded an http:// URL, and browsers refuse motion sensors outside a secure context, so anyone
 * who joined by scanning silently lost tilt controls while anyone who followed a pasted https
 * link kept them.
 *
 * X-Forwarded-Proto/Host are what a proxy sets to describe the original request, so they win
 * when present. Trusting them does not reopen the hole this endpoint was locked down for: the
 * headers describe the request the CLIENT made, and a client cannot set headers on somebody
 * else's request -- so a QR served to a victim still points at whatever host that victim is
 * already talking to.
 */
function originFor(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  const fwdProto = first(req.headers['x-forwarded-proto']).toLowerCase();
  const scheme = fwdProto === 'https' || fwdProto === 'http' ? fwdProto : req.socket.encrypted ? 'https' : 'http';
  const host = first(req.headers['x-forwarded-host']) || first(req.headers.host);
  return `${scheme}://${String(host).replace(/[^\w.:\-\[\]]/g, '')}`;
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

// Serves a file from PUBLIC_DIR, guarding against path traversal outside it.
//
// The client is unversioned -- index.html and app.js keep the same URLs forever -- so without a
// cache header browsers apply their own heuristic and a phone can keep running yesterday's app.js
// against today's server. `no-cache` still allows a 304, so a reload is cheap; it just stops the
// browser deciding on its own that it need not ask.
const NO_CACHE = new Set(['.html', '.js', '.css']);

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  // The separator matters: a bare startsWith would also accept a sibling directory whose name
  // merely BEGINS with "public".
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' };
    if (NO_CACHE.has(ext)) headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // QR of a join URL. Takes a ROOM CODE, not arbitrary text: the earlier version encoded
  // whatever it was given, which turned this host into a free generator of QR codes pointing
  // anywhere -- a phishing code served from a URL the reader has been told to trust. The join
  // URL is now built here from the request's own host, so the code can only ever point back at
  // this server.
  if (url.pathname === '/api/qr') {
    const room = String(url.searchParams.get('room') || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(room)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad room code');
    }
    const target = `${originFor(req)}/?room=${room}`;
    return require('qrcode')
      .toString(target, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then((svg) => {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(svg);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('qr failed');
      });
  }

  // Character artwork, served from the local cache. The id names a database row, so the URL
  // actually fetched is always one we stored -- a client can never point this at an arbitrary
  // host. A miss that cannot be filled redirects upstream, which is exactly the pre-cache
  // behaviour, so the cache can degrade without breaking a game in progress.
  if (url.pathname.startsWith('/img/')) {
    const id = Number(url.pathname.slice(5));
    if (!Number.isInteger(id) || id <= 0) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad image id');
    }
    const row = characterLists.getCharacterById(WEB_SCOPE, id);
    if (!row?.image_url) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('No image');
    }
    return imageCache
      .get(row.image_url)
      .then((hit) => {
        if (!hit) {
          res.writeHead(302, { Location: row.image_url, 'Cache-Control': 'no-store' });
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': hit.contentType, 'Cache-Control': 'public, max-age=604800, immutable' });
        fs.createReadStream(hit.path).pipe(res);
      })
      .catch(() => {
        res.writeHead(302, { Location: row.image_url, 'Cache-Control': 'no-store' });
        res.end();
      });
  }

  // --- compendium: read-only browsing of the whole library ------------------------------
  //
  // Plain HTTP rather than socket events, deliberately: browsing is stateless, has nothing to
  // do with a room, and must never contend with the game traffic on the socket. It is also
  // cacheable, which matters when several phones browse over one tunnel.
  //
  // Everything is paginated and ordered the way the game itself orders things -- lists by
  // popularity, characters by fame -- so the top of a page is the part people recognise.
  if (url.pathname.startsWith('/api/browse/')) {
    const what = url.pathname.slice('/api/browse/'.length);
    const int = (name, fallback, max) => {
      const n = Number(url.searchParams.get(name));
      return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback;
    };
    // Short cache: the library changes only when a seeder or curation runs, and a stale minute
    // costs nothing while re-browsing the same category repeatedly is common.
    const cached = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' });
      res.end(JSON.stringify(body));
    };

    try {
      if (what === 'categories') {
        const counts = characterLists.listCategoriesWithEnabledCounts(WEB_SCOPE);
        return cached({
          categories: counts.map((c) => ({ category: c.category, lists: c.count, playable: c.enabled })),
        });
      }

      if (what === 'lists') {
        const category = url.searchParams.get('category');
        if (!category) return sendJson(res, 400, { error: 'category required' });
        // The whole category in one response: even the largest is ~592 rows of name+counts,
        // which is far cheaper than paging it and lets the client filter as you type.
        const lists = characterLists.listsForFilter(WEB_SCOPE, category).map((l) => ({
          id: l.id,
          name: l.name,
          characters: l.character_count,
          playable: l.enabled === 1,
        }));
        return cached({ category, lists });
      }

      // The host's picker. Across every list in scope, not just the playable ones or the pool
      // the room chose: picking someone is an explicit choice, and the library is what the
      // compendium shows. Ranked by word start then fame, and NOT deduped by name -- the list
      // travels with each result so the host can tell Pokemon's Ditto from Ben 10's.
      if (what === 'search') {
        const q = String(url.searchParams.get('q') || '').trim().slice(0, 60);
        if (q.length < 2) return cached({ query: q, characters: [] });
        const rows = characterLists.searchCharactersInScope(WEB_SCOPE, q, 20);
        return cached({
          query: q,
          characters: rows.map((c) => ({
            id: c.id,
            name: c.name,
            list: c.listName,
            imageUrl: c.image_url ? `/img/${c.id}` : null,
          })),
        });
      }

      if (what === 'characters') {
        const listId = Number(url.searchParams.get('listId'));
        if (!Number.isInteger(listId) || listId <= 0) return sendJson(res, 400, { error: 'listId required' });
        // Scope-checked like every other client-supplied id here.
        const [list] = characterLists.getListsByIds([listId], WEB_SCOPE);
        if (!characterLists.isVisibleTo(list, WEB_SCOPE)) return sendJson(res, 404, { error: 'Unknown list.' });
        const limit = int('limit', 60, 120);
        const offset = int('offset', 0, 100000);
        const rows = characterLists.getCharactersRanked(listId, limit, offset);
        return cached({
          list: { id: list.id, name: list.name, category: list.category, playable: list.enabled === 1 },
          total: characterLists.countCharacters(listId),
          offset,
          characters: rows.map((c) => ({
            id: c.id,
            name: c.name,
            // Through the local cache, same as in-game, so browsing warms it for free.
            imageUrl: c.image_url ? `/img/${c.id}` : null,
          })),
        });
      }
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
    return sendJson(res, 404, { error: 'Unknown browse endpoint.' });
  }

  if (url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      rooms: registry.rooms.size,
      lobbies: GameManager.allLobbies().length,
      roundModes: ['turn-rotation'],
      imageCache: { files: imageCache.stats().files },
      // What the join QR will encode. Handy for confirming through a proxy that it says https:
      // a QR that says http silently disables tilt controls for whoever scans it.
      joinUrlBase: originFor(req),
      turnRotationWired: typeof TurnRotationMode === 'function',
    });
  }

  return serveStatic(res, url.pathname);
}

// Mobile browsers only expose motion/orientation sensors (the tilt-to-win gestures) over a
// secure context, and tilt is now required to play -- so over plain HTTP the client can only
// explain why it cannot deal anyone in. With WEB_HTTPS=1 (npm run web:secure) HTTPS is served on
// WEB_HTTPS_PORT ALONGSIDE the plain HTTP server rather than instead of it: the familiar
// http://<ip>:4180 still answers, and says what is wrong, because serving https-only on the main
// port made a mistyped http:// URL fail silently with nothing on screen at all.
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

// Plain HTTP is always served, so a mistyped http:// URL reaches a page that can explain
// itself rather than nothing at all. HTTPS is additive.
const server = http.createServer(requestHandler);
const io = new Server(server); // serves its browser client at /socket.io/socket.io.js
party.attach(io, { registry });

// The same io handles both servers, so players on http and https share rooms.
const httpsServer = USE_HTTPS ? https.createServer(devTlsOptions(), requestHandler) : null;
if (httpsServer) io.attach(httpsServer);

if (require.main === module) {
  // Bind to 0.0.0.0 explicitly so other devices on the LAN (phones) can connect, not just
  // this machine. Node defaults to this, but stating it makes the intent obvious.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[web] Guess the Character (sharing core with the Discord bot). Compendium scope: ${WEB_SCOPE}`);
    console.log(`[web] Image cache: ${cachedImages} file(s) on disk; artwork is fetched once and served locally.`);
    console.log(`[web]   HTTP  (no tilt -- the client will say so):`);
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
