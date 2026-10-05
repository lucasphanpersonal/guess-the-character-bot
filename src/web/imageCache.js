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
const net = require('net');
const dns = require('dns').promises;

const CACHE_DIR = process.env.WEB_IMAGE_CACHE_DIR || path.join(__dirname, '..', '..', 'data', 'image-cache');
const MAX_BYTES = 8 * 1024 * 1024; // a character portrait is tens of KB; this is a sanity bound
const FETCH_TIMEOUT_MS = 20000;

// Content types worth storing, mapped to the extension the filename carries. The extension is
// how the content type survives a restart without a sidecar metadata file.
//
// No SVG. An SVG is a document that can carry script, and this cache serves from the site's own
// origin -- so one stored SVG opened at /img/<id> would run as the site, able to read every
// player's seat secret. Image URLs come from more people than the seed scripts (Discord's
// /list image, the DM image button), so the cache cannot assume they are benign. An SVG is
// simply not cached: /img sends the browser to it upstream, where an <img> renders it inertly.
const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
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
      const [hash, ext] = file.split('.');
      // Only types still served -- an .svg cached before SVG was refused is left unserved.
      if (hash && TYPE_BY_EXT[ext]) index.set(hash, file);
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
  if (!isPublicUrl(url)) return null;
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

// --- where the server is willing to fetch from ------------------------------------------------
//
// The server fetches these URLs ITSELF, from the machine it runs on. A URL naming localhost, the
// router, or anything else on the home network would have it make requests there on a stranger's
// behalf. So only public addresses: checked on the name as written, again on what DNS resolves it
// to, and again on every redirect, since a public URL can redirect anywhere.

function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast+reserved
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** Whether an IP address is one this server must not fetch from. */
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return privateV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    // An IPv4 address wearing IPv6 (mapped, or NAT64) is judged as the IPv4 address it is. URL
    // parsing writes the mapped form in hex -- [::ffff:10.0.0.1] arrives as ::ffff:a00:1 -- so
    // both spellings are read.
    const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return privateV4(dotted[1]);
    const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true; // not an address at all: refuse rather than guess
}

/** http(s), and not a literal private address. DNS is checked separately, at fetch time. */
function isPublicUrl(url) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return false;
  return net.isIP(host) ? !isPrivateAddress(host) : true;
}

async function resolvesPublic(url) {
  if (!isPublicUrl(url)) return false;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return true;
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

const MAX_REDIRECTS = 5;

async function fetchAndStore(url, hash) {
  try {
    // Redirects by hand, so every hop passes the same check as the first.
    let res;
    let at = url;
    for (let hop = 0; ; hop++) {
      if (hop > MAX_REDIRECTS || !(await resolvesPublic(at))) return null;
      res = await fetch(at, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': 'guess-the-character/1.0 (self-hosted party game; caches upstream art)' },
      });
      const next = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (!next) break;
      at = new URL(next, at).toString();
    }
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

module.exports = { init, get, stats, keyFor, isPublicUrl, isPrivateAddress, CACHE_DIR };
