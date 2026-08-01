// Fetches official character artwork from AniList's public GraphQL API for the anime/manga
// slice of the Character Codex, and writes the resulting name -> image mapping to
// data/seed/anilist-character-images.json. That JSON is committed, so this network pass only
// needs to run once -- seeding reads the cache (see scripts/seed-anime-images.js), the same
// way data/seed/pokemon-species.json and data/seed/league-of-legends.json work.
//
// Scope: only codex rows that actually land in an Anime/Manga list -- the "Anime" and "Manga"
// category lists, plus every franchise list whose derived category is Anime or Manga. AniList
// has no coverage outside those, so querying the rest would be pure rate-limit burn.
//
// ACCURACY OVER COVERAGE. Character names collide constantly across franchises ("Ash",
// "Sakura", "Rin"), and a wrong portrait actively misleads someone trying to guess, which is
// worse than the plain-text fallback. So every result is cross-checked against the codex row's
// media_source, and anything that doesn't clear the bar in isConfidentMatch() is recorded as
// unmatched rather than guessed at.
//
// Safe to re-run and resumable: rows already present in the cache (matched OR unmatched) are
// skipped, so an interrupted run picks up where it left off. Pass --refetch-unmatched to retry
// the ones that previously failed to match, or --limit N to do a short trial run.
//
// Usage: node scripts/fetch-anilist-images.js [--limit N] [--refetch-unmatched]

const fs = require('fs');
const path = require('path');
const { normalizeLoose, foldDiacritics } = require('../src/util/text');
const {
  FRANCHISE_MIN_CHARACTERS,
  dedupeNamesWithinGroup,
  groupByMediaType,
  buildFranchiseRoots,
  mostCommonMediaType,
} = require('./seed-character-codex');

const API_URL = 'https://graphql.anilist.co';
const CODEX_PATH = path.join(__dirname, '..', 'data', 'seed', 'character-codex.json');
const CACHE_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-character-images.json');

const ANIME_MANGA = new Set(['Anime', 'Manga']);

// AniList currently advertises 90 req/min but has been serving a degraded 30 req/min for a
// while now (the response's x-ratelimit-limit header is authoritative, and we adapt to it
// below). 2.2s between requests keeps us just under 30/min from a cold start; BATCH_SIZE
// characters ride along in each request via GraphQL aliases.
const BATCH_SIZE = 10;
const MIN_REQUEST_INTERVAL_MS = 2200;
const MAX_RETRIES = 5;
// Flush partial progress to disk periodically so an interrupted run isn't wasted.
const CHECKPOINT_EVERY_REQUESTS = 10;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rowKey = (row) => `${row.character_name}||${row.media_source}`;

// ---------------------------------------------------------------------------
// Scope: which codex rows end up in an Anime/Manga list
// ---------------------------------------------------------------------------

// Mirrors the list-building in seed-character-codex.js exactly, so the set of rows we fetch
// art for is precisely the set that seed-anime-images.js will later try to place.
function animeMangaRows(rows) {
  const inScope = new Map();
  const take = (row) => inScope.set(rowKey(row), row);

  for (const [mediaType, groupRows] of groupByMediaType(rows)) {
    if (ANIME_MANGA.has(mediaType)) groupRows.forEach(take);
  }

  const sourceToRoot = buildFranchiseRoots(rows);
  const rowsByFranchise = new Map();
  for (const row of rows) {
    const franchise = sourceToRoot.get(row.media_source);
    if (!franchise) continue;
    if (!rowsByFranchise.has(franchise)) rowsByFranchise.set(franchise, []);
    rowsByFranchise.get(franchise).push(row);
  }
  for (const franchiseRows of rowsByFranchise.values()) {
    if (franchiseRows.length < FRANCHISE_MIN_CHARACTERS) continue;
    const { result } = dedupeNamesWithinGroup(franchiseRows);
    if (result.length < FRANCHISE_MIN_CHARACTERS) continue;
    if (!ANIME_MANGA.has(mostCommonMediaType(franchiseRows))) continue;
    franchiseRows.forEach(take);
  }

  return [...inScope.values()];
}

// ---------------------------------------------------------------------------
// Match confidence
// ---------------------------------------------------------------------------

