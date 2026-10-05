// Builds data/seed/anilist-characters.json -- full casts for the most popular anime and
// manga, from AniList's GraphQL API. No API key.
//
// WHY THIS EXISTS
// The anime and manga lists came from the Character Codex, and for this genre the codex is
// not merely thin, it is wrong. One Piece arrived with fourteen entries that included FOUR
// spellings of Luffy ("Luffy", "Luffy (Monkey D. Luffy)", "Luffy D. Monkey", "Monkey D.
// Luffy"), three of Chopper, and Eiichiro Oda -- the author -- as if he were a character,
// while Zoro, Nami, Sanji and Usopp were all missing. AniList lists 500+ One Piece
// characters, each with artwork and a favourites count.
//
// scripts/fetch-anilist-images.js already talks to AniList, but only to attach artwork to
// codex characters; it adds nobody. This script is the roster source that was missing.
//
// WHAT GETS FETCHED
// Series are taken in popularity order rather than searched for by name, which sidesteps
// AniList's fuzzy search (searching "Demon Slayer" returns a game called "Onigiri") and
// gives exactly the "media that makes sense" end of the catalogue.
//
// Every character of every series taken is fetched -- all 500+ of One Piece's, not a
// sample -- along with its AniList role and favourites count. Nothing is filtered here
// beyond adult titles: this file is the complete record, and
// scripts/seed-anilist-characters.js decides how deep to go when it imports, so the depth
// can be retuned without paying for another fetch.
//
// COST AND RESUMABILITY
// One request returns ten series, or one page of 25 characters for a single series. Deep
// shows therefore cost a request per 25 characters, and AniList's rate limit is the binding
// constraint, so the run takes a while. It is resumable: the output file records which
// series are fully paged, so Ctrl-C and re-run only costs the series in flight.
//
// Usage:
//   node scripts/fetch-anilist-characters.js                 # anime + manga, default depth
//   node scripts/fetch-anilist-characters.js --pages 40      # 40 pages of each (10/page)
//   node scripts/fetch-anilist-characters.js --type ANIME
//   node scripts/fetch-anilist-characters.js --refresh

const fs = require('fs');
// Resume file = committed seed data: never leave it half-written (see the helper).
const { writeFileAtomic } = require('./lib/writeAtomic');
const path = require('path');

const API = 'https://graphql.anilist.co';
const OUT_PATH = path.join(__dirname, '..', 'data', 'seed', 'anilist-characters.json');

// AniList allows 10 media per page, and 25 characters per media in the same request -- so
// one request covers ten shows completely. 60 pages is 600 titles per type.
const MEDIA_PER_PAGE = 10;
const CHARS_PER_MEDIA = 25;
const DEFAULT_PAGES = 60;
// AniList's documented limit is 90 requests/minute and has been running degraded at 30, so
// pace at roughly 1/second and obey Retry-After whenever it says otherwise.
const PACE_MS = 1100;
const MAX_RETRIES = 5;

const QUERY = `query ($page: Int, $type: MediaType, $perPage: Int, $charPerPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(sort: POPULARITY_DESC, type: $type, isAdult: false) {
      id
      title { romaji english }
      format
      popularity
      genres
      characters(sort: FAVOURITES_DESC, perPage: $charPerPage) {
        pageInfo { hasNextPage }
        edges {
          role
          node {
            id
            name { first middle last full }
            favourites
            image { large }
          }
        }
      }
    }
  }
}`;

// Pages the rest of one series' cast, for the deep shows where 25 is nowhere near enough.
const CAST_QUERY = `query ($id: Int, $page: Int, $perPage: Int) {
  Media(id: $id) {
    characters(sort: FAVOURITES_DESC, page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      edges {
        role
        node {
          id
          name { first middle last full }
          favourites
          image { large }
        }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(2000 * 2 ** attempt);
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? (retryAfter + 1) * 1000 : 60000;
      console.warn(`    rate limited -- waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      if (attempt >= MAX_RETRIES) throw new Error(`AniList returned ${res.status}`);
      await sleep(2000 * 2 ** attempt);
      continue;
    }

    const body = await res.json();
    if (body.errors) {
      // A page past the end of the catalogue reports an error rather than an empty page.
      throw new Error(body.errors.map((e) => e.message).join('; '));
    }
    // The whole data object, since the two queries root at Page and Media respectively.
    return body.data;
  }
}

/**
 * AniList stores names in Western order, so `full` reads "Luffy Monkey" and "Robin Nico".
 * Rebuilding them surname-first restores the form these characters are actually known by:
 * "Monkey D. Luffy", "Nico Robin", "Roronoa Zoro", "Tony Tony Chopper", "Portgas D. Ace".
 *
 * Mononyms ("Nami", "Gaara") have an empty or missing surname and are left exactly as they
 * are -- reordering a one-part name is how you get a blank.
 */
