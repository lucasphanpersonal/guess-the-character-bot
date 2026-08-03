// Fills in missing character artwork from each show's own Fandom wiki.
//
//   node scripts/fetch-fandom-images.js <guildId> --category=Cartoon --dry-run
//   node scripts/fetch-fandom-images.js <guildId> --category=Cartoon --lists=5
//
// Cartoon and Video Games arrive almost entirely without art, because Wikidata only carries
// freely-licensed images and there are none for most drawn characters. A general image
// search would fill the gap and reintroduce exactly the problem src/util/characterImages.js
// was written to stop: "Guts", "Link" and "Zero" pull the wrong franchise, and nothing rules
// out fan art or a meme.
//
// Searching the FRANCHISE'S OWN WIKI makes that structural rather than a heuristic:
// naruto.fandom.com cannot return a Zelda character, however the query is spelled. It is the
// same move the bot already makes with per-title lists and per-list fame.
//
// Nothing is overwritten -- only characters with no image at all are touched -- and every
// candidate still has to pass the trust rule before it is stored.

const db = require('../src/db/connection');
const { setCharacterImage } = require('../src/db/characterLists');
const { imageIsTrustworthy } = require('../src/util/characterImages');

const UA = 'guess-the-character-bot/1.0 (character artwork backfill; https://github.com/lucasphanpersonal/guess-the-character-bot)';
const PAUSE_MS = 180; // polite serial pacing; Fandom is somebody else's server

const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes('--dry-run');
const category = flag('category', 'Cartoon');
const listLimit = Number(flag('lists', 0)) || Infinity;
const verbose = args.includes('--verbose');

