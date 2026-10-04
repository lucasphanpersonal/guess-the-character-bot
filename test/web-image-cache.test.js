// The local artwork cache (src/web/imageCache.js) and the URL rewriting that feeds it.
//
// Network-free: the fetching path is exercised by scripts/check-web-socket.js and by hand. What
// is worth pinning down here is the cache KEY and the fallbacks, because those decide whether a
// stale or wrong image can be served, and whether a cache failure can break a game.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WEB_IMAGE_CACHE_DIR =
  process.env.WEB_IMAGE_CACHE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'gtc-imgcache-'));

const { assert } = require('./harness');
const cache = require('../src/web/imageCache');
const { publicCharacter } = require('../src/web/publicCharacter');

function theKeyIsTheUrlNotTheCharacter() {
  // Keying on the character id would serve the OLD picture forever after re-pointing a character
  // at new artwork. Keying on the URL means a changed URL simply misses.
  const a = cache.keyFor('https://example.com/a.png');
  const b = cache.keyFor('https://example.com/b.png');
  assert.notEqual(a, b);
  assert.equal(cache.keyFor('https://example.com/a.png'), a, 'the same URL always keys the same');
}

async function nonHttpUrlsAreNeverFetched() {
  // Guards against a stored value that isn't really a URL turning into a file read or a request.
  assert.equal(await cache.get('file:///etc/passwd'), null);
  assert.equal(await cache.get('javascript:alert(1)'), null);
  assert.equal(await cache.get(''), null);
  assert.equal(await cache.get(null), null);
}

// A character backed by a database row is served through the local proxy; one without a row
// (a hand-picked freeform name) has no id to look up, so it keeps its upstream URL.
function charactersWithARowAreProxied() {
  const proxied = publicCharacter({ name: 'Ironclad', imageUrl: 'https://cdn.example/x.png', id: 42, source: 'Slay the Spire' });
  assert.equal(proxied.imageUrl, '/img/42');
  assert.equal(proxied.name, 'Ironclad');
  assert.equal(proxied.source, 'Slay the Spire');
}

function freeformCharactersKeepTheirUrl() {
  const raw = publicCharacter({ name: 'Inside Joke', imageUrl: 'https://cdn.example/y.png', id: null });
  assert.equal(raw.imageUrl, 'https://cdn.example/y.png');
}

function charactersWithNoArtStayNull() {
  assert.equal(publicCharacter({ name: 'Nobody', imageUrl: null, id: 7 }).imageUrl, null);
  assert.equal(publicCharacter({ name: 'Nobody', id: 7 }).imageUrl, null);
}

function initIsSafeAndReportsSize() {
  const n = cache.init();
  assert.equal(typeof n, 'number');
  const s = cache.stats();
  assert.equal(typeof s.files, 'number');
  assert.ok(s.dir);
}

module.exports = {
  'the cache key is the URL, not the character': theKeyIsTheUrlNotTheCharacter,
  'non-http urls are never fetched': nonHttpUrlsAreNeverFetched,
  'characters with a database row are proxied': charactersWithARowAreProxied,
  'freeform characters keep their upstream url': freeformCharactersKeepTheirUrl,
  'characters with no art stay null': charactersWithNoArtStayNull,
  'init is safe and reports size': initIsSafeAndReportsSize,
};
