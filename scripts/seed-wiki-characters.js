// Builds (or tops up) a character list from a franchise's own MediaWiki, with artwork.
//
//   node scripts/seed-wiki-characters.js <guildId> --wiki=slaythespire.wiki.gg \
//     --list="Slay the Spire" --category="Video Games" \
//     --categories="Character,Bosses,Elites,Monsters,NPC" --dry-run
//
// The other fetchers fill artwork for characters that are ALREADY in the database. This one
// creates the characters too, for a game the bulk seeders never covered -- Wikidata only lists
// characters notable enough for their own item, which for most games is nobody.
//
// Works against any MediaWiki with an open api.php (Fandom and wiki.gg both qualify), so the
// same command serves the next favourite game. It is idempotent: existing characters are left
// alone, so re-running only adds what is missing and backfills images that are still null.
//
// Two filters keep a category listing from becoming junk characters:
//   - Index pages are dropped. A wiki category almost always contains a page named after itself
//     ("Monsters" inside Category:Monsters), and those are navigation, not characters.
//   - Pages with no usable image are still added, because a name-only character is a supported
//     reveal -- but they are reported separately so the result can be judged.

require('dotenv').config();

const db = require('../src/core/db/connection');
const { createList, getListByName, addCharacter, setCharacterImage, getCharacters } = require('../src/core/db/characterLists');
const { imageIsTrustworthy } = require('../src/core/util/characterImages');

const UA = 'guess-the-character-bot/1.0 (character list build; contact via repo)';
const PAUSE_MS = 150;

const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const wiki = flag('wiki');
const listName = flag('list');
const category = flag('category', 'Video Games');
const wikiCategories = flag('categories', 'Characters').split(',').map((s) => s.trim()).filter(Boolean);
// Some wikis list the roster but carry no art (a sequel's pages are often stubs); --image-wiki
// lets a second wiki supply artwork for whatever the first one could not.
const imageWiki = flag('image-wiki');
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

