// Fills in character_lists.popularity from the seed files, so /list select can sort
// best-known first.
//
// The fame score is only ever compared WITHIN a category, which is what lets two
// incompatible scales sit in one column -- but that only holds if a score is applied to
// the category it came FROM. Keying by title alone does not work: "Sword Art Online" is
// both an anime and a games list, and the AniList scale (hundreds of thousands) against
// the sitelinks scale (tens) put four anime at the top of Video Games. Hence the
// category-qualified key below.
//
//   Anime / Manga     AniList `popularity` -- users with the title on their list
//                     (Cowboy Bebop: 460,961)
//   TV, Cartoon,      a year of English Wikipedia readers of the work (data/seed/work-fame.json,
//   Movies, Games     from scripts/fetch-work-fame.js) -- the whole category, once that has
//                     run. Before it, and for anything it does not cover: summed Wikipedia
//                     sitelinks across the cast, which ranked a big cast over a famous show.
//   Real People       the same sitelink scale, summed across the people in each field --
//                     so Actors outranks Ice Hockey Players, which is the truth.
//
// Both seed pipelines merge entries before creating lists (seasons for AniList, franchises
// for Wikidata), so this reuses their own merge functions rather than re-deriving the
// naming -- otherwise "Naruto Shippuden" would fail to match the "Naruto" list it was
// folded into.
//
//   node scripts/backfill-popularity.js [scope] [--top=N] [--reset] [--no-enable]
//
// Ranking is done on the shared compendium. The optional scope -- a Discord guild id, or 'web'
// -- is whose playable selection then gets re-cut to each category's top N; with none, it only
// ranks. (Unlike the other content scripts, a leading guild id still means something here:
// whose selection to cut, which is what it always meant.)

const fs = require('fs');
const path = require('path');
const { mergeSeasons } = require('./seed-anilist-characters');
const { mergeFranchises } = require('./seed-wikidata-characters');
const { assignPeople } = require('./seed-wikidata-people');
const {
  setPopularityByName,
  clearPopularity,
  listLists,
  getCharacters,
  setTopN,
  disableAllLists,
  listCategoriesWithEnabledCounts,
  setCharacterFame,
} = require('../src/compendium/characterLists');

// Ranking without acting on it leaves a server staring at 2,000 disabled lists, so the
// script finishes the job: the best-known DEFAULT_TOP of each category go into the pool.
// `--top=N` moves the line, `--no-enable` ranks only.
const DEFAULT_TOP = 100;

// Real People lists are named by field ("Actors"), not by title, so they carry their own
// category constant rather than one derived from the data.
const PEOPLE_CATEGORY = 'Real People';

const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');