function displayName(name) {
  const last = (name.last || '').trim();
  const first = (name.first || '').trim();
  const middle = (name.middle || '').trim();
  if (!last || !first) return (name.full || first || last || '').trim();
  return [last, middle, first].filter(Boolean).join(' ');
}

// Belt and braces alongside isAdult:false -- a handful of ecchi titles are not flagged
// adult but are still not what anyone wants dealt to them mid-game.
const BLOCKED_GENRES = new Set(['Hentai', 'Ecchi']);

function toCast(edges) {
  return edges
    .map((e) => ({
      name: displayName(e.node.name),
      favourites: e.node.favourites || 0,
      role: e.role,
      image: e.node.image?.large || null,
    }))
    .filter((c) => c.name);
}

function load(refresh) {
  if (refresh || !fs.existsSync(OUT_PATH)) {
    return { source: 'AniList GraphQL (top titles by popularity, characters by favourites)', series: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  parsed.series = parsed.series || {};
  return parsed;
}

function save(data) {
  data.updatedAt = new Date().toISOString().slice(0, 10);
  const series = Object.fromEntries(Object.entries(data.series).sort(([a], [b]) => (Number(a) - Number(b))));
  writeFileAtomic(OUT_PATH, `${JSON.stringify({ ...data, series }, null, 0)}\n`);
}

function parseArgs(argv) {
  const opts = { pages: DEFAULT_PAGES, types: ['ANIME', 'MANGA'], refresh: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pages') opts.pages = Number(argv[++i]);
    else if (arg === '--type') opts.types = [String(argv[++i]).toUpperCase()];
    else if (arg === '--refresh') opts.refresh = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!Number.isInteger(opts.pages) || opts.pages < 1) throw new Error('--pages needs a positive integer');
  for (const t of opts.types) {
    if (t !== 'ANIME' && t !== 'MANGA') throw new Error(`--type must be ANIME or MANGA, got ${t}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const data = load(opts.refresh);
  const started = Date.now();

  for (const type of opts.types) {
    console.log(`\n=== ${type}: top ${opts.pages * MEDIA_PER_PAGE} by popularity ===`);
    let kept = 0;
    let characters = 0;

    for (let page = 1; page <= opts.pages; page++) {
      let result;
      try {
        result = (await gql(QUERY, { page, type, perPage: MEDIA_PER_PAGE, charPerPage: CHARS_PER_MEDIA })).Page;
      } catch (err) {
        console.warn(`  ! page ${page} failed (${err.message}) -- stopping this type`);
        break;
      }

      for (const media of result.media) {
        if ((media.genres || []).some((g) => BLOCKED_GENRES.has(g))) continue;
        // Already fully paged by an earlier run.
        if (data.series[media.id]?.complete) continue;

        const cast = toCast(media.characters?.edges || []);
        let more = media.characters?.pageInfo?.hasNextPage;

        // Page the rest of the cast. One Piece needs twenty of these; most shows need none.
        for (let cp = 2; more; cp++) {
          await sleep(PACE_MS);
          let next;
          try {
            next = await gql(CAST_QUERY, { id: media.id, page: cp, perPage: CHARS_PER_MEDIA });
          } catch (err) {
            console.warn(`  ! ${media.title.romaji} cast page ${cp} failed (${err.message})`);
            break;
          }
          cast.push(...toCast(next.Media.characters.edges));
          more = next.Media.characters.pageInfo.hasNextPage;
        }

        if (cast.length < 3) continue;
        data.series[media.id] = {
          label: media.title.english || media.title.romaji,
          romaji: media.title.romaji,
          category: type === 'ANIME' ? 'Anime' : 'Manga',
          format: media.format,
          popularity: media.popularity,
          complete: !more,
          characters: cast,
        };
        kept++;
        characters += cast.length;
      }

      save(data);
      if (page % 10 === 0 || page === opts.pages) {
        console.log(`  page ${page}/${opts.pages} -- ${kept} titles, ${characters} characters so far`);
      }
      if (!result.pageInfo.hasNextPage) {
        console.log(`  reached the end of the catalogue at page ${page}.`);
        break;
      }
      await sleep(PACE_MS);
    }
  }

  const all = Object.values(data.series);
  console.log(
    `\nDone in ${Math.round((Date.now() - started) / 60000)}m. ` +
      `${all.length} titles, ${all.reduce((a, s) => a + s.characters.length, 0)} character entries.`
  );
  console.log(`Written to ${path.relative(process.cwd(), OUT_PATH)}.`);
}

module.exports = { displayName, OUT_PATH };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
