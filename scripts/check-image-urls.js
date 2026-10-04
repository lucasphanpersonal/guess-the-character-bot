// Checks that stored character artwork still resolves, and optionally clears what doesn't.
//
//   node scripts/check-image-urls.js --sample=400            # estimate the rot rate, fast
//   node scripts/check-image-urls.js --host=anilist.co       # one CDN only
//   node scripts/check-image-urls.js --fix                   # full sweep, null the dead ones
//
// Every image in the database is a HOTLINK to somebody else's CDN -- AniList, Fandom, Wikimedia
// Commons, TMDB. None of it has ever been verified, and hotlinks rot silently: a wiki re-uploads
// a file, a CDN path changes, a host starts refusing hotlinks, and the game quietly starts
// dealing broken images. Nothing in the app notices, because a broken <img> just renders as
// nothing on somebody's forehead.
//
// Reported per host, because rot is almost never uniform -- it is one source going bad at once,
// and 68% of the library sits behind a single domain.
//
// `--fix` nulls a dead URL rather than deleting the character: a character with no image is a
// supported, playable state (it reveals as large text), so losing the picture should not lose
// the character. The backfill scripts can then refill it on a later run.

const db = require('../src/compendium/db');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const sample = Number(flag('sample', 0)) || 0;
const hostFilter = flag('host');
// Deliberately low. This walks somebody else's CDN, and a high number is what made Commons
// answer 429 for nearly everything on the first run.
const concurrency = Number(flag('concurrency', 4));
const fix = args.includes('--fix');
const verbose = args.includes('--verbose');

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classifies a URL as 'ok', 'dead', or 'unknown' -- and the three-way split is the whole point.
 *
 * ONLY 404/410 counts as dead. Everything else that isn't a success is 'unknown', because the
 * failure modes that look like rot mostly aren't:
 *
 *   429  the host is rate-limiting US. A first pass at concurrency 12 made Wikimedia Commons
 *        report 60 of 66 "dead" -- every one of them a live image. Treating that as rot and
 *        running --fix would have wiped ~4,600 working photographs.
 *   403  hotlink protection or a UA block: the file exists, we just can't have it this way.
 *   5xx / timeout  the host is unwell right now, which says nothing about the URL.
 *
 * Retried once after a pause, because a transient 429 usually clears; if it still won't answer,
 * it stays 'unknown' and --fix leaves it alone. Deleting on ambiguity is the one outcome this
 * script must never produce.
 */
async function checkUrl(url) {
  const opts = { redirect: 'follow', headers: { 'User-Agent': 'guess-the-character-bot/1.0 (link check)' } };
  const attempt = async () => {
    try {
      const head = await fetch(url, { ...opts, method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (head.ok) return { state: 'ok', status: head.status };
      if (head.status === 404 || head.status === 410) return { state: 'dead', status: head.status };
      // Some CDNs refuse HEAD (405) but serve GET fine, so ask for a single byte before judging.
      const get = await fetch(url, { ...opts, method: 'GET', headers: { ...opts.headers, Range: 'bytes=0-0' }, signal: AbortSignal.timeout(15000) });
      if (get.ok || get.status === 206) return { state: 'ok', status: get.status };
      if (get.status === 404 || get.status === 410) return { state: 'dead', status: get.status };
      return { state: 'unknown', status: get.status };
    } catch (err) {
      return { state: 'unknown', status: err.name === 'TimeoutError' ? 'timeout' : 'error' };
    }
  };

  const first = await attempt();
  if (first.state !== 'unknown') return first;
  await sleep(2000);
  return attempt();
}

async function pool(items, worker, limit) {
  let i = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

async function main() {
  let rows = db
    .prepare("SELECT id, name, image_url AS url FROM characters WHERE image_url IS NOT NULL AND image_url <> ''")
    .all();
  if (hostFilter) rows = rows.filter((r) => hostOf(r.url).includes(hostFilter));
  const total = rows.length;

  // Distinct URLs, because a repeated URL has the same fate and checking it twice only costs
  // somebody else's bandwidth.
  const byUrl = new Map();
  for (const r of rows) {
    if (!byUrl.has(r.url)) byUrl.set(r.url, []);
    byUrl.get(r.url).push(r);
  }
  let urls = [...byUrl.keys()];

  if (sample && sample < urls.length) {
    for (let i = urls.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [urls[i], urls[j]] = [urls[j], urls[i]];
    }
    urls = urls.slice(0, sample);
  }

  console.log(
    `${total} image(s) on ${byUrl.size} distinct URL(s)` +
      (hostFilter ? ` matching "${hostFilter}"` : '') +
      `; checking ${urls.length}${sample ? ' (sample)' : ''} with ${concurrency} in flight\n`
  );

  const stats = new Map(); // host -> { ok, dead, unknown, checked }
  const dead = [];
  const unknown = [];
  let done = 0;

  await pool(
    urls,
    async (url) => {
      const res = await checkUrl(url);
      const h = hostOf(url);
      const s = stats.get(h) || { ok: 0, dead: 0, unknown: 0, checked: 0 };
      s.checked++;
      if (res.state === 'ok') s.ok++;
      else if (res.state === 'dead') {
        s.dead++;
        dead.push({ url, status: res.status, rows: byUrl.get(url) });
        if (verbose) console.log(`  dead ${res.status}  ${url}`);
      } else {
        s.unknown++;
        unknown.push({ url, status: res.status, rows: byUrl.get(url) });
      }
      stats.set(h, s);
      if (++done % 250 === 0) console.log(`  ...${done}/${urls.length}`);
    },
    concurrency
  );

  console.log('\n--- by host ---');
  for (const [h, s] of [...stats.entries()].sort((a, b) => b[1].checked - a[1].checked)) {
    const pct = Math.round((s.ok / s.checked) * 100);
    console.log(
      `  ${h.padEnd(32)} ${String(s.checked).padStart(6)} checked   ${String(pct).padStart(3)}% ok   ` +
        `${String(s.dead).padStart(4)} dead   ${String(s.unknown).padStart(4)} unknown`
    );
  }

  const affected = dead.reduce((n, d) => n + d.rows.length, 0);
  console.log('\n--- summary ---');
  console.log(`  URLs checked:  ${urls.length}`);
  console.log(`  dead URLs:     ${dead.length}  (${affected} character row(s))  -- 404/410 only`);
  console.log(`  unknown:       ${unknown.length}  (rate-limited, blocked or timed out; NOT touched by --fix)`);
  if (unknown.length) {
    const byStatus = {};
    for (const u of unknown) byStatus[u.status] = (byStatus[u.status] || 0) + 1;
    console.log(`    reasons: ${Object.entries(byStatus).map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }
  if (dead.length && !verbose) {
    console.log('  first few:');
    for (const d of dead.slice(0, 10)) console.log(`    ${d.status}  ${d.rows[0].name} — ${d.url}`);
  }

  if (fix && dead.length) {
    const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
    let n = 0;
    for (const d of dead) for (const r of d.rows) n += clear.run(r.id).changes;
    console.log(`\n  cleared ${n} dead image(s); the characters remain and reveal as text until a backfill refills them`);
  } else if (dead.length) {
    console.log('\n  (re-run with --fix to null these out)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
