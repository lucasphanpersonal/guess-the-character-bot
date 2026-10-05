// Builds data/seed/wikidata-characters.json -- a roster of fictional characters grouped by
// the show/film they appear in, for the franchises the Character Codex barely covers.
//
// WHY THIS EXISTS
// The codex is broad but shallow on Western screen media: it has 2 Samurai Jack characters,
// 1 for Hey Arnold!, and nothing at all for The Powerpuff Girls, Ed Edd n Eddy, Ben 10 or
// Regular Show. Since seed-character-codex only breaks a franchise out into its own list at
// FRANCHISE_MIN_CHARACTERS (3), most cartoons never even become a playable list.
//
// SOURCE
// Wikidata, via the public SPARQL endpoint. No API key. The shape that makes this work:
//
//   ?character wdt:P1441 ?series      "present in work"
//   ?character wdt:P31/wdt:P279* wd:Q95074    is (a subclass of) fictional character
//
// The type walk is load-bearing rather than tidy-up. P1441 alone happily returns the Krusty
// Krab, Bikini Bottom, the Krabby Patty and assorted memes alongside Squidward -- roughly
// half of SpongeBob's 294 P1441 items are places, foods or running gags. Constraining to
// descendants of "fictional character" cuts that to 152 actual characters.
//
// Series are discovered rather than hand-listed: SOURCE_GROUPS names broadcasters and
// production companies, and every series/film they put out is swept up. That means a show
// nobody thought to add by hand still lands, and the file stays current by re-running.
//
// COST AND RESUMABILITY
// The type walk is expensive, so WDQS is queried in small chunks of series and it still
// takes ~20s per chunk; the whole sweep is tens of minutes. The endpoint returns 502 or 429
// under load, so every request retries with backoff, and the output file doubles as the
// resume log -- series already fetched are skipped, so Ctrl-C and re-run costs only the
// chunk that was in flight.
//
// NO FAME FILTER IS APPLIED HERE. Everything found is written to the file, along with each
// character's sitelink count (how many language Wikipedias have an article on them). The
// trimming happens at seed time, where it can be retuned without paying for a refetch.
//
// Usage:
//   node scripts/fetch-wikidata-characters.js               # fetch everything missing
//   node scripts/fetch-wikidata-characters.js --group kids-tv   # one group only
//   node scripts/fetch-wikidata-characters.js --list-groups
//   node scripts/fetch-wikidata-characters.js --refresh     # ignore what's already there

const fs = require('fs');
// Resume file = committed seed data: never leave it half-written (see the helper).
const { writeFileAtomic } = require('./lib/writeAtomic');
const path = require('path');

const SPARQL = 'https://query.wikidata.org/sparql';
const WBAPI = 'https://www.wikidata.org/w/api.php';
// Wikimedia asks for a descriptive User-Agent identifying the tool and a contact point.
const USER_AGENT =
  'guess-the-character-bot/1.0 (Discord party game; https://github.com/lucasphanpersonal/guess-the-character-bot)';

const OUT_PATH = path.join(__dirname, '..', 'data', 'seed', 'wikidata-characters.json');

// Series per SPARQL request, before adaptive splitting.
//
// There is no chunk size that works everywhere: 40 of Adult Swim's series answer in 8s,
// while 40 of Fox's time the endpoint out entirely (HTTP 504), because a chunk's cost is
// driven by how many characters its heaviest series has rather than by the series count.
// So this is only a starting point -- a chunk that times out is split in half and retried,
// down to a single series, which is what makes the sweep survive The Simpsons.
const SERIES_CHUNK = 24;
// wbgetentities accepts 50 ids per call for the display-name pass.
const ENTITY_CHUNK = 50;
const MAX_RETRIES = 5;

// WDQS throttles on cumulative *query time* per IP, not request count, and these queries are
// expensive enough (5-20s each) that firing them back to back burns the budget in about a
// minute -- after which every request is answered 429 with a 120s Retry-After, which is far
// slower than simply pacing. Idling for as long as the previous query took keeps the sweep
// at roughly a 50% duty cycle, which the endpoint sustains without penalising.
const PACING_RATIO = 1;

// wd:Q95074 is "fictional character"; every character type used on Wikidata (fictional
// human, animated character, comics character, ...) is a descendant of it.
const FICTIONAL_CHARACTER = 'wd:Q95074';