function readSeed(file) {
  const full = path.join(SEED_DIR, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

// A score belongs to one category's scale, so the key carries the category, and the
// character key appends the name. The separator just has to be something no title or
// character name will contain.
const key = (category, label) => `${category ?? 'Uncategorized'}<|>${label}`;

// Highest wins when two merged entries collide on the same category and name.
function collect(into, category, label, score) {
  if (!label || !Number.isFinite(score) || score <= 0) return;
  const k = key(category, label);
  if (score > (into.get(k) ?? 0)) into.set(k, score);
}

function scoresFromAniList() {
  const data = readSeed('anilist-characters.json');
  if (!data) return new Map();
  const scores = new Map();
  for (const entry of mergeSeasons(Object.values(data.series))) {
    collect(scores, entry.category, entry.label, entry.popularity);
  }
  return scores;
}

// Real people, scored on the same sitelink scale as the Wikidata-sourced characters.
//
// Uses the seeder's own assignment rather than the raw groups: a person belongs to exactly
// one list, and summing the group as fetched would rank Actors on Shakespeare, Trump and
// Reagan, none of whom end up in it.
function scoresFromPeople() {
  const data = readSeed('wikidata-people.json');
  if (!data) return new Map();
  const scores = new Map();
  for (const entry of assignPeople(data.groups)) {
    const fame = entry.people.reduce((sum, p) => sum + (p.sitelinks || 0), 0);
    collect(scores, PEOPLE_CATEGORY, entry.list, fame);
  }
  return scores;
}

// The work's own fame (scripts/fetch-work-fame.js): a year of English Wikipedia readers of the
// show, film or game itself. Where that file has run, it is the scale for its categories, whole -- the cast
// sum below ranked a big cast over a famous show (Glee over Breaking Bad), and mixing the two
// scales in one category would rank by which one a list happened to get.
function workFame() {
  const data = readSeed('work-fame.json');
  const categories = new Set();
  const scores = new Map();
  for (const [k, w] of Object.entries(data?.works ?? {})) {
    const [category, label] = k.split('<|>');
    categories.add(category);
    if (w.status === 'ok') collect(scores, category, label, w.readers);
  }
  return { categories, scores };
}

function scoresFromWikidata(skip = new Set()) {
  const data = readSeed('wikidata-characters.json');
  if (!data) return new Map();
  const scores = new Map();
  for (const entry of mergeFranchises(Object.values(data.series))) {
    if (skip.has(entry.category)) continue;
    const fame = (entry.characters ?? []).reduce((sum, c) => sum + (c.sitelinks || 0), 0);
    collect(scores, entry.category, entry.label, fame);
  }
  return scores;
}

// Per-character fame, keyed the same way as the list scores. The merged entries carry the
// cast that was actually imported, so this walks them rather than the DB: a character the
// seed pipeline dropped has nothing to score anyway.
function characterScores() {
  const scores = new Map();
  const add = (category, label, name, fame) => {
    if (!Number.isFinite(fame) || fame <= 0) return;
    scores.set(`${key(category, label)}<|>${name.toLowerCase()}`, fame);
  };

  const anilist = readSeed('anilist-characters.json');
  if (anilist) {
    for (const entry of mergeSeasons(Object.values(anilist.series))) {
      for (const c of entry.characters ?? []) add(entry.category, entry.label, c.name, c.favourites);
    }
  }
  const wikidata = readSeed('wikidata-characters.json');
  if (wikidata) {
    for (const entry of mergeFranchises(Object.values(wikidata.series))) {
      for (const c of entry.characters ?? []) add(entry.category, entry.label, c.name, c.sitelinks);
    }
  }
  // Without this the difficulty setting would silently do nothing to Real People: a list
  // with no fame data passes through untouched, so Easy would deal Marie Curie and a
  // physicist nobody has heard of with equal probability.
  const people = readSeed('wikidata-people.json');
  if (people) {
    for (const entry of assignPeople(people.groups)) {
      for (const p of entry.people) add(PEOPLE_CATEGORY, entry.list, p.name, p.sitelinks);
    }
  }
  return scores;
}

function backfillCharacterFame(lists) {
  const scores = characterScores();
  let ranked = 0;
  let unranked = 0;
  for (const list of lists) {
    for (const character of getCharacters(list.id)) {
      const fame = scores.get(`${key(list.category, list.name)}<|>${character.name.toLowerCase()}`);
      if (fame == null) {
        unranked++;
        continue;
      }
      if (setCharacterFame(list.id, character.name, fame)) ranked++;
    }
  }
  return { ranked, unranked };
}

function main() {
  const args = process.argv.slice(2);
  const scope = args.find((a) => !a.startsWith('--')) ?? null;
  const topArg = args.find((a) => a.startsWith('--top='));
  const top = topArg ? Number(topArg.slice('--top='.length)) : DEFAULT_TOP;
  const enable = scope != null && !args.includes('--no-enable') && Number.isFinite(top) && top > 0;
  const reset = args.includes('--reset');

  const works = workFame();
  const scores = new Map([...scoresFromWikidata(works.categories), ...works.scores, ...scoresFromAniList(), ...scoresFromPeople()]);
  console.log(`Fame scores available for ${scores.size} titles.`);

  // Clear first, so a re-run after the seed data changes drops scores that no longer match
  // instead of leaving a stale one in place.
  clearPopularity(null);

  let matched = 0;
  const unmatched = [];
  for (const list of listLists(null)) {
    const score = scores.get(key(list.category, list.name));
    if (score == null) {
      unmatched.push(list.name);
      continue;
    }
    if (setPopularityByName(null, list.name, score)) matched++;
  }

  console.log(`Ranked ${matched} shared lists.`);
  if (unmatched.length) {
    // Unranked lists still work -- they just sort last on the /list select page.
    console.log(`${unmatched.length} lists had no score and will sort last, e.g. ${unmatched.slice(0, 5).join(', ')}`);
  }

  // Character fame is what difficulty cuts on, so it has to be filled in for Easy/Normal
  // to mean anything.
  const { ranked: chars, unranked } = backfillCharacterFame(listLists(null));
  console.log(`Ranked ${chars} characters (${unranked} had no score and are never cut by difficulty).`);

  if (!enable) {
    console.log(
      scope == null
        ? 'Ranking only (no scope given); no playable selection was touched.'
        : 'Ranking only (--no-enable); the playable selection was left alone.'
    );
    return;
  }

  if (reset) {
    const cleared = disableAllLists(scope);
    console.log(`\nCleared ${scope}'s selection (${cleared} lists reset to off).`);
  }

  const { enabled, disabled } = setTopN(scope, null, top);
  console.log(`Every category is now exactly its top ${top} for ${scope} -- ${enabled} on, ${disabled} off.`);
  for (const c of listCategoriesWithEnabledCounts(scope)) {
    console.log(`  ${c.category}: ${c.enabled} of ${c.count}`);
  }
  console.log('\nAdjust with /list select (checkboxes) or /list toggle <list> (one at a time).');
}

module.exports = { scoresFromAniList, scoresFromWikidata };

if (require.main === module) main();
