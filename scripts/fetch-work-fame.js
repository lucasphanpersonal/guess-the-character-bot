// Ranks the non-anime lists by how well-known the work itself is: how many people read the
// show's, film's or game's English Wikipedia article over the last twelve months. Writes
// data/seed/work-fame.json; with --apply, also writes those scores into the compendium as each
// list's popularity.
//
// Readers, not article counts. The first version counted how many language Wikipedias cover
// the work, and that is easy to inflate: "Go, Dog. Go!" has articles in 160 Wikipedias -- most
// of them bulk-made stubs in very small ones -- against Breaking Bad's 93, so it topped
// Cartoon. A year of English readers is 31 thousand against 2.9 million.
//
// A list built from several works (a franchise: the Batman games) scores all of them together:
// scored by its best-known one alone, Batman was Arkham Asylum's 266 thousand readers and fell
// from first to ninety-second. A list matched by title search keeps one work, the one most
// Wikipedias cover -- there the candidates are different things that share a name, not parts
// of one. A franchise list also searches its own name, because the works it was built from
// need not include its namesake: the Minecraft list was seven spin-offs, and not Minecraft.
//
// Why: outside Anime and Manga (AniList's own popularity), a list's score was the summed
// sitelinks of its CAST. That ranks a big cast over a famous show -- Glee above Breaking Bad,
// Sesame Street above The Sopranos -- and lists from any other source (the fandom wikis: Avatar:
// The Last Airbender, Ben 10, Bridgerton) had no score at all, so they sorted last, A-Z. The
// work's own readership is one signal for every list, from every source.
//
// How a list finds its work (data/seed/work-overrides.json first: a list given its works by hand,
// for a name too generic to search -- "Persona" is first a term in psychology):
//   seeded from Wikidata   the series ids it was built from (mergeFranchises keeps them): the
//                          best-known of them scores the list. Exact, no guessing.
//   anything else          a title search, kept only when a result's label or alias IS the
//                          list's name and its description fits the category ("television
//                          series" for a show) -- or, failing that, says it is a franchise or
//                          a character, which is what a games list like "Batman" really is.
//
// Classified three ways, as every content tool here must be: scored, not found, or unknown
// (the request failed). Unknown is never treated as not found, and --apply refuses to run while
// any list is unknown: half a category on the new scale and half on the old is worse than either.
// A re-run keeps what it already has and retries only the unknown.
//
//   node scripts/fetch-work-fame.js            # fetch (or finish fetching) and report
//   node scripts/fetch-work-fame.js --apply    # ... then write the scores
//
// Scores are compared only within a category (see backfill-popularity.js), so each category is
// replaced whole: a list with no work found is unranked (sorts last), never left on the old scale.
//
// It also measures every list's REACH: the readers of its single best-known work, for Anime and
// Manga too, on one scale across every category -- which popularity cannot be. Reach is what
// decides which of a character's lists names them (getCharacterOrigin): Luke Skywalker, dealt
// from a Lego game, is from the Star Wars film. The best single work rather than the franchise's
// total, or twenty Star Wars games added up would outweigh the film. Anime and Manga keep
// AniList's popularity for their order; only their reach is written.
//
// A list's reach counts only works of its own kind -- games for a games list. The Wikidata seed
// filed The Force Awakens itself among the Star Wars GAMES, and that list then reached exactly as
// far as the film, so Darth Vader, dealt from a Lego game, was "from Star Wars (Video Games)".

const fs = require('fs');
const path = require('path');
const lists = require('../src/compendium/characterLists');
const { normalizeLoose } = require('../src/compendium/text');
const { mergeFranchises } = require('./seed-wikidata-characters');
const { writeFileAtomic } = require('./lib/writeAtomic');
const { sleep, getJson } = require('./lib/http');

const WBAPI = 'https://www.wikidata.org/w/api.php';
const PAGEVIEWS = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';
// What the scores in the file measure. A file from an older measure is not reused: its numbers
// are on another scale.
const MEASURE = 'enwiki-readers-12-months-summed-namesake-best-of-kind';
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');
const OUT_PATH = path.join(SEED_DIR, 'work-fame.json');
const ENTITY_CHUNK = 50;
const MAX_RETRIES = 5;
const GAP_MS = 120; // between searches: polite, and well under the API's limits