// Titles are compared as token sequences rather than raw strings so that punctuation and
// subtitle styling don't matter: "NARUTO -ナルト- 疾風伝", "Naruto: Shippuden" and
// "NARUTO: Shippuuden" all reduce to comparable token lists.
function titleTokens(str) {
  return foldDiacritics(str)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

// A codex media_source can carry a disambiguating tag the AniList title won't have
// ("Dragon Ball (Manga)"), so we try the bare title too.
function sourceVariants(mediaSource) {
  const variants = [mediaSource];
  const paren = mediaSource.match(/^(.+) \(([^)]+)\)$/);
  if (paren) variants.push(paren[1]);
  return variants;
}

// 2 = the titles are the same; 1 = one is a leading-token extension of the other, which is how
// sequels and arcs are titled ("Naruto" -> "Naruto: Shippuden", "Bleach" -> "Bleach: Sennen
// Kessen-hen"); 0 = unrelated. Deliberately NOT plain substring matching -- that makes "Air"
// match "Air Gear" and "One" match "One Piece". A single short token is also rejected, since
// two- and three-letter overlaps are noise rather than evidence.
function titleRelation(sourceTitle, candidateTitle) {
  const a = titleTokens(sourceTitle);
  const b = titleTokens(candidateTitle);
  if (!a.length || !b.length) return 0;
  if (a.join(' ') === b.join(' ')) return 2;

  const [shortSide, longSide] = a.length <= b.length ? [a, b] : [b, a];
  if (shortSide.join('').length < 4) return 0;
  for (let i = 0; i < shortSide.length; i++) {
    if (shortSide[i] !== longSide[i]) return 0;
  }
  return 1;
}

function bestMediaMatch(mediaSource, mediaNodes) {
  let best = { tier: 0, title: null };
  for (const node of mediaNodes) {
    const titles = [node.title.romaji, node.title.english, node.title.native].filter(Boolean);
    for (const variant of sourceVariants(mediaSource)) {
      for (const title of titles) {
        const tier = titleRelation(variant, title);
        if (tier > best.tier) best = { tier, title: node.title.english || node.title.romaji };
      }
    }
  }
  return best;
}

// Romanization of Japanese names is inconsistent between sources: AniList writes "Zero
// Kiryuu" and "Kouji", the codex writes "Zero Kiryu" and "Kōji". Folding long vowels down to
// a single letter reconciles all three spellings. Applied to both sides, so the only thing it
// can do is make two spellings agree -- never disagree.
function normalizeRomaji(str) {
  return normalizeLoose(str).replace(/([aeiou])\1+/g, '$1').replace(/ou/g, 'o');
}

// The codex parks a second name in parentheses often enough to matter -- "Lelouch Lamperouge
// (Lelouch vi Britannia)", "Aho Girl (Yoshiko Hanabatake)" -- and either half may be the one
// AniList indexes. Both are treated as legitimate spellings of the same character.
function codexNameVariants(codexName) {
  const variants = [codexName];
  const paren = codexName.match(/^(.+?) \(([^)]+)\)$/);
  if (paren) variants.push(paren[1].trim(), paren[2].trim());
  return variants.filter(Boolean);
}

// 3 = the canonical full name matches outright; 2 = a romanization variant, the native
// spelling, or the same name parts in the other order (the codex sometimes stores "Uzumaki
// Naruto" for AniList's "Naruto Uzumaki"); 1 = only an `alternative` matched, which covers
// nicknames and is by far the weakest signal -- AniList lists "Fox" as an alternative for
// Naruto, so on its own this would happily mis-assign anyone actually named Fox.
function nameMatchTier(codexName, name) {
  let best = 0;
  for (const variant of codexNameVariants(codexName)) {
    const target = normalizeLoose(variant);
    if (!target) continue;
    if (name.full && normalizeLoose(name.full) === target) return 3;

    const romaji = normalizeRomaji(variant);
    if (name.full && romaji && normalizeRomaji(name.full) === romaji) best = Math.max(best, 2);
    if (name.native && normalizeLoose(name.native) === target) best = Math.max(best, 2);

    const sortedTokens = (str) => titleTokens(str).slice().sort().join(' ');
    if (name.full && sortedTokens(name.full) && sortedTokens(name.full) === sortedTokens(variant)) {
      best = Math.max(best, 2);
    }
    for (const alt of name.alternative || []) {
      if (normalizeLoose(alt) === target) best = Math.max(best, 1);
    }
  }
  return best;
}