if (!guildId || !wiki || !listName) {
  console.error(
    'Usage: node scripts/seed-wiki-characters.js <guildId> --wiki=<host> --list="<list name>"\n' +
      '       [--category="Video Games"] [--categories="A,B,C"] [--image-wiki=<host>] [--dry-run] [--verbose]'
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiOn(host, params) {
  const url = new URL(`https://${host}/api.php`);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
const api = (params) => apiOn(wiki, params);

// Main-namespace members of a category, following continuation.
async function categoryMembers(cat) {
  const out = [];
  let cont;
  do {
    const d = await api({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${cat}`,
      cmlimit: '500',
      cmnamespace: '0',
      ...(cont ? { cmcontinue: cont } : {}),
    });
    out.push(...(d.query?.categorymembers || []).map((m) => m.title));
    cont = d.continue?.cmcontinue;
    await sleep(PAUSE_MS);
  } while (cont);
  return out;
}

const normFile = (s) =>
  String(s).toLowerCase().replace(/\.(png|jpe?g|gif|webp|svg)$/, '').replace(/^file:/, '').replace(/[^a-z0-9]+/g, '');
// Titles like "The Champ" are filed as "Champ.png" about as often as "TheChamp.png", so both
// spellings are tried before giving up.
const titleKeys = (t) => {
  const base = normFile(t);
  const noArticle = normFile(String(t).replace(/^(the|a|an)\s+/i, ''));
  return base === noArticle ? [base] : [base, noArticle];
};

/**
 * The page's own image, tried two ways because wikis differ in what their API exposes.
 *
 * `pageimages` is the good path -- the wiki itself nominating a page's representative image --
 * but it is an extension, and wiki.gg does not run it. There, `prop=images` lists every file on
 * the page (icons, buffs, map markers, card art) and the character's own art is the one NAMED
 * after the page: Hexaghost -> Hexaghost.png. That naming is the wiki filing an image against a
 * character, which is the same claim pageimages makes and the same claim the trust rule relies
 * on -- so it is a port of the rule to a different API, not a new heuristic.
 *
 * `prop=images` batches are kept small: imlimit applies across the WHOLE query rather than per
 * page, so a large batch silently returns nothing for the later titles.
 */
async function imagesFor(titles, host = wiki) {
  const found = new Map();
  const call = (params) => apiOn(host, params);

  for (let i = 0; i < titles.length; i += 40) {
    const d = await call({ action: 'query', titles: titles.slice(i, i + 40).join('|'), prop: 'pageimages', piprop: 'original', pilimit: '50' });
    for (const p of Object.values(d.query?.pages || {})) if (p.original?.source) found.set(p.title, p.original.source);
    await sleep(PAUSE_MS);
  }

  const remaining = titles.filter((t) => !found.has(t));
  for (let i = 0; i < remaining.length; i += 3) {
    const batch = remaining.slice(i, i + 3);
    const d = await call({ action: 'query', titles: batch.join('|'), prop: 'images', imlimit: '500' });
    const wanted = [];
    for (const p of Object.values(d.query?.pages || {})) {
      if (p.missing !== undefined || !p.images?.length) continue;
      const keys = titleKeys(p.title);
      const files = p.images.map((x) => x.title);
      const hit =
        files.find((f) => keys.includes(normFile(f))) ||
        files.find((f) => keys.some((k) => k.length > 3 && normFile(f).includes(k)));
      if (hit) wanted.push({ title: p.title, file: hit });
    }
    // Resolve the chosen File: pages to real URLs.
    if (wanted.length) {
      const info = await call({ action: 'query', titles: wanted.map((w) => w.file).join('|'), prop: 'imageinfo', iiprop: 'url' });
      const urlByFile = new Map(Object.values(info.query?.pages || {}).map((p) => [p.title, p.imageinfo?.[0]?.url]));
      for (const w of wanted) {
        const url = urlByFile.get(w.file);
        if (url) found.set(w.title, url);
      }
    }
    await sleep(PAUSE_MS);
  }
  return found;
}

async function main() {
  // Gather, dropping the navigation pages a category carries alongside its real members.
  const indexTitles = new Set(wikiCategories.map((c) => c.toLowerCase()));
  const titles = new Set();
  for (const cat of wikiCategories) {
    const members = await categoryMembers(cat);
    const kept = members.filter((t) => !indexTitles.has(t.toLowerCase()));
    console.log(`  ${cat}: ${members.length} page(s), ${kept.length} after dropping index pages`);
    for (const t of kept) titles.add(t);
  }
  const all = [...titles].sort();
  console.log(`\n${all.length} distinct character page(s) from ${wiki}\n`);

  let images = await imagesFor(all);
  if (imageWiki) {
    const missing = all.filter((t) => !images.has(t));
    if (missing.length) {
      console.log(`  ${missing.length} without art here; asking ${imageWiki}`);
      for (const [t, u] of await imagesFor(missing, imageWiki)) images.set(t, u);
    }
  }
  console.log(`  resolved artwork for ${images.size}/${all.length}
`);

  // The list is created only if it does not exist; an existing one is topped up in place, so a
  // hand-curated list keeps whatever was added by hand.
  let list = getListByName(guildId, listName);
  if (!list) {
    if (dryRun) {
      console.log(`(dry run) would create list "${listName}" in ${category}`);
    } else {
      const id = createList(guildId, listName, 'wiki-seed', category, { enabled: true });
      list = getListByName(guildId, listName);
      console.log(`created list "${listName}" (#${id}) in ${category}, enabled`);
    }
  } else {
    console.log(`topping up existing list "${list.name}" (#${list.id}, ${list.category})`);
  }

  const existing = new Map((list ? getCharacters(list.id) : []).map((c) => [c.name.toLowerCase(), c]));
  const stats = { added: 0, withImage: 0, noImage: 0, backfilled: 0, alreadyThere: 0, rejected: 0 };

  for (const title of all) {
    const image = images.get(title) || null;
    const trusted = image && imageIsTrustworthy(category, image) ? image : null;
    if (image && !trusted) stats.rejected++;

    const have = existing.get(title.toLowerCase());
    if (have) {
      stats.alreadyThere++;
      // Backfill artwork onto a character that was added by hand without one.
      if (!have.image_url && trusted) {
        stats.backfilled++;
        if (!dryRun) setCharacterImage(list.id, have.name, trusted);
        if (verbose) console.log(`  ~ ${title} — image backfilled`);
      }
      continue;
    }

    stats.added++;
    if (trusted) stats.withImage++;
    else stats.noImage++;
    if (verbose || !trusted) console.log(`  + ${title}${trusted ? '' : '  (no image)'}`);
    if (!dryRun && list) addCharacter(list.id, title, 'wiki-seed', trusted);
  }

  console.log('\n--- summary ---');
  console.log(`  pages considered:  ${all.length}`);
  console.log(`  already in list:   ${stats.alreadyThere}  (of which ${stats.backfilled} had artwork backfilled)`);
  console.log(`  added:             ${stats.added}  (${stats.withImage} with artwork, ${stats.noImage} name-only)`);
  console.log(`  images rejected:   ${stats.rejected}  (failed the trust rule)`);
  if (dryRun) console.log('  written:           0  (dry run)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