// The categories whose popularity this writes. Anime and Manga keep AniList's; Real People are
// fields ("Actors"), not works, and keep theirs.
const RANKED = new Set(['Television Shows', 'Cartoon', 'Movies', 'Video Games']);
// The categories whose reach it writes: every category made of works.
const REACHED = new Set([...RANKED, 'Anime', 'Manga']);
// What a search result's description must say to be this category's kind of work.
const FITS = {
  'Television Shows': /\b(television|tv|sitcom|series|show|soap opera|telenovela|miniseries|drama|programme|program)\b/i,
  Cartoon: /\b(animated|animation|cartoon|television|tv|series|show)\b/i,
  Movies: /\b(film|movie|motion picture)\b/i,
  'Video Games': /\b(video game|game|games)\b/i,
  Anime: /\b(anime|animated|animation|television|tv|series|film|ova|ona|show|manga)\b/i,
  Manga: /\b(manga|manhwa|manhua|comic|comics|light novel|webtoon|series)\b/i,
};
// Second best: the list is named for a franchise or a character rather than one work.
const FRANCHISE = /\b(franchise|media mix|series|fictional|superhero|supervillain|comic|character|mascot)\b/i;

const key =(category, name) => `${category}<|>${name}`;

// One API call, retried (lib/http). Returns null when it failed -- the caller records that as unknown.
async function api(params) {
  const r = await getJson(`${WBAPI}?${new URLSearchParams({ format: 'json', ...params })}`, { retries: MAX_RETRIES });
  return r?.ok ? r.body : null;
}

// Wikipedia articles only: a work's Commons category or Wikiquote page says nothing about fame.
const OTHER_WIKIS = new Set(['commonswiki', 'specieswiki', 'metawiki', 'mediawikiwiki', 'wikidatawiki', 'sourceswiki', 'wikimaniawiki', 'outreachwiki', 'incubatorwiki', 'foundationwiki']);
const wikipedias = (entity) => Object.keys(entity?.sitelinks ?? {}).filter((k) => /^[a-z_]+wiki$/.test(k) && !OTHER_WIKIS.has(k)).length;

/** qid -> { wikipedias, title (English Wikipedia's, if any), description }, 50 a call. Failed ids are left out. */
async function entityInfo(qids) {
  const out = new Map();
  const ids = [...new Set(qids)];
  for (let i = 0; i < ids.length; i += ENTITY_CHUNK) {
    const body = await api({ action: 'wbgetentities', ids: ids.slice(i, i + ENTITY_CHUNK).join('|'), props: 'sitelinks|descriptions', languages: 'en' });
    for (const [qid, entity] of Object.entries(body?.entities ?? {})) {
      if (!entity.missing) {
        out.set(qid, { wikipedias: wikipedias(entity), title: entity.sitelinks?.enwiki?.title ?? null, description: entity.descriptions?.en?.value ?? '' });
      }
    }
  }
  return out;
}