// The bar: a solid name match plus *some* corroborating media, or -- when the only name we
// matched was a nickname -- an exactly matching title to make up for it. Anything else is
// left for the text-only fallback.
function isConfidentMatch(nameTier, mediaTier) {
  if (nameTier === 0 || mediaTier === 0) return false;
  if (nameTier >= 2) return true;
  return mediaTier === 2;
}

// Used only by the fallback passes, where we searched a single name part because AniList's
// search found nothing for the whole name (it matches stored names, not fuzzily -- "Levi
// Ackerman" returns zero results for the character it stores as plain "Levi"). Accepts a
// candidate whose name is a subset of the codex name's words, e.g. AniList "Levi" for codex
// "Levi Ackerman". That is a much weaker name signal, so the caller additionally demands a
// media match AND that no other candidate in the same response also qualifies.
function isNameSubset(codexName, name) {
  if (!name.full) return false;
  const candidateTokens = titleTokens(name.full).map((t) => normalizeRomaji(t)).filter(Boolean);
  if (!candidateTokens.length) return false;
  for (const variant of codexNameVariants(codexName)) {
    const codexTokens = new Set(titleTokens(variant).map((t) => normalizeRomaji(t)));
    if (candidateTokens.every((t) => codexTokens.has(t))) return true;
  }
  return false;
}

function pickMatch(row, candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate.image || !candidate.image.large) continue;
    const nameTier = nameMatchTier(row.character_name, candidate.name);
    if (!nameTier) continue;
    const media = bestMediaMatch(row.media_source, candidate.media.nodes);
    if (!isConfidentMatch(nameTier, media.tier)) continue;

    const scored = { candidate, nameTier, mediaTier: media.tier, matchedMedia: media.title };
    if (
      !best ||
      scored.nameTier > best.nameTier ||
      (scored.nameTier === best.nameTier && scored.mediaTier > best.mediaTier) ||
      (scored.nameTier === best.nameTier &&
        scored.mediaTier === best.mediaTier &&
        (candidate.favourites || 0) > (best.candidate.favourites || 0))
    ) {
      best = scored;
    }
  }
  return best;
}

// Fallback acceptance. Ambiguity is fatal here rather than something to rank: if two
// candidates both look like a partial-name match from the right franchise, we genuinely can't
// tell which one the codex meant, and guessing is exactly the failure mode we're avoiding.
function pickPartialMatch(row, candidates) {
  const viable = [];
  for (const candidate of candidates) {
    if (!candidate.image || !candidate.image.large) continue;
    if (!isNameSubset(row.character_name, candidate.name)) continue;
    const media = bestMediaMatch(row.media_source, candidate.media.nodes);
    if (!media.tier) continue;
    viable.push({ candidate, nameTier: 2, mediaTier: media.tier, matchedMedia: media.title });
  }
  if (viable.length !== 1) return null;
  return viable[0];
}

// Distinguishes "AniList doesn't know this character" from "AniList knows the name but we
// couldn't tie it to the right franchise" -- the two want different follow-up if coverage is
// ever revisited.
function rejectionReason(row, candidates) {
  if (!candidates.length) return 'not-found';
  return candidates.some((c) => nameMatchTier(row.character_name, c.name)) ? 'no-media-match' : 'no-name-match';
}

// Search terms to try for one codex row, in decreasing order of trustworthiness. `exact` terms
// are scored by pickMatch (full-name equality required); `partial` terms fall back to
// pickPartialMatch. Single name parts are only worth searching when they're long enough to be
// distinctive -- searching "Ken" or "Rin" returns a wall of unrelated characters.
function searchPlan(row) {
  const terms = [];
  const seen = new Set();
  const push = (term, mode) => {
    const key = normalizeLoose(term);
    if (!key || seen.has(key)) return;
    seen.add(key);
    terms.push({ term, mode });
  };

  for (const variant of codexNameVariants(row.character_name)) push(variant, 'exact');

  const tokens = titleTokens(row.character_name);
  if (tokens.length >= 2) {
    push(tokens[tokens.length - 1], 'partial');
    push(tokens[0], 'partial');
  }
  return terms.filter((t) => t.mode === 'exact' || t.term.length >= 4);
}