if (!guildId) {
  console.error('Usage: node scripts/fetch-fandom-images.js <guildId> [--category=Cartoon] [--dry-run] [--lists=N] [--verbose] [--undo] [--prune]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Comparable form for titles and names: case, punctuation and the articles that wikis add or
// drop freely ("The Simpsons" vs "Simpsons") are all noise here.
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

/**
 * Lead images that are about the SHOW rather than the character -- worse than nothing, since
 * a title card names the show to someone whose whole job is to not know it.
 *
 * Measured over the first 760 cartoon matches, this is a 3-in-760 problem: a logo, a title
 * card and a group shot. Tempting to fix it structurally instead, by refusing any page whose
 * title is the show's own name -- but 8 of the 10 characters named after their series got the
 * RIGHT image that way (BoJack Horseman, Chowder, Kim Possible), so that rule would have
 * thrown away four good images for every bad one it caught. The narrow filter wins.
 *
 * Matched against the filename with separators normalised: "Steven_Universe_logo.png" has no
 * word boundary before "logo", so \blogo\b silently misses the exact case that motivated it.
 */
const JUNK_IMAGE = /(\blogo\b|\bwordmark\b|favicon|wiki background|placeholder|\bno image\b|noimage|question mark|default avatar|title card|group shot|groupshot|cast photo|characters slide|\bposter\b)/i;

const looksLikeJunk = (url) => JUNK_IMAGE.test(decodeURIComponent(url).replace(/[-_]+/g, ' '));

const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Subdomains worth trying for a title, most specific first.
 *
 * Fandom retired every wiki-search endpoint it used to publish (Wikis/ByString and the whole
 * SearchApiController now 404), so discovery is guesswork -- but a Fandom subdomain is just
 * the title with the punctuation taken out, which makes it good guesswork.
 */
function wikiCandidates(listName) {
  const beforeColon = listName.split(/[:–—]/)[0];
  const noArticle = listName.replace(/^\s*(the|a|an)\s+/i, '');
  const out = [listName, noArticle, beforeColon, beforeColon.replace(/^\s*(the|a|an)\s+/i, '')]
    .map(slug)
    .filter((s) => s.length >= 3);
  return [...new Set(out)];
}

/**
 * The Fandom wiki for a title: guess a subdomain, then make it prove itself.
 *
 * The proof is the point. "Justice League" resolves to a real wiki that turns out to be the
 * DC Extended Universe, and lifting character art out of the wrong franchise is exactly the
 * failure this whole approach exists to make impossible -- so the wiki's own advertised name
 * has to look like the show before anything is read from it.
 */
async function findWiki(listName) {
  const want = norm(listName);
  for (const candidate of wikiCandidates(listName)) {
    const domain = `${candidate}.fandom.com`;
    let sitename;
    try {
      const data = await getJson(`https://${domain}/api.php?action=query&format=json&meta=siteinfo&siprop=general`);
      sitename = data?.query?.general?.sitename;
    } catch {
      continue; // no wiki on that subdomain
    } finally {
      await sleep(PAUSE_MS);
    }
    if (!sitename) continue;

    const bare = norm(sitename).replace(/\bwiki(pedia)?\b/g, '').trim();
    let score = 0;
    if (bare === want) score = 3;
    else if (bare.startsWith(want) || want.startsWith(bare)) score = 2;
    else if (bare.includes(want) || want.includes(bare)) score = 1;
    if (score > 0) return { domain, name: sitename, score };
    if (verbose) console.log(`      (skipped ${domain} — it calls itself "${sitename}")`);
  }
  return null;
}

// The page's lead image -- which on a character page is the infobox portrait.
async function leadImage(domain, title) {
  const url =
    `https://${domain}/api.php?action=query&format=json&redirects=1&prop=pageimages` +
    `&piprop=original|thumbnail&pithumbsize=600&titles=${encodeURIComponent(title)}`;
  const data = await getJson(url);
  const pages = data?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  const image = page.original?.source ?? page.thumbnail?.source ?? null;
  return image ? { image, title: page.title } : null;
}

async function searchTitle(domain, name) {
  const url =
    `https://${domain}/api.php?action=query&format=json&list=search` +
    `&srsearch=${encodeURIComponent(name)}&srlimit=3&srnamespace=0`;
  try {
    const data = await getJson(url);
    return (data?.query?.search ?? []).map((r) => r.title);
  } catch {
    return [];
  }
}

/**
 * A title only counts if it is recognisably the character asked for.
 *
 * The search fallback happily answers "Ed" with "List of Ed, Edd n Eddy characters", and an
 * image lifted off a cast list is a picture of somebody else.
 */
function titleMatches(characterName, pageTitle, { viaSearch = false } = {}) {
  const want = norm(characterName);
  const got = norm(pageTitle);
  if (!want || !got) return false;
  if (want === got) return true;
  if (/\b(list|gallery|category|episode|season|characters)\b/.test(got)) return false;

  // The page being MORE specific than the name is always safe: asking for "Palpatine" and
  // landing on "Sheev Palpatine" is the wiki using a fuller name for the same person.
  if (got.includes(want)) return true;

  // The page being LESS specific is only safe when the wiki itself said so. A redirect from
  // "Darth Maul" to "Maul" is the wiki asserting they are the same character; a search result
  // of "Grand Moff" for "Grand Moff Tarkin" is a rank, not a person, and the portrait on it
  // belongs to whoever the article happened to lead with.
  return !viaSearch && want.includes(got);
}

async function imageFor(domain, name) {
  let hit = await leadImage(domain, name).catch(() => null);
  if (hit && titleMatches(name, hit.title)) return { ...hit, via: 'direct' };

  await sleep(PAUSE_MS);
  for (const title of await searchTitle(domain, name)) {
    if (!titleMatches(name, title, { viaSearch: true })) continue;
    await sleep(PAUSE_MS);
    const found = await leadImage(domain, title).catch(() => null);
    if (found) return { ...found, via: 'search' };
  }
  return null;
}

/**
 * Clears every image this script has ever added, and nothing else.
 *
 * Backfilling 1,600 rows off a heuristic deserves a way back. It is safe precisely because
 * the script only ever fills a NULL: anything on a Fandom domain got there this way, so
 * removing them restores exactly the state before the run.
 */
function undo() {
  const rows = db
    .prepare(
      `SELECT ch.id FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
        WHERE cl.guild_id = ? AND COALESCE(cl.category, 'Uncategorised') = ?
          AND (ch.image_url LIKE '%wikia.nocookie.net%' OR ch.image_url LIKE '%fandom.com%')`
    )
    .all(guildId, category);

  console.log(`${category}: ${rows.length} Fandom image(s) to clear${dryRun ? '  [DRY RUN]' : ''}`);
  if (dryRun || !rows.length) return;

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  const run = db.transaction((ids) => { for (const id of ids) clear.run(id); });
  run(rows.map((r) => r.id));
  console.log(`Cleared ${rows.length}.`);
}

/**
 * Re-applies the junk filter to images already stored.
 *
 * The filter learns from what it lets through, and a run that has already written hundreds of
 * good rows should not have to be thrown away and repeated to drop a handful of bad ones.
 */
function prune() {
  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url AS url, cl.name AS list
         FROM characters ch JOIN character_lists cl ON cl.id = ch.list_id
        WHERE cl.guild_id = ? AND COALESCE(cl.category, 'Uncategorised') = ?
          AND (ch.image_url LIKE '%wikia.nocookie.net%' OR ch.image_url LIKE '%fandom.com%')`
    )
    .all(guildId, category)
    .filter((r) => looksLikeJunk(r.url));

  console.log(`${category}: ${rows.length} stored image(s) fail the junk filter${dryRun ? '  [DRY RUN]' : ''}`);
  for (const r of rows) {
    console.log(`  ${r.name}  [${r.list}]  ->  ${decodeURIComponent(r.url.split('/').slice(-3)[0])}`);
  }
  if (dryRun || !rows.length) return;

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  db.transaction((ids) => { for (const id of ids) clear.run(id); })(rows.map((r) => r.id));
  console.log(`Cleared ${rows.length}. They read as text again, which is the honest state.`);
}

async function main() {
  if (args.includes('--undo')) return undo();
  if (args.includes('--prune')) return prune();

  const lists = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category, cl.enabled,
              COUNT(ch.id) AS missing
         FROM character_lists cl
         JOIN characters ch ON ch.list_id = cl.id
        WHERE cl.guild_id = ? AND COALESCE(cl.category, 'Uncategorised') = ? AND ch.image_url IS NULL
        GROUP BY cl.id
        ORDER BY cl.enabled DESC, cl.popularity IS NULL, cl.popularity DESC`
    )
    .all(guildId, category)
    .slice(0, listLimit);

  const totalMissing = lists.reduce((n, l) => n + l.missing, 0);
  console.log(
    `${category}: ${totalMissing} characters without artwork across ${lists.length} list(s)` +
      `${dryRun ? '  [DRY RUN -- nothing will be written]' : ''}\n`
  );

  const stats = { lists: 0, noWiki: 0, skipped: 0, checked: 0, found: 0, rejected: 0, missed: 0, written: 0 };
  const samples = [];

  for (const list of lists) {
    stats.lists++;
    const wiki = await findWiki(list.name);
    if (!wiki) {
      stats.noWiki++;
      stats.skipped += list.missing;
      console.log(`  ✗ ${list.name} — no matching wiki`);
      continue;
    }
    await sleep(PAUSE_MS);

    const characters = db
      .prepare('SELECT id, name FROM characters WHERE list_id = ? AND image_url IS NULL ORDER BY fame IS NULL, fame DESC')
      .all(list.id);

    let found = 0;
    for (const ch of characters) {
      stats.checked++;
      const hit = await imageFor(wiki.domain, ch.name).catch(() => null);
      await sleep(PAUSE_MS);

      if (!hit) {
        stats.missed++;
        if (verbose) console.log(`      · ${ch.name} — nothing`);
        continue;
      }
      if (looksLikeJunk(hit.image) || !imageIsTrustworthy(list.category, hit.image)) {
        stats.rejected++;
        if (verbose) console.log(`      · ${ch.name} — rejected ${hit.image}`);
        continue;
      }

      stats.found++;
      found++;
      if (samples.length < 25) samples.push({ list: list.name, name: ch.name, title: hit.title, via: hit.via, image: hit.image });
      if (!dryRun) {
        setCharacterImage(list.id, ch.name, hit.image);
        stats.written++;
      }
    }
    console.log(
      `  ${found ? '✓' : '·'} ${list.name} → ${wiki.domain}  ${found}/${characters.length}` +
        `${list.enabled ? '  (in pool)' : ''}`
    );
  }

  console.log('\n--- sample of what was matched ---');
  for (const s of samples) {
    console.log(`  ${s.name}  [${s.list}]`);
    console.log(`      page: ${s.title}  (${s.via})`);
    console.log(`      ${s.image}`);
  }

  const rate = stats.checked ? ((stats.found / stats.checked) * 100).toFixed(1) : '0.0';
  console.log('\n--- summary ---');
  console.log(`  lists:            ${stats.lists}, of which ${stats.noWiki} had no wiki we could find`);
  console.log(`  skipped:          ${stats.skipped}  (characters in those lists -- never asked)`);
  console.log(`  characters asked: ${stats.checked}`);
  console.log(`  artwork found:    ${stats.found}  (${rate}% of those asked)`);
  console.log(`  rejected:         ${stats.rejected}  (junk image, or failed the trust rule)`);
  console.log(`  no match:         ${stats.missed}  (wiki had no usable page)`);
  console.log(dryRun ? '  written:         0  (dry run)' : `  written:         ${stats.written}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
