// Per-client limits for the unauthenticated things a stranger can do in bulk: look up room codes,
// fail to join rooms, create rooms.
//
// Per CLIENT, not per socket. The limits used to live on the socket, and a new socket is free --
// so they bounded nothing for anyone willing to reconnect, and /api/room (plain HTTP, no socket at
// all) answered "does this code exist?" without any limit: 300 lookups took 99ms, and room codes
// are only 32^4. The client is the address Cloudflare reports for the visitor, since behind the
// tunnel every request reaches us from 127.0.0.1.
//
// A request from this machine with no proxy header is local (the tests, the socket check, a
// developer) and is not limited: nothing outside can arrive that way, because the tunnel always
// adds the header.

/** Who is asking, for limiting. null for a local request, which is never limited. */
function clientKey(headers = {}, remoteAddress = '') {
  const first = (v) => String(v || '').split(',')[0].trim();
  const forwarded = first(headers['cf-connecting-ip']) || first(headers['x-forwarded-for']);
  if (forwarded) return forwarded;
  const addr = String(remoteAddress || '');
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') return null;
  return addr || null;
}

/**
 * A fixed-window counter: at most `max` uses per key per `windowMs`.
 *
 * Fixed rather than sliding because the point is bounding bulk abuse, not smoothing a burst --
 * and a party of eight joining from one Wi-Fi in the same second has to sail through.
 */
function createLimiter({ max, windowMs }) {
  const windows = new Map(); // key -> { start, count }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (now - w.start >= windowMs) windows.delete(key);
  }, Math.max(windowMs, 60000));
  sweep.unref?.();

  return {
    /** Spend one use. false when the key has none left in this window; a null key always passes. */
    take(key, now = Date.now()) {
      if (key == null) return true;
      let w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        w = { start: now, count: 0 };
        windows.set(key, w);
      }
      if (w.count >= max) return false;
      w.count++;
      return true;
    },
    /** Whether the key could spend one now, without spending it. */
    allows(key, now = Date.now()) {
      if (key == null) return true;
      const w = windows.get(key);
      return !w || now - w.start >= windowMs || w.count < max;
    },
    reset: () => windows.clear(),
  };
}

module.exports = { clientKey, createLimiter };