// ---------------------------------------------------------------------------
// AniList transport
// ---------------------------------------------------------------------------

function buildQuery(batch) {
  const fields =
    'id name { full native alternative } image { large } favourites ' +
    'media(perPage: 10, sort: POPULARITY_DESC) { nodes { title { romaji english native } } }';
  const aliases = batch.map(
    ({ term }, i) => `c${i}: Page(perPage: 6) { characters(search: ${JSON.stringify(term)}, sort: SEARCH_MATCH) { ${fields} } }`
  );
  return `query {\n${aliases.join('\n')}\n}`;
}

let lastRequestAt = 0;
let observedLimit = null;

async function pace() {
  // Keep a floor between requests, widened if AniList reports a tighter per-minute limit than
  // MIN_REQUEST_INTERVAL_MS assumes.
  let interval = MIN_REQUEST_INTERVAL_MS;
  if (observedLimit) interval = Math.max(interval, Math.ceil(60000 / observedLimit) + 100);
  const waitFor = lastRequestAt + interval - Date.now();
  if (waitFor > 0) await sleep(waitFor);
  lastRequestAt = Date.now();
}

async function requestBatch(batch) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await pace();
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query: buildQuery(batch) }),
      });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const backoff = 2000 * 2 ** attempt;
      console.log(`  network error (${err.message}); retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }

    const limitHeader = Number(res.headers.get('x-ratelimit-limit'));
    if (limitHeader > 0 && limitHeader !== observedLimit) {
      observedLimit = limitHeader;
      console.log(`  (AniList reports a rate limit of ${limitHeader} requests/minute)`);
    }

    if (res.status === 429) {
      // Retry-After is in seconds; fall back to a full window if the header is missing.
      const retryAfter = Number(res.headers.get('retry-after')) || 60;
      console.log(`  rate limited; backing off ${retryAfter}s`);
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    if (res.status >= 500) {
      if (attempt === MAX_RETRIES) throw new Error(`AniList returned ${res.status} after ${MAX_RETRIES} retries`);
      const backoff = 2000 * 2 ** attempt;
      console.log(`  AniList returned ${res.status}; retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
      continue;
    }
    if (!res.ok) throw new Error(`AniList returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const body = await res.json();
    // GraphQL can report per-alias errors alongside usable data; only bail if nothing came back.
    if (!body.data) throw new Error(`AniList error: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
    if (body.errors) console.log(`  note: ${body.errors.length} partial GraphQL error(s) in this batch`);

    // Remaining budget is the more reliable signal near the edge of a window.
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    if (Number.isFinite(remaining) && remaining <= 1) {
      console.log('  rate-limit budget exhausted; pausing 60s');
      await sleep(60000);
    }
    return body.data;
  }
  throw new Error('exhausted retries talking to AniList');
}

// ---------------------------------------------------------------------------

function loadCache() {
  if (!fs.existsSync(CACHE_PATH)) return { characters: {}, unmatched: {} };
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  return { characters: cache.characters || {}, unmatched: cache.unmatched || {} };
}