/**
 * What to sweep.
 *
 * `broadcasters` matches on P449 (original broadcaster) and `studios` on P272 (production
 * company) -- a TV series is reliably tagged with the former and a theatrical film with the
 * latter, and using the wrong one for either finds almost nothing.
 *
 * `category` is only a fallback: deriveCategories() overrides it per series from what
 * Wikidata says the series actually is (TV, animated TV, or film), which is right far more
 * often than a whole group's source would be -- Adult Swim and Fox both air live-action
 * programming too. It's used only for the rare series Wikidata gives neither signal for, so
 * it should still be a best guess at what the group's *typical* member is, and has to be one
 * of the categories the rest of the seed data already uses ("Television Shows", "Cartoon",
 * "Movies").
 */
const SOURCE_GROUPS = {
  'kids-tv': {
    label: 'Cartoon Network / Nickelodeon / Disney Channel / Disney XD',
    category: 'Cartoon',
    // Verify any QID added here against the item's own label rather than trusting
    // wbsearchentities: searching "Disney Channel" returns Q1368786 (Disney Channel *Asia*)
    // ahead of the US channel, and using it silently cost the entire Disney Channel
    // catalogue -- Kim Possible, Recess, Lilo & Stitch: The Series -- on the first sweep.
    broadcasters: {
      Q708290: 'Cartoon Network',
      Q154958: 'Nickelodeon',
      Q178837: 'Disney Channel (US)',
      Q1858139: 'Disney XD',
      Q1183935: 'Cartoon Network (Canada, formerly Teletoon)',
      Q3245159: 'PBS Kids',
    },
    // Disney files a lot of its shows under the production arm rather than the channel.
    studios: {
      Q1392453: 'Disney Television Animation',
    },
  },
  'adult-animation': {
    label: 'Adult Swim / Fox animation',
    category: 'Cartoon',
    broadcasters: {
      Q379052: 'Adult Swim',
      Q166419: 'Fox Broadcasting Company',
    },
  },
  'animation-studios': {
    label: 'Disney / Pixar / DreamWorks / WB / Cartoon Network Studios',
    category: 'Movies',
    studios: {
      Q1047410: 'Walt Disney Animation Studios',
      Q191224: 'Walt Disney Pictures',
      Q127552: 'Pixar',
      Q500088: 'DreamWorks Animation',
      Q858803: 'Cartoon Network Studios',
    },
  },
  'live-action-tv': {
    label: 'HBO / AMC / Netflix / broadcast drama',
    category: 'Television Shows',
    broadcasters: {
      Q23633: 'HBO',
      Q294660: 'AMC',
      Q907311: 'Netflix',
    },
  },
  'video-games': {
    label: 'Video games (every game Wikidata records characters for)',
    category: 'Video Games',
    // Games are discovered by being games, not by who made them. Scoping to a hand-written
    // list of 34 major studios was the original approach and it left most of the catalogue
    // out -- 670 games, against the ~4,000 that asking for "anything typed as a video game
    // with a character" reaches. There is no developer list to maintain, and indie and
    // older titles stop depending on whether their studio was famous enough to think of.
    anyOfType: 'Q7889', // video game
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// WDQS answers 502/429/500 whenever it is busy rather than queueing, and those are the
// normal case on a sweep this size rather than an exceptional one -- so a failed request is
// retried rather than aborting the run.
async function sparql(query, { label, retries = MAX_RETRIES }) {
  const url = `${SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    // A timeout is a statement about the query being too expensive, not about the endpoint
    // being busy, so it is reported straight back for the caller to split rather than
    // retried identically five times.
    const bail = (status) => {
      const err = new Error(`${label}: WDQS returned ${status}`);
      err.status = status;
      return err;
    };
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' } });
    } catch (err) {
      if (attempt >= retries) throw new Error(`${label}: ${err.message}`);
      const wait = 3000 * 2 ** attempt;
      console.warn(`    retry ${attempt + 1}/${retries} (${err.message}) in ${wait / 1000}s -- ${label}`);
      await sleep(wait);
      continue;
    }
    if (res.ok) {
      const bindings = (await res.json()).results.bindings;
      await sleep(Math.min((Date.now() - startedAt) * PACING_RATIO, 30000));
      return bindings;
    }
    if (res.status === 504) throw bail(504);
    if (attempt >= retries) throw bail(res.status);
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 3000 * 2 ** attempt;
    console.warn(`    retry ${attempt + 1}/${retries} (HTTP ${res.status}) in ${wait / 1000}s -- ${label}`);
    await sleep(wait);
  }
}

async function wbGetEntities(ids, props) {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    format: 'json',
    ids: ids.join('|'),
    props,
    languages: 'en',
    sitefilter: 'enwiki',
  });
  // These passes make thousands of calls over many minutes, so a dropped socket partway
  // through is routine rather than exceptional -- it has to be retried like an HTTP error,
  // not thrown out of the run after the expensive sweep has already finished.
  for (let attempt = 0; ; attempt++) {
    let status = 'network error';
    try {
      const res = await fetch(`${WBAPI}?${params}`, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) {
        const body = await res.json();
        if (body.entities) return body.entities;
      }
      status = res.status;
    } catch (err) {
      status = err.message;
    }
    if (attempt >= MAX_RETRIES) throw new Error(`wbgetentities failed: ${status}`);
    await sleep(2000 * 2 ** attempt);
  }
}

const qidOf = (uri) => uri.split('/').pop();

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

// Which series/films a set of broadcasters or studios put out. Cheap (~1.5s for 3,700
// series) because it involves no type walking.
async function fetchSeries(group) {
  const series = new Map();

  // A whole medium at once, rather than a list of who made things. `^wdt:P1441` restricts
  // to works that actually have a character on Wikidata, which is what keeps this from
  // returning the ~100,000 games that would contribute nothing.
  if (group.anyOfType) {
    const rows = await sparql(
      `SELECT DISTINCT ?series ?seriesLabel WHERE {
         ?series wdt:P31/wdt:P279* wd:${group.anyOfType} ; ^wdt:P1441 ?c .
         SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
       }`,
      { label: `everything of type ${group.anyOfType}` }
    );
    for (const row of rows) {
      const qid = qidOf(row.series.value);
      const label = row.seriesLabel.value;
      if (label === qid) continue;
      if (!series.has(qid)) series.set(qid, label);
    }
  }

  const byProperty = [
    ['wdt:P449', group.broadcasters],
    ['wdt:P272', group.studios],
    ['wdt:P178', group.developers],
  ].filter(([, ids]) => ids);

  for (const [property, ids] of byProperty) {
    const values = Object.keys(ids).map((q) => `wd:${q}`).join(' ');
    const rows = await sparql(
      `SELECT ?series ?seriesLabel WHERE {
         VALUES ?source { ${values} }
         ?series ${property} ?source .
         SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
       }`,
      { label: `series for ${property}` }
    );
    for (const row of rows) {
      const qid = qidOf(row.series.value);
      const label = row.seriesLabel.value;
      // An unlabelled item comes back as its own QID, which is useless as a list name.
      if (label === qid) continue;
      if (!series.has(qid)) series.set(qid, label);
    }
  }
  return series;
}

/**
 * Characters for one chunk of series.
 *
 * A character with several P31 types produces one row per type, so results are folded by
 * QID rather than trusted row-for-row. Note a character can legitimately appear under more
 * than one series (crossovers, spin-offs) and is kept under each.
 */
async function fetchCharacterChunk(qids) {
  const values = qids.map((q) => `wd:${q}`).join(' ');
  const rows = await sparql(
    `SELECT ?c ?cLabel ?series ?sitelinks ?img WHERE {
       VALUES ?series { ${values} }
       ?c wdt:P1441 ?series ;
          wdt:P31 ?type ;
          wikibase:sitelinks ?sitelinks .
       ?type wdt:P279* ${FICTIONAL_CHARACTER} .
       OPTIONAL { ?c wdt:P18 ?img }
       SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
     }`,
    { label: `characters for ${qids.length} series`, retries: 3 }
  );

  const bySeries = new Map();
  for (const row of rows) {
    const qid = qidOf(row.c.value);
    const name = row.cLabel.value;
    // Unlabelled items come back as the bare QID -- nobody can guess "Q16276".
    if (name === qid) continue;
    const seriesQid = qidOf(row.series.value);
    if (!bySeries.has(seriesQid)) bySeries.set(seriesQid, new Map());
    const chars = bySeries.get(seriesQid);
    if (!chars.has(qid)) {
      chars.set(qid, {
        qid,
        name,
        sitelinks: Number(row.sitelinks.value),
        image: row.img ? row.img.value : null,
      });
    }
  }
  return bySeries;
}

/**
 * fetchCharacterChunk, but halving the chunk whenever the endpoint times out.
 *
 * Query cost scales with the heaviest series in the chunk, not the chunk size, so one
 * Simpsons-sized series can blow the 60s budget for the 23 ordinary series sharing its
 * request. Splitting isolates the expensive one instead of failing its neighbours with it.
 *
 * A single series that still times out on its own is genuinely unqueryable within the
 * endpoint's limit; it is reported and skipped rather than stalling the sweep. Skipped
 * series are *not* recorded as fetched, so a later run retries them.
 */
async function fetchCharactersAdaptive(qids, skipped) {
  try {
    return await fetchCharacterChunk(qids);
  } catch (err) {
    if (err.status !== 504 || qids.length === 1) {
      if (qids.length === 1) {
        console.warn(`    ! skipping ${qids[0]} (${err.message})`);
        skipped.push(qids[0]);
        return new Map();
      }
      throw err;
    }
    const mid = Math.ceil(qids.length / 2);
    console.warn(`    timed out on ${qids.length} series -- splitting into ${mid} + ${qids.length - mid}`);
    const merged = new Map();
    for (const half of [qids.slice(0, mid), qids.slice(mid)]) {
      for (const [seriesQid, chars] of await fetchCharactersAdaptive(half, skipped)) {
        merged.set(seriesQid, chars);
      }
    }
    return merged;
  }
}

// Individual episodes and seasons carry P449 (original broadcaster) exactly like the series
// they belong to, so a broadcaster sweep picks them up as if they were separate shows --
// "The Two Mrs. Nahasapeemapetilons" arrives looking like a sibling of The Simpsons. They
// are dropped rather than kept, since a list holding one episode's guest cast is not a
// franchise anybody would pick at lobby time.
//
// These are the *roots* of the hierarchy, not the whole of it: descendants are resolved
// against Wikidata rather than listed here. Matching exact QIDs was the original approach
// and it leaked, because Wikidata types a cartoon's episodes as "animated series episode"
// (Q116048824, a subclass of Q1983062) which no exact-match list happened to name -- so 37
// episodes with big enough guest casts survived into playable lists, which is precisely
// what this filter exists to stop.
const NOT_A_WORK_ROOTS = {
  Q1983062: 'episode', // covers television and animated series episodes
  Q3464665: 'television series season',
  // Not a descendant of "episode" on Wikidata despite the name, so it has to be named
  // separately or the roots quietly stop dropping what the old exact-match list caught.
  Q93992677: 'web series episode',
};

// Anime is fetched from AniList instead (scripts/fetch-anilist-characters.js), which knows
// far more about it than Wikidata does -- proper romanised names, per-character images and
// popularity ranking rather than a sitelink count. A handful of anime reaches this sweep
// anyway, because Netflix and Adult Swim carry some, and keeping it would mean the same show
// arriving twice under two categories with the poorer copy sometimes winning the list name.
//
// Q1107 ("anime") is the whole hierarchy's root and is safe to prune from wholesale: Western
// animation is *above* it, not under it -- "anime television series" is a subclass of
// "animated television series" rather than the reverse -- so SpongeBob and Adventure Time
// are unaffected.
const ANIME_ROOT = 'Q1107';

/**
 * Removes series entries that are really episodes or seasons, plus anime that AniList
 * covers better.
 *
 * Runs as a post-pass over the whole file rather than as a filter on the series query,
 * because it costs one cheap wbgetentities call per 50 items either way, and doing it here
 * also cleans up anything collected by earlier runs.
 */
async function pruneUnwanted(data) {
  const qids = Object.keys(data.series);
  const typesBySeries = new Map();
  const allTypes = new Set();
  for (let i = 0; i < qids.length; i += ENTITY_CHUNK) {
    const entities = await wbGetEntities(qids.slice(i, i + ENTITY_CHUNK), 'claims');
    for (const [qid, entity] of Object.entries(entities)) {
      const types = (entity.claims?.P31 || [])
        .map((c) => c.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
      typesBySeries.set(qid, types);
      for (const t of types) allTypes.add(t);
    }
  }

  // One pass over the distinct types asking which descend from an episode/season root and
  // which from the anime root, keeping this to a handful of queries no matter how many
  // series there are.
  const roots = Object.keys(NOT_A_WORK_ROOTS).map((q) => `wd:${q}`).join(' ');
  const notAWork = new Set();
  const isAnime = new Set();
  const typeList = [...allTypes];
  for (let i = 0; i < typeList.length; i += 150) {
    const values = typeList.slice(i, i + 150).map((t) => `wd:${t}`).join(' ');
    const rows = await sparql(
      `SELECT ?t ?isPart ?anime WHERE {
         VALUES ?t { ${values} }
         BIND(EXISTS { VALUES ?root { ${roots} } ?t wdt:P279* ?root } AS ?isPart)
         BIND(EXISTS { ?t wdt:P279* wd:${ANIME_ROOT} } AS ?anime)
       }`,
      { label: 'classifying episode/season/anime types' }
    );
    for (const row of rows) {
      const t = qidOf(row.t.value);
      if (row.isPart?.value === 'true') notAWork.add(t);
      if (row.anime?.value === 'true') isAnime.add(t);
    }
  }

  let episodes = 0;
  let anime = 0;
  for (const qid of qids) {
    const types = typesBySeries.get(qid) || [];
    if (!types.length) continue;
    // The two rules deliberately quantify differently. Dropping an episode is a deletion
    // guard, so every type has to agree -- an item typed as something else as well is a
    // work and stays. Anime is a positive identification, so one type naming it is enough:
    // Aggretsuko is an anime series that also carries "conflation" (Q14946528, a data
    // quality marker rather than a genre), and requiring unanimity would keep it.
    if (types.every((t) => notAWork.has(t))) {
      delete data.series[qid];
      episodes++;
    } else if (types.some((t) => isAnime.has(t))) {
      delete data.series[qid];
      anime++;
    }
  }
  return { episodes, anime };
}

/**
 * Sets each series' category from what the series actually *is*, not from the group that
 * found it.
 *
 * The group cannot decide this: "Cartoon Network Studios" is reached as a production
 * company, which is how films are usually tagged, but almost everything it makes is a TV
 * series -- so bucketing the whole group as "Movies" filed Samurai Jack, Dexter's
 * Laboratory and Adventure Time as films. Wikidata already knows the difference, so ask it.
 *
 * TV further splits into "Cartoon" vs "Television Shows" by the same method: Wikidata types
 * SpongeBob, Rick and Morty and Family Guy as an "animated television series" (Q117467246,
 * which "anime television series" also descends from) and Breaking Bad or Game of Thrones
 * as a plain "television series" (Q5398426) with no such ancestor. That is a more reliable
 * split than which broadcaster a show came from -- Adult Swim and Fox both air live-action
 * programming too, and grouping by broadcaster would have filed it as a cartoon regardless.
 *
 * The classification is done on the handful of distinct P31 types rather than per series,
 * which keeps it to one extra query no matter how many series there are.
 *
 * Genre (P136) is consulted as a second animation signal because P31 alone is not complete:
 * Steven Universe: The Movie is typed only as a plain "television film" and carries its
 * animation in the genre field, so a type-only check filed it under live-action. Genre is
 * read from the same entity fetch, so it costs nothing extra, and it is only ever used to
 * add an animation signal -- never to decide TV vs film, where it would be far noisier.
 */
async function deriveCategories(data) {
  const qids = Object.keys(data.series);
  const typesBySeries = new Map();
  const genresBySeries = new Map();
  const allTypes = new Set();
  for (let i = 0; i < qids.length; i += ENTITY_CHUNK) {
    const entities = await wbGetEntities(qids.slice(i, i + ENTITY_CHUNK), 'claims');
    for (const [qid, entity] of Object.entries(entities)) {
      const idsOf = (prop) =>
        (entity.claims?.[prop] || []).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
      const types = idsOf('P31');
      const genres = idsOf('P136');
      typesBySeries.set(qid, types);
      genresBySeries.set(qid, genres);
      for (const t of [...types, ...genres]) allTypes.add(t);
    }
  }

  // One pass over the distinct types: is each one a kind of film, a kind of TV series, or
  // animated? Q11424 = film, Q15416 = television program, Q117467246 = animated television
  // series, Q202866 = animated film.
  //
  // Animation needs both roots because Wikidata splits it by format rather than by being
  // animated: "animated television film" (Steven Universe: The Movie, Kim Possible: A Sitch
  // in Time) descends from the film root only, so checking the series root alone left those
  // filed next to Breaking Bad. Adding the film root does not pull theatrical animation into
  // Cartoon, since isAnimated is only consulted on the TV branch below.
  const filmish = new Set();
  const tvish = new Set();
  const animated = new Set();
  const typeList = [...allTypes];
  for (let i = 0; i < typeList.length; i += 150) {
    const values = typeList.slice(i, i + 150).map((t) => `wd:${t}`).join(' ');
    const rows = await sparql(
      `SELECT ?t ?isFilm ?isTv ?isAnimated WHERE {
         VALUES ?t { ${values} }
         BIND(EXISTS { ?t wdt:P279* wd:Q11424 } AS ?isFilm)
         BIND(EXISTS { ?t wdt:P279* wd:Q15416 } AS ?isTv)
         BIND(EXISTS {
           VALUES ?animRoot { wd:Q117467246 wd:Q202866 }
           ?t wdt:P279* ?animRoot
         } AS ?isAnimated)
       }`,
      { label: 'classifying series types' }
    );
    for (const row of rows) {
      const t = qidOf(row.t.value);
      if (row.isFilm?.value === 'true') filmish.add(t);
      if (row.isTv?.value === 'true') tvish.add(t);
      if (row.isAnimated?.value === 'true') animated.add(t);
    }
  }

  let changed = 0;
  for (const [qid, series] of Object.entries(data.series)) {
    const types = typesBySeries.get(qid) || [];
    // A TV signal wins over a film one: plenty of series carry both (a show with a
    // television-film pilot), and the show is the thing people would pick at lobby time.
    const isTv = types.some((t) => tvish.has(t));
    const isFilm = types.some((t) => filmish.has(t));
    const isAnimated =
      types.some((t) => animated.has(t)) || (genresBySeries.get(qid) || []).some((g) => animated.has(g));
    const category = isTv ? (isAnimated ? 'Cartoon' : 'Television Shows') : isFilm ? 'Movies' : series.category;
    if (category !== series.category) {
      series.category = category;
      changed++;
    }
  }
  return changed;
}

/**
 * Tags video game entries with the franchise they belong to, via P179 ("part of the
 * series").
 *
 * TV shows were grouped by broadcaster, which worked because a show and its channel stay
 * associated for the show's whole run. Games have no equivalent: Wikidata files every
 * numbered entry as its own item, so a straight import would offer "Kingdom Hearts",
 * "Kingdom Hearts II", "Kingdom Hearts III" and "Kingdom Hearts: Birth by Sleep" as four
 * unrelated lists with heavily overlapping casts. P179 is Wikidata's own answer to "which
 * series is this part of" and resolves cleanly -- Kingdom Hearts II's P179 points straight
 * at the Kingdom Hearts item -- so franchises are found by asking rather than by matching
 * titles, which is what made the season-suffix guessing for anime necessarily approximate.
 *
 * A chain is walked (a numbered entry can point at a sub-series that itself points at the
 * main franchise) up to a small hop limit, with a cycle guard, and the top of the chain
 * becomes the franchise name. A title with no P179 at all is standalone and is left
 * untagged -- scripts/seed-wikidata-characters.js then imports it under its own name, same
 * as before this existed.
 *
 * Scoped to the video-games group: walking this chain for the 1,300+ TV and film entries
 * would cost real time for no benefit, since those are already grouped by broadcaster.
 */
async function resolveFranchises(data) {
  const seedQids = Object.keys(data.series).filter((q) => data.series[q].group === 'video-games');
  if (!seedQids.length) return 0;

  const parentOf = new Map();
  const MAX_HOPS = 4;
  let frontier = seedQids;

  for (let hop = 0; hop < MAX_HOPS && frontier.length; hop++) {
    const toFetch = frontier.filter((q) => !parentOf.has(q));
    for (let i = 0; i < toFetch.length; i += ENTITY_CHUNK) {
      const batch = toFetch.slice(i, i + ENTITY_CHUNK);
      const entities = await wbGetEntities(batch, 'claims');
      for (const q of batch) {
        const parent = entities[q]?.claims?.P179?.[0]?.mainsnak?.datavalue?.value?.id || null;
        parentOf.set(q, parent);
      }
    }
    frontier = [...new Set([...parentOf.values()].filter(Boolean))].filter((q) => !parentOf.has(q));
  }

  const root = (qid) => {
    const seen = new Set();
    let cur = qid;
    while (true) {
      seen.add(cur);
      const parent = parentOf.get(cur);
      if (!parent || seen.has(parent)) return cur; // no parent, or a cycle -- stop here
      cur = parent;
    }
  };

  // The franchise root is often not itself one of the fetched games (e.g. "Kingdom Hearts"
  // the series item is distinct from "Kingdom Hearts" the first game), so its label has to
  // be looked up separately from anything already known.
  const roots = new Set(seedQids.map(root));
  const needLabels = [...roots].filter((q) => !data.series[q]);
  const labelOf = new Map();
  for (let i = 0; i < needLabels.length; i += ENTITY_CHUNK) {
    const batch = needLabels.slice(i, i + ENTITY_CHUNK);
    const entities = await wbGetEntities(batch, 'labels');
    for (const q of batch) {
      const label = entities[q]?.labels?.en?.value;
      if (label) labelOf.set(q, label);
    }
  }

  let tagged = 0;
  for (const qid of seedQids) {
    const r = root(qid);
    if (r === qid) continue; // no P179 at all -- a standalone title
    const label = data.series[r]?.label || labelOf.get(r);
    if (!label) continue; // couldn't name it -- leave untagged rather than show a QID
    data.series[qid].franchise = label;
    tagged++;
  }
  return tagged;
}

/**
 * Upgrades stored names to the English Wikipedia article title where there is one.
 *
 * Wikidata labels are canonical, not colloquial, and for a guessing game that is the wrong
 * end of the trade: Better Call Saul's Nacho Varga is labelled "Domingo Molina", which no
 * player will ever type. Wikipedia article titles are chosen for recognisability by policy,
 * so where a character has one it is a strictly better display name. The parenthetical
 * disambiguator Wikipedia adds ("Bubbles (The Powerpuff Girls)") is stripped, since the
 * list already supplies that context.
 *
 * Aliases are recorded alongside but deliberately not used as the name -- they are
 * unranked, so picking one would be a coin flip between "Nacho Varga" and "Ignacio Varga".
 */
async function attachCommonNames(characters, onProgress) {
  const byQid = new Map(characters.map((c) => [c.qid, c]));
  const ids = [...byQid.keys()];
  for (let i = 0; i < ids.length; i += ENTITY_CHUNK) {
    const batch = ids.slice(i, i + ENTITY_CHUNK);
    const entities = await wbGetEntities(batch, 'sitelinks|aliases');
    for (const [qid, entity] of Object.entries(entities)) {
      const target = byQid.get(qid);
      if (!target) continue;
      const title = entity.sitelinks?.enwiki?.title;
      if (title) {
        const stripped = title.replace(/\s*\([^)]*\)\s*$/, '').trim();
        if (stripped) target.name = stripped;
      }
      const aliases = (entity.aliases?.en || []).map((a) => a.value).filter((a) => a !== target.name);
      if (aliases.length) target.aliases = aliases.slice(0, 5);
    }
    onProgress(Math.min(i + ENTITY_CHUNK, ids.length), ids.length);
  }
}

// ---------------------------------------------------------------------------
// Output file
// ---------------------------------------------------------------------------

function load(refresh) {
  if (refresh || !fs.existsSync(OUT_PATH)) {
    return {
      source: 'Wikidata SPARQL (P1441 "present in work", typed as a fictional character)',
      groups: {},
      series: {},
    };
  }
  const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  parsed.groups = parsed.groups || {};
  parsed.series = parsed.series || {};
  return parsed;
}

function save(data) {
  data.updatedAt = new Date().toISOString().slice(0, 10);
  const series = Object.fromEntries(Object.entries(data.series).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileAtomic(OUT_PATH, `${JSON.stringify({ ...data, series }, null, 0)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { groups: [], refresh: false, listGroups: false, cleanOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--group') opts.groups.push(argv[++i]);
    else if (arg === '--refresh') opts.refresh = true;
    else if (arg === '--list-groups') opts.listGroups = true;
    // Re-runs only the post-passes (episode pruning, Wikipedia display names) over whatever
    // is already in the file, without touching the network-expensive sweep.
    else if (arg === '--clean-only') opts.cleanOnly = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  for (const g of opts.groups) {
    if (!SOURCE_GROUPS[g]) throw new Error(`Unknown group "${g}". Known: ${Object.keys(SOURCE_GROUPS).join(', ')}`);
  }
  if (!opts.groups.length) opts.groups = Object.keys(SOURCE_GROUPS);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.listGroups) {
    for (const [key, group] of Object.entries(SOURCE_GROUPS)) {
      console.log(`${key.padEnd(20)} ${group.label} -> category "${group.category}"`);
    }
    return;
  }

  const data = load(opts.refresh);
  const started = Date.now();

  for (const key of opts.cleanOnly ? [] : opts.groups) {
    const group = SOURCE_GROUPS[key];
    console.log(`\n=== ${key}: ${group.label} ===`);

    const series = await fetchSeries(group);
    console.log(`  ${series.size} series/films found.`);

    // The resume log. A series is recorded the moment its chunk lands, including when it
    // yielded no characters at all -- most series genuinely have none on Wikidata, and
    // without recording those a re-run would refetch thousands of empty series forever.
    data.groups[key] = data.groups[key] || { label: group.label, category: group.category, fetched: [] };
    const done = new Set(data.groups[key].fetched);
    const todo = [...series.keys()].filter((qid) => !done.has(qid));
    console.log(`  ${series.size - todo.length} already fetched, ${todo.length} to go.`);

    const skipped = [];
    for (let i = 0; i < todo.length; i += SERIES_CHUNK) {
      const chunk = todo.slice(i, i + SERIES_CHUNK);
      let bySeries;
      try {
        bySeries = await fetchCharactersAdaptive(chunk, skipped);
      } catch (err) {
        // Leaving the chunk unrecorded is what makes a re-run pick it up.
        console.warn(`  ! ${err.message} -- leaving ${chunk.length} series for a later run`);
        save(data);
        continue;
      }

      let found = 0;
      for (const qid of chunk) {
        const chars = bySeries.get(qid);
        if (chars && chars.size) {
          data.series[qid] = {
            label: series.get(qid),
            group: key,
            category: group.category,
            characters: [...chars.values()].sort((a, b) => b.sitelinks - a.sitelinks),
          };
          found += chars.size;
        }
        // A series that was skipped stays out of the resume log so a later run retries it.
        if (!skipped.includes(qid)) done.add(qid);
      }
      data.groups[key].fetched = [...done];
      save(data);

      const at = Math.min(i + SERIES_CHUNK, todo.length);
      const elapsed = (Date.now() - started) / 1000;
      const eta = ((todo.length - at) / Math.max(at, 1)) * elapsed;
      console.log(
        `  ${at}/${todo.length} series -- ${found} characters this chunk` +
          `${eta > 0 ? ` (~${Math.round(eta / 60)}m left in this group)` : ''}`
      );
    }
  }

  // The two clean-up passes run last, over everything in the file, so they also fix up rows
  // written by earlier interrupted runs.
  console.log(`\nPruning episodes, seasons and anime from ${Object.keys(data.series).length} series...`);
  const dropped = await pruneUnwanted(data);
  console.log(`  dropped ${dropped.episodes} episode(s)/season(s), ${dropped.anime} anime (AniList covers those).`);
  save(data);

  console.log('Deriving categories from each series\' own type...');
  const recategorised = await deriveCategories(data);
  console.log(`  recategorised ${recategorised}.`);
  save(data);

  console.log('Resolving video game franchises via "part of the series"...');
  const franchiseTagged = await resolveFranchises(data);
  console.log(`  tagged ${franchiseTagged}.`);
  save(data);

  const all = Object.values(data.series).flatMap((s) => s.characters);
  const unique = [...new Map(all.map((c) => [c.qid, c])).values()];
  console.log(`\nResolving common names for ${unique.length} characters...`);
  await attachCommonNames(unique, (at, total) => {
    if (at % 1000 < ENTITY_CHUNK || at === total) console.log(`  ${at}/${total}`);
  });
  save(data);

  const seriesCount = Object.keys(data.series).length;
  console.log(
    `\nDone in ${Math.round((Date.now() - started) / 60000)}m. ` +
      `${seriesCount} series with characters, ${unique.length} distinct characters.`
  );
  console.log(`Written to ${path.relative(process.cwd(), OUT_PATH)}.`);
}

module.exports = { SOURCE_GROUPS, OUT_PATH };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