// The twelve whole months before this one, as the pageviews API wants them.
function lastYear(now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)); // last day of last month
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1));
  const fmt = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}00`;
  return [fmt(start), fmt(end)];
}

/** A year of English Wikipedia readers for one article: a number, 0 for none, null when unknown. */
async function readers(title, [from, to]) {
  const url = `${PAGEVIEWS}/${encodeURIComponent(title.replace(/ /g, '_'))}/monthly/${from}/${to}`;
  const r = await getJson(url, { retries: MAX_RETRIES, definitive: [404] });
  if (r?.ok) return (r.body.items ?? []).reduce((n, i) => n + (i.views || 0), 0);
  if (r?.status === 404) return 0; // the API's "no views recorded", not an error
  return null;
}

/** The works a search finds that ARE this list, best fit first. null when the search failed. */
async function searchWorks(name, category) {
  const body = await api({ action: 'wbsearchentities', search: name, language: 'en', uselang: 'en', type: 'item', limit: '15' });
  if (!body) return null;
  const want = normalizeLoose(name);
  const named = (body.search ?? []).filter(
    (r) => !/disambiguation/i.test(r.description ?? '') && [r.label, r.match?.text].some((t) => t && normalizeLoose(t) === want)
  );
  const fits = named.filter((r) => FITS[category].test(r.description ?? ''));
  if (fits.length) return { how: 'search', qids: fits.map((r) => r.id) };
  const franchise = named.filter((r) => FRANCHISE.test(r.description ?? ''));
  return { how: 'search-franchise', qids: franchise.map((r) => r.id) };
}

// The works each Wikidata-seeded list was built from, by category and list name.
function seededWorks() {
  const file = path.join(SEED_DIR, 'wikidata-characters.json');
  if (!fs.existsSync(file)) return new Map();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const series = Object.entries(data.series).map(([qid, s]) => ({ ...s, qid }));
  const out = new Map();
  for (const entry of mergeFranchises(series)) {
    const qids = entry.qids ?? (entry.qid ? [entry.qid] : []);
    if (qids.length) out.set(key(entry.category, entry.label), qids);
  }
  return out;
}

// Lists given their works by hand: { "Category<|>List": [qids] }.
function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'work-overrides.json'), 'utf8')).works ?? {};
  } catch {
    return {};
  }
}
const sameIds = (a = [], b = []) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function readPrevious() {
  try {
    const data = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    return data.measure === MEASURE ? data.works ?? {} : {};
  } catch {
    return {};
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const targets = lists.listLists(null).filter((l) => REACHED.has(l.category));
  const seeded = seededWorks();
  const overrides = readOverrides();
  const previous = readPrevious();
  const works = {};

  // Pass 1: which works each list is. Seeded lists know; the rest are searched, one at a time.
  const pending = [];
  let searched = 0;
  for (const list of targets) {
    const k = key(list.category, list.name);
    const before = previous[k];
    const given = overrides[k];
    if (given) {
      // Given by hand: measured like a seeded franchise, re-measured whenever the hand changes.
      if (before?.how === 'override' && before.status !== 'unknown' && sameIds(before.qids, given)) works[k] = before;
      else pending.push({ k, how: 'override', qids: given });
      continue;
    }
    if (before && before.status !== 'unknown') {
      works[k] = before; // already settled: a re-run only retries what failed
      continue;
    }
    const qids = seeded.get(k);
    if (qids && qids.length === 1) {
      pending.push({ k, how: 'seed', qids });
      continue;
    }
    if (qids) {
      // A franchise: its works, plus whatever its name itself is, of this category's kind.
      const namesake = await searchWorks(list.name, list.category);
      if (++searched % 50 === 0) console.log(`  searched ${searched}...`);
      await sleep(GAP_MS);
      if (!namesake) works[k] = { status: 'unknown' };
      else pending.push({ k, how: 'seed', qids: [...new Set([...qids, ...(namesake.how === 'search' ? namesake.qids : [])])] });
      continue;
    }
    const found = await searchWorks(list.name, list.category);
    if (++searched % 50 === 0) console.log(`  searched ${searched}...`);
    if (!found) works[k] = { status: 'unknown' };
    else if (!found.qids.length) works[k] = { status: 'none' };
    else pending.push({ k, how: found.how, qids: found.qids });
    await sleep(GAP_MS);
  }

  // Pass 2: which works the list is measured by, among those with an English article (the
  // readership is measured there). A seeded list: all of them. A searched one: the one most
  // Wikipedias cover.
  const info = await entityInfo(pending.flatMap((p) => p.qids));
  const chosen = [];
  for (const p of pending) {
    const known = p.qids.filter((q) => info.has(q));
    if (!known.length) {
      works[p.k] = { status: 'unknown' };
      continue;
    }
    const english = known.filter((q) => info.get(q).title);
    if (!english.length) {
      works[p.k] = { status: 'none', how: p.how }; // found, but nothing English to measure
      continue;
    }
    const qid = english.reduce((a, b) => (info.get(b).wikipedias > info.get(a).wikipedias ? b : a));
    const many = p.how === 'seed' || p.how === 'override';
    const measured = many ? english : [qid];
    const category = p.k.split('<|>')[0];
    // Which of them count towards reach: those of the list's own kind. A searched list's one work
    // was already chosen to fit; a seeded list's members can be anything the seed filed there.
    const ofKind = (q) => !many || FITS[category].test(info.get(q).description);
    const articles = [...new Map(measured.map((q) => [info.get(q).title, { title: info.get(q).title, ofKind: ofKind(q) }])).values()];
    chosen.push({ ...p, qid, title: info.get(qid).title, articles });
  }

  // Pass 3: a year of readers for each chosen work, added up per list. The score. Any one
  // failed lookup makes the list unknown: a partial sum would rank it lower than it is.
  const span = lastYear();
  let looked = 0;
  for (const c of chosen) {
    let total = 0;
    let best = 0; // the best-known work OF ITS KIND: the list's reach
    let bestAny = 0; // ...falling back to any of its works when none is of its kind
    for (const work of c.articles) {
      const views = await readers(work.title, span);
      if (views == null) { total = null; break; }
      total += views;
      bestAny = Math.max(bestAny, views);
      if (work.ofKind) best = Math.max(best, views);
      if (++looked % 250 === 0) console.log(`  readers for ${looked} articles...`);
      await sleep(25);
    }
    if (total == null) works[c.k] = { status: 'unknown' };
    else {
      works[c.k] = {
        status: total > 0 ? 'ok' : 'none', qid: c.qid, title: c.title, works: c.articles.length, readers: total, best: best || bestAny, how: c.how,
        ...(c.how === 'override' ? { qids: c.qids } : {}), // so a changed hand is noticed next run
      };
    }
  }

  writeFileAtomic(
    OUT_PATH,
    JSON.stringify(
      // `rankedCategories`: whose popularity these readers ARE (backfill-popularity.js reads it);
      // the rest are measured for reach alone.
      { source: "English Wikipedia readers of each list's work", measure: MEASURE, span, rankedCategories: [...RANKED], updatedAt: new Date().toISOString(), works },
      null,
      1
    )
  );

  const tally = { ok: 0, none: 0, unknown: 0 };
  for (const w of Object.values(works)) tally[w.status]++;
  console.log(`${targets.length} lists: ${tally.ok} scored, ${tally.none} with no work found, ${tally.unknown} unknown (a failed request). Wrote ${path.relative(process.cwd(), OUT_PATH)}.`);
  for (const category of REACHED) {
    const inCat = targets.filter((l) => l.category === category);
    const scored = inCat.filter((l) => works[key(category, l.name)]?.status === 'ok').length;
    console.log(`  ${category}: ${scored} of ${inCat.length} scored`);
  }

  if (!apply) return;
  if (tally.unknown) {
    console.error(`Not applying: ${tally.unknown} list(s) are unknown. Run again to retry them, then --apply.`);
    process.exitCode = 1;
    return;
  }
  // Whole categories at once, in one transaction: nobody should ever see a category half on
  // one scale and half on the other.
  const db = require('../src/compendium/db');
  let ranked = 0;
  let unranked = 0;
  let reached = 0;
  db.transaction(() => {
    for (const list of targets) {
      const w = works[key(list.category, list.name)];
      const ok = w?.status === 'ok';
      lists.setListReach(list.id, ok ? w.best : null);
      if (ok) reached++;
      if (!RANKED.has(list.category)) continue;
      lists.setListPopularity(list.id, ok ? w.readers : null);
      if (ok) ranked++;
      else unranked++;
    }
  })();
  console.log(`Applied: ${ranked} lists ranked by their work, ${unranked} unranked (they sort last); reach for ${reached} of ${targets.length}.`);
}

module.exports = { searchWorks, wikipedias, lastYear, FITS, FRANCHISE, MEASURE, RANKED, REACHED };

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1); });
