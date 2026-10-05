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

// The server fetches these URLs from the machine it runs on, and people can set them (/list image,
// the DM image button) -- so it must never be steered at that machine or its network.
function onlyPublicAddressesAreFetchable() {
  for (const url of [
    'http://127.0.0.1/x', 'http://localhost:4180/', 'http://192.168.1.1/', 'http://10.0.0.5/a.png',
    'http://172.20.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://0.0.0.0/', 'http://[::1]/',
    'http://[fe80::1]/', 'http://[::ffff:10.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://2130706433/', 'ftp://x/y',
  ]) {
    assert.equal(cache.isPublicUrl(url), false, url);
  }
  for (const url of ['https://upload.wikimedia.org/a.png', 'https://s4.anilist.co/x.jpg', 'http://[::ffff:8.8.8.8]/']) {
    assert.equal(cache.isPublicUrl(url), true, url);
  }
}

// Swaps in a fake fetch for one test, recording every URL asked for.
async function withFetch(respond, run) {
  const real = globalThis.fetch;
  const asked = [];
  // Follows redirects itself when asked to, as the real fetch does -- otherwise a test of "every
  // hop is checked" would pass for code that never looks past the first.
  const fake = async (url, opts = {}) => {
    asked.push(String(url));
    const res = await respond(String(url), asked.length);
    const location = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (location && opts.redirect !== 'manual' && asked.length < 10) return fake(new URL(location, url).toString(), opts);
    return res;
  };
  globalThis.fetch = fake;
  try {
    return await run(asked);
  } finally {
    globalThis.fetch = real;
  }
}

async function aPrivateAddressIsNeverRequested() {
  await withFetch(() => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }), async (asked) => {
    assert.equal(await cache.get('http://127.0.0.1:4180/api/health'), null);
    assert.equal(await cache.get('http://192.168.1.1/admin'), null);
    assert.deepEqual(asked, [], 'no request was made at all');
  });
}

async function aRedirectToAPrivateAddressStopsThere() {
  // Public at first sight, then sent home. Every hop is checked, not just the first.
  await withFetch(
    () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret.png' } }),
    async (asked) => {
      assert.equal(await cache.get('https://93.184.216.34/start.png'), null);
      assert.deepEqual(asked, ['https://93.184.216.34/start.png'], 'the private hop was never requested');
    }
  );
}

async function svgIsNeverStoredButOtherArtIs() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
  await withFetch(
    (url) =>
      url.endsWith('.svg')
        ? new Response(svg, { status: 200, headers: { 'content-type': 'image/svg+xml' } })
        : new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { 'content-type': 'image/png' } }),
    async () => {
      assert.equal(await cache.get('https://93.184.216.34/evil.svg'), null, 'an SVG is not cached (so /img redirects instead)');
      const png = await cache.get('https://93.184.216.34/fine.png');
      assert.equal(png?.contentType, 'image/png', 'ordinary art still is');
      assert.ok(!fs.readdirSync(cache.CACHE_DIR).some((f) => f.endsWith('.svg')), 'no .svg on disk');
    }
  );
}

module.exports = {
  'only public http(s) addresses are fetchable': onlyPublicAddressesAreFetchable,
  'a private address is never requested': aPrivateAddressIsNeverRequested,
  'a redirect to a private address stops there': aRedirectToAPrivateAddressStopsThere,
  'an SVG is never stored, but other art is': svgIsNeverStoredButOtherArtIs,
  'the cache key is the URL, not the character': theKeyIsTheUrlNotTheCharacter,
  'non-http urls are never fetched': nonHttpUrlsAreNeverFetched,
  'characters with a database row are proxied': charactersWithARowAreProxied,
  'freeform characters keep their upstream url': freeformCharactersKeepTheirUrl,
  'characters with no art stay null': charactersWithNoArtStayNull,
  'init is safe and reports size': initIsSafeAndReportsSize,
};