function saveCache(cache) {
  const sortKeys = (obj) =>
    Object.fromEntries(Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0])));
  const payload = {
    source: API_URL,
    note:
      'Character artwork from AniList, keyed by "<character_name>||<media_source>" from ' +
      'data/seed/character-codex.json. Generated by scripts/fetch-anilist-images.js; ' +
      '`unmatched` records rows deliberately left without art (see that script for the bar).',
    generatedAt: new Date().toISOString(),
    characters: sortKeys(cache.characters),
    unmatched: sortKeys(cache.unmatched),
  };
  fs.writeFileSync(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const refetchUnmatched = args.includes('--refetch-unmatched');
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;
  if (!Number.isFinite(limit) && limitArg !== -1) {
    console.error('--limit needs a number, e.g. --limit 50');
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(CODEX_PATH, 'utf8'));
  const scope = animeMangaRows(rows);
  const cache = loadCache();
  if (refetchUnmatched) cache.unmatched = {};

  const todo = scope
    .filter((row) => !cache.characters[rowKey(row)] && !cache.unmatched[rowKey(row)])
    .slice(0, limit === Infinity ? undefined : limit);

  console.log(
    `${scope.length} anime/manga codex rows in scope; ` +
      `${Object.keys(cache.characters).length} already have art, ` +
      `${Object.keys(cache.unmatched).length} previously unmatched.`
  );
  if (!todo.length) {
    console.log('Nothing to fetch. (Use --refetch-unmatched to retry the ones with no match.)');
    saveCache(cache);
    return;
  }

  // Rows are worked in passes: everything gets its primary name searched first, then only the
  // leftovers move on to the next search term. Doing it this way (rather than exhausting every
  // term for one row before starting the next) keeps the expensive fallback searches off the
  // ~70% of rows that match on the first try.
  let pending = todo.map((row) => ({ row, terms: searchPlan(row), reason: 'not-found' }));
  const passes = Math.max(...pending.map((p) => p.terms.length));
  const worstCaseRequests = Math.ceil(todo.length / BATCH_SIZE) * passes;
  console.log(
    `Fetching ${todo.length} characters, up to ${passes} search passes each ` +
      `(<= ${worstCaseRequests} requests, ~${Math.ceil((worstCaseRequests * MIN_REQUEST_INTERVAL_MS) / 60000)} min).`
  );

  let matched = 0;
  let requests = 0;
  for (let pass = 0; pass < passes && pending.length; pass++) {
    const active = pending.filter((p) => p.terms[pass]);
    const carried = pending.filter((p) => !p.terms[pass]);
    console.log(`\n--- Pass ${pass + 1}: ${active.length} characters ---`);

    const stillPending = [];
    for (let i = 0; i < active.length; i += BATCH_SIZE) {
      const batch = active.slice(i, i + BATCH_SIZE);
      const data = await requestBatch(batch.map((p) => ({ term: p.terms[pass].term })));
      requests++;
      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const page = data[`c${j}`];
        const candidates = (page && page.characters) || [];
        const { mode } = entry.terms[pass];
        const best = mode === 'exact' ? pickMatch(entry.row, candidates) : pickPartialMatch(entry.row, candidates);
        if (best) {
          cache.characters[rowKey(entry.row)] = {
            image: best.candidate.image.large,
            anilistId: best.candidate.id,
            anilistName: best.candidate.name.full,
            matchedMedia: best.matchedMedia,
          };
          matched++;
        } else {
          // Keep the most informative reason seen across passes.
          const reason = rejectionReason(entry.row, candidates);
          if (entry.reason === 'not-found' || reason === 'no-media-match') entry.reason = reason;
          stillPending.push(entry);
        }
      }
      if (requests % CHECKPOINT_EVERY_REQUESTS === 0) {
        saveCache(cache);
        console.log(`  ${Math.min(i + BATCH_SIZE, active.length)}/${active.length} this pass -- ${matched} matched overall`);
      }
    }
    pending = [...stillPending, ...carried];
  }

  const reasons = { 'not-found': 0, 'no-name-match': 0, 'no-media-match': 0 };
  for (const entry of pending) {
    cache.unmatched[rowKey(entry.row)] = entry.reason;
    reasons[entry.reason]++;
  }
  saveCache(cache);

  console.log(
    `\nDone in ${requests} requests. Matched ${matched} of ${todo.length}. Left without art: ` +
      `${reasons['not-found']} not on AniList, ${reasons['no-name-match']} no name match, ` +
      `${reasons['no-media-match']} name matched but franchise didn't (skipped as unconfident).`
  );
  console.log(`Cache now holds ${Object.keys(cache.characters).length} images -> ${path.relative(process.cwd(), CACHE_PATH)}`);
}

// Exported for the match-confidence tests in test/anilist-match.test.js -- the name/title
// comparison is the only part of this script worth pinning down, and it's pure.
module.exports = {
  titleRelation,
  nameMatchTier,
  isConfidentMatch,
  isNameSubset,
  pickMatch,
  pickPartialMatch,
  searchPlan,
  animeMangaRows,
  rowKey,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
