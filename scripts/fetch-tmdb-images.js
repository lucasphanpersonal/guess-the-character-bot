// Fills in missing LIVE-ACTION character artwork from TMDB.
//
//   node scripts/fetch-tmdb-images.js <guildId> --category="Television Shows" --dry-run
//   node scripts/fetch-tmdb-images.js <guildId> --category=Movies --lists=5 --verbose
//
// Why this exists alongside fetch-fandom-images.js: the Fandom pass reached only 36% of
// Television Shows and 39% of Movies, and the reason was not bad matching -- where a wiki was
// found the hit rate was ~65-69%. It was DISCOVERY. 173 of 314 TV lists and 96 of 155 Movie
// lists had no findable wiki at all, so ~3,400 characters were never even asked about. TMDB's
// coverage of film and television is close to total, which is exactly the gap.
//
// It is deliberately restricted to live action, for the reason src/core/util/characterImages.js
// gives: TMDB's per-character image is the ACTOR's photo, and for live action a photograph of
// the actor genuinely is the character's canonical look. For animation no photograph can be
// right -- a voice actor's headshot is the "Woody as a theme-park mascot" failure in a new
// costume. Two guards enforce that rather than trusting the caller:
//
//   1. Categories in DRAWN_MEDIA (Cartoon, Video Games) are refused outright.
//   2. Animated TITLES are skipped even inside a live-action category, because the seeder files
//      Pixar/Disney/DreamWorks films under "Movies" next to live-action ones. TMDB's own genre
//      16 (Animation) settles it per title, so this is a property of the work rather than a
//      guess about the name.
//
// A known ambiguity, measured rather than assumed: for a title with both an animated original
// and a live-action remake (Cinderella, The Jungle Book, The BFG, Moana), TMDB's top hit is
// usually the remake. That is normally CORRECT here -- the Wikidata seeder swept Disney's film
// catalogue, remakes included, and those lists really are the live-action casts (their character
// names are live-action credit listings like "Lord Veneering" and "Palace Staff #1"). Where the
// list is actually the animated original, the cast simply fails to match and almost nothing is
// written, so the failure mode is a near-miss rather than a wrong face. Spot-check a title with
// both versions after a run if you want certainty.
//
// One search + one credits call per LIST, not per character -- the credits response carries the
// whole cast -- so this runs in minutes where the Fandom pass took hours.

require('dotenv').config();

const db = require('../src/core/db/connection');
const { setCharacterImage } = require('../src/core/db/characterLists');
const { imageIsTrustworthy, DRAWN_MEDIA } = require('../src/core/util/characterImages');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const ANIMATION_GENRE_ID = 16;
const PAUSE_MS = 120; // TMDB is generous, but there is no reason to hammer it

const args = process.argv.slice(2);
const guildId = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes('--dry-run');
const category = flag('category', 'Television Shows');
const listLimit = Number(flag('lists', 0)) || Infinity;
const verbose = args.includes('--verbose');
const apiKey = process.env.TMDB_API_KEY;

if (require.main === module && !guildId) {
  console.error('Usage: node scripts/fetch-tmdb-images.js <guildId> [--category="Television Shows"] [--dry-run] [--lists=N] [--verbose]');
  process.exit(1);
}
if (require.main === module && !apiKey) {
  console.error(
    'TMDB_API_KEY is not set.\n\n' +
      '  1. Sign in at https://www.themoviedb.org/ and open Settings > API\n' +
      '  2. Request an API key (free; the "Developer" option is instant)\n' +
      '  3. Put it in .env as TMDB_API_KEY=<your key>\n'
  );
  process.exit(1);
}
if (require.main === module && DRAWN_MEDIA.has(category)) {
  console.error(
    `Refusing to run on "${category}".\n\n` +
      'TMDB supplies the ACTOR\'s photograph, which is only the character\'s canonical look for\n' +
      'live action. For drawn media that would store a voice actor\'s headshot -- exactly the\n' +
      'failure src/core/util/characterImages.js exists to prevent. Use fetch-fandom-images.js\n' +
      'for Cartoon and Video Games.'
  );
  process.exit(1);
}

// TV and film are different endpoints; the category tells us which.
const kind = /movie|film/i.test(category) ? 'movie' : 'tv';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Comparable form for titles and names -- same normalisation the Fandom script uses, so the two
// passes agree about what counts as "the same title".
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

