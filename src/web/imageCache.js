// A read-through disk cache for character artwork.
//
// Every image in the database is a hotlink to somebody else's CDN, and the web app hands those
// URLs straight to phones. Two problems with that at a party:
//
//   - Wikimedia Commons throttles by IP, and measurably so: sampling its URLs returned 429 at
//     concurrency 1, with a browser User-Agent, on requests that succeeded moments later. Eight
//     phones on one home Wi-Fi share a single public IP, so the ~4,600 Commons images (most of
//     Real People) can start failing exactly when the room is busiest. Nothing in the UI reports
//     it -- a broken image is just a blank forehead card.
//   - Four third-party CDNs each get a vote on whether the game works.
//
// Caching moves the fetch server-side: the server pulls an image ONCE, from its own IP, and then
// serves every phone from disk. It is read-through rather than a bulk download because a party
// only ever sees a few dozen characters -- pre-fetching all 39,476 would cost gigabytes to avoid
// a problem that only touches what is actually dealt.
//
// Falling back to the upstream URL on any failure is deliberate: a cache that can break the game
// when it misbehaves is worse than no cache, so the worst case here is exactly today's behaviour.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.WEB_IMAGE_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'image-cache');
const MAX_BYTES = 8 * 1024 * 1024; // a character portrait is tens of KB; this is a sanity bound
const FETCH_TIMEOUT_MS = 20000;

// Content types worth storing, mapped to the extension the filename carries. The extension is
// how the content type survives a restart without a sidecar metadata file.
const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type]));

// hash -> filename. Rebuilt from disk on start so a restart keeps the cache.
const index = new Map();
// hash -> Promise, so N simultaneous requests for one image cause ONE upstream fetch.
const inFlight = new Map();

const keyFor = (url) => crypto.createHash('sha1').update(String(url)).digest('hex');

function init() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    for (const file of fs.readdirSync(CACHE_DIR)) {
      const [hash] = file.split('.');
      if (hash) index.set(hash, file);
    }
  } catch (err) {
    console.warn('[imageCache] disabled:', err.message);
  }
  return index.size;
}

/**
 * The cached file for a URL, fetching it if this is the first ask.
 *
 * The cache key is a hash of the URL, not the character id, so re-pointing a character at new
 * artwork misses the cache naturally instead of serving the old picture forever.
 *
 * @returns {Promise<{path: string, contentType: string}|null>} null when it could not be cached,
 *   which the caller should treat as "redirect upstream" rather than as an error.
 */
async function get(url) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  const hash = keyFor(url);

  const cached = index.get(hash);
  if (cached) {
    const file = path.join(CACHE_DIR, cached);
    if (fs.existsSync(file)) return { path: file, contentType: TYPE_BY_EXT[cached.split('.').pop()] || 'application/octet-stream' };
    index.delete(hash); // deleted underneath us; fall through and refetch
  }

  if (inFlight.has(hash)) return inFlight.get(hash);
  const job = fetchAndStore(url, hash).finally(() => inFlight.delete(hash));
  inFlight.set(hash, job);
  return job;
}

async function fetchAndStore(url, hash) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'guess-the-character/1.0 (self-hosted party game; caches upstream art)' },
    });
    if (!res.ok) return null;

    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) return null; // not an image we understand -- do not store an error page as art

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;

    const file = `${hash}.${ext}`;
    // Write to a temp name and rename, so a crash mid-write can never leave a truncated image
    // that would then be served forever as if it were complete.
    const tmp = path.join(CACHE_DIR, `.${file}.tmp`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, path.join(CACHE_DIR, file));
    index.set(hash, file);
    return { path: path.join(CACHE_DIR, file), contentType: type };
  } catch {
    return null; // upstream down, timeout, DNS -- caller redirects instead
  }
}

const stats = () => ({ files: index.size, dir: CACHE_DIR });

module.exports = { init, get, stats, keyFor, CACHE_DIR };
