// How the content scripts ask a web API for something, politely and more than once.
//
// Wikimedia asks every tool for a descriptive User-Agent with a contact point, and four scripts
// each carried their own copy of ours. The retry loop was copied too, twice in one file, while
// another script had none and died on the first hiccup of a run.
//
// Not every fetcher comes through here, and that is deliberate: the Wikidata Query Service's
// backoff (fetch-wikidata-characters) and Fandom's ok / dead / unknown split (fetch-fandom-images)
// are tuned to their APIs, and a destructive flag acts on that split. This is the plain case.

const USER_AGENT =
  'guess-the-character-bot/1.0 (party game; https://github.com/lucasphanpersonal/guess-the-character-bot)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET a URL as JSON, retried: a dropped socket or a 429/5xx partway through a long run is routine.
 * Waits as long as a Retry-After asks, otherwise backs off 2s, 4s, 8s...
 *
 * @param {object} [opts]
 * @param {number} [opts.retries=5]
 * @param {number[]} [opts.definitive=[404, 410]]  statuses that are an answer, not a hiccup:
 *   returned at once rather than retried
 * @returns {Promise<{ok: true, body: any} | {ok: false, status: number} | null>} null when every
 *   attempt failed, which a caller should record as unknown -- never as "nothing there".
 */
async function getJson(url, { retries = 5, definitive = [404, 410], headers = {} } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers } });
      if (res.ok) return { ok: true, body: await res.json() };
      if (definitive.includes(res.status)) return { ok: false, status: res.status };
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < retries) await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
    } catch {
      if (attempt < retries) await sleep(2000 * 2 ** attempt);
    }
  }
  return null;
}

module.exports = { USER_AGENT, sleep, getJson };