// TMDB credits spell roles freely: "Jack Bauer", "Jack Bauer (voice)", "Dr. Gregory House",
// "Self". Normalising both sides and allowing containment catches the honest variations without
// letting "Ed" match "Edward Scissorhands" -- containment needs the shorter side to be
// substantial, and the shortest real names here are 3+ characters.
function creditMatches(want, got) {
  const a = norm(want);
  const b = norm(got);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  // Word-boundary containment, so "han solo" matches "han solo" inside a longer billing but
  // "ron" does not match "rondo".
  return new RegExp(`(^| )${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(long);
}

async function findTitle(name) {
  const data = await getJson(`/search/${kind}`, { query: name, include_adult: 'false' });
  const results = data.results || [];
  if (!results.length) return null;
  const wanted = norm(name);
  // Prefer an exact normalised title match; otherwise take TMDB's own top hit, which is ranked
  // by popularity and is usually right for a franchise name.
  const titleOf = (r) => r.name || r.title || '';
  return results.find((r) => norm(titleOf(r)) === wanted) || results[0];
}

// The whole cast in one call. `aggregate_credits` is the TV equivalent of `credits` and merges
// a role played across seasons, which is what we want for a long-running show.
async function castFor(id) {
  const data = await getJson(`/${kind}/${id}/${kind === 'tv' ? 'aggregate_credits' : 'credits'}`);
  const out = [];
  for (const person of data.cast || []) {
    if (!person.profile_path) continue;
    // TV aggregate credits nest the role(s) under `roles`; film credits use a flat `character`.
    const roles = person.roles?.length ? person.roles.map((r) => r.character) : [person.character];
    for (const role of roles) {
      if (role) out.push({ role, image: IMG + person.profile_path, actor: person.name });
    }
  }
  return out;
}

async function main() {
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

  console.log(
    `${category}: ${lists.reduce((n, l) => n + l.missing, 0)} characters without artwork across ${lists.length} list(s)\n`
  );

  const stats = { lists: 0, noTitle: 0, animated: 0, skipped: 0, checked: 0, found: 0, rejected: 0, missed: 0, written: 0 };
  const samples = [];

  for (const list of lists) {
    stats.lists++;
    const title = await findTitle(list.name).catch(() => null);
    await sleep(PAUSE_MS);

    if (!title) {
      stats.noTitle++;
      stats.skipped += list.missing;
      console.log(`  x ${list.name} - no TMDB match`);
      continue;
    }
    // Guard 2: an animated title inside a live-action category. Skipping the whole title is the
    // right move -- every credit on it is a voice role.
    if ((title.genre_ids || []).includes(ANIMATION_GENRE_ID)) {
      stats.animated++;
      stats.skipped += list.missing;
      console.log(`  - ${list.name} - animated, skipped (voice actors are not the character)`);
      continue;
    }

    const cast = await castFor(title.id).catch(() => []);
    await sleep(PAUSE_MS);

    const characters = db
      .prepare('SELECT id, name FROM characters WHERE list_id = ? AND image_url IS NULL ORDER BY fame IS NULL, fame DESC')
      .all(list.id);

    let found = 0;
    for (const ch of characters) {
      stats.checked++;
      const hit = cast.find((c) => creditMatches(ch.name, c.role));
      if (!hit) {
        stats.missed++;
        if (verbose) console.log(`      . ${ch.name} - no credit`);
        continue;
      }
      if (!imageIsTrustworthy(list.category, hit.image)) {
        stats.rejected++;
        continue;
      }
      stats.found++;
      found++;
      if (samples.length < 20) samples.push({ list: list.name, name: ch.name, actor: hit.actor, image: hit.image });
      if (!dryRun) {
        setCharacterImage(list.id, ch.name, hit.image);
        stats.written++;
      }
    }
    const titleName = title.name || title.title;
    console.log(`  ${found ? 'v' : '.'} ${list.name} -> ${titleName}  ${found}/${characters.length}${list.enabled ? '  (in pool)' : ''}`);
  }

  console.log('\n--- sample of what was matched ---');
  for (const s of samples) console.log(`  ${s.name}  [${s.list}]  played by ${s.actor}\n      ${s.image}`);

  const rate = stats.checked ? ((stats.found / stats.checked) * 100).toFixed(1) : '0.0';
  console.log('\n--- summary ---');
  console.log(`  lists:            ${stats.lists}, of which ${stats.noTitle} had no TMDB match and ${stats.animated} were animated`);
  console.log(`  skipped:          ${stats.skipped}  (characters in those lists -- never asked)`);
  console.log(`  characters asked: ${stats.checked}`);
  console.log(`  artwork found:    ${stats.found}  (${rate}% of those asked)`);
  console.log(`  rejected:         ${stats.rejected}  (failed the trust rule)`);
  console.log(`  no match:         ${stats.missed}  (nobody in the cast matched that name)`);
  console.log(dryRun ? '  written:         0  (dry run)' : `  written:         ${stats.written}`);
}

// Exported for test/tmdb-credit-match.test.js; only actually runs as a script.
module.exports = { creditMatches, norm };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
