// Fills in missing LIVE-ACTION character artwork from TMDB.
//
//   node scripts/fetch-tmdb-images.js --category="Television Shows" --dry-run
//   node scripts/fetch-tmdb-images.js --category=Movies --lists=5 --verbose
//
// Why this exists alongside fetch-fandom-images.js: the Fandom pass reached only 36% of
// Television Shows and 39% of Movies, and the reason was not bad matching -- where a wiki was
// found the hit rate was ~65-69%. It was DISCOVERY. 173 of 314 TV lists and 96 of 155 Movie
// lists had no findable wiki at all, so ~3,400 characters were never even asked about. TMDB's
// coverage of film and television is close to total, which is exactly the gap.
//
// It is deliberately restricted to live action, for the reason src/compendium/characterImages.js
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
// A title with both an animated original and a live-action remake of the same name (Moana, Lady
// and the Tramp) is SKIPPED. The list's name cannot say which one it is, and guessing the remake
// once put live-action faces on the animated film's characters. A remake with a distinct title
// is unaffected. Within a title, a character with any voice credit gets no photo at all, and
// neither does a role one actor shares with other parts (puppeteers, multi-role players).
//
// One search + one credits call per LIST, not per character -- the credits response carries the
// whole cast -- so this runs in minutes where the Fandom pass took hours.

require('dotenv').config();

const db = require('../src/compendium/db');
const { setCharacterImage } = require('../src/compendium/characterLists');
const { imageIsTrustworthy, DRAWN_MEDIA } = require('../src/compendium/characterImages');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w500';
const ANIMATION_GENRE_ID = 16;
const PAUSE_MS = 120; // TMDB is generous, but there is no reason to hammer it

// Every list in the category, shared or private, is in reach; lists some scope actually plays
// with go first, since that is where a missing picture is seen.
const args = require('./lib/compendiumArgs').scriptArgs();
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes('--dry-run');
const category = flag('category', 'Television Shows');
const listLimit = Number(flag('lists', 0)) || Infinity;
const verbose = args.includes('--verbose');
const apiKey = process.env.TMDB_API_KEY;

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
      'failure src/compendium/characterImages.js exists to prevent. Use fetch-fandom-images.js\n' +
      'for Cartoon and Video Games.'
  );
  process.exit(1);
}

// TV and film are different endpoints; the category tells us which.
const kind = /movie|film/i.test(category) ? 'movie' : 'tv';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every lookup ends one of three ways: an answer, a definite no, or no answer at all. A definite
// no is a 404/410, or an HTML page where JSON was asked for (how a wiki host answers for a wiki
// that does not exist). No answer -- a 429, a 5xx, a timeout, a dropped connection -- says
// nothing about whether the art exists, so it is counted apart and reported, instead of being
// folded silently into "no match". A rate-limited run used to read exactly like a run that
// found nothing. (The same three-way rule as check-image-urls.js.)
const unanswered = new Map(); // reason -> count
function couldNotTell(err) {
  const status = /HTTP (\d+)/.exec(err?.message ?? '')?.[1];
  if (status === '404' || status === '410' || err?.name === 'SyntaxError') return null; // a definite no
  const reason = status ? `HTTP ${status}` : err?.name || 'error';
  unanswered.set(reason, (unanswered.get(reason) ?? 0) + 1);
  return null;
}
function reportUnanswered() {
  const total = [...unanswered.values()].reduce((a, b) => a + b, 0);
  if (!total) return;
  const why = [...unanswered].map(([reason, n]) => `${reason} x${n}`).join(', ');
  console.log(`  NO ANSWER:        ${total} lookup(s) (${why})`);
  console.log('                    Counted above as "no match" only because no answer came -- re-run to retry them.');
}

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
  const esc = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^| )${esc}( |$)`).test(long)) return false;
  // ...but not as a possessive. "Jock's Owner" is somebody named after Jock, not Jock -- matching
  // it gave the dogs in Lady and the Tramp their owners' faces, and "Danish Boy" inside "Danish
  // Boy's Father" gave the father the boy's. After norm() the apostrophe is a space: "jock s".
  return !new RegExp(`(^| )${esc} s( |$)`).test(long);
}

async function findTitle(name) {
  const data = await getJson(`/search/${kind}`, { query: name, include_adult: 'false' });
  const results = data.results || [];
  if (!results.length) return null;
  const wanted = norm(name);
  const titleOf = (r) => r.name || r.title || '';
  const exact = results.filter((r) => norm(titleOf(r)) === wanted);
  // An animated original AND a live-action version under the same name (Moana, Lady and the
  // Tramp, The Lion King) is a list we cannot place: their characters share names, so whichever
  // version was meant, the live-action cast MATCHES -- and a remake's human cast is the wrong
  // face for the cartoon, while the remake's dogs are voiced and have no face at all. The earlier
  // assumption that such a list "simply fails to match" was measured false: the 2026 Moana gave
  // the animated Moana's fisherman a live-action photo. So write nothing, and leave the list to
  // fetch-fandom-images, whose wiki art is right for either version.
  const animated = (r) => (r.genre_ids || []).includes(ANIMATION_GENRE_ID);
  if (exact.some(animated) && exact.some((r) => !animated(r))) return { ambiguous: true, name: titleOf(exact[0]) };
  // Prefer an exact normalised title match; otherwise take TMDB's own top hit, which is ranked
  // by popularity and is usually right for a franchise name.
  return exact[0] || results[0];
}

// The whole cast in one call. `aggregate_credits` is the TV equivalent of `credits` and merges
// a role played across seasons, which is what we want for a long-running show.
/**
 * The cast as one entry per role, each carrying the performer's photo -- which is only the
 * character's look when that performer IS the character on screen.
 *
 * Two ways it isn't, both found in a dry run before they were ever written:
 *   - Several characters, one photo. Sesame Street credits Jim Henson as Ernie, Guy Smiley and
 *     half the cast, so Ernie's "artwork" would have been Jim Henson. One performer carrying
 *     several roles in a title is a puppeteer, a voice artist or a multi-role player, and in
 *     none of those cases is their headshot what any one of the characters looks like. So a
 *     photo credited against more than one role is marked `shared`, and never used.
 *   - A voice part in a live-action title ("Groot (voice)"). The animation rule in miniature.
 */
async function castFor(id) {
  const data = await getJson(`/${kind}/${id}/${kind === 'tv' ? 'aggregate_credits' : 'credits'}`);
  const out = [];
  // Characters with a VOICE credit in this title. Such a character is voiced -- a dog, a toy, a
  // CGI creature -- and no on-screen person's photo is ever its look, whoever else's credit
  // happens to contain its name. Collected before the no-photo skip below, so a voice artist
  // without a headshot still marks their character as voiced.
  const voiced = new Set();
  for (const person of data.cast || []) {
    // TV aggregate credits nest the role(s) under `roles`; either kind can also pack several
    // parts into one string, with or without spaces -- Sesame Street's is literally
    // "Ernie/Kermit the Frog/Guy Smiley". Splitting on a bare slash can break a name that
    // genuinely contains one, but that can only ever REJECT a photo, never add a wrong one.
    // A "(voice)" tag belongs to the whole credit, not the last part it happens to sit on:
    // Disenchanted's "Pip / Cat Pip (voice)" voices BOTH, and reading it per part gave the
    // chipmunk his voice actor's face.
    const roles = (person.roles?.length ? person.roles.map((r) => r.character) : [person.character])
      .flatMap((credit) => {
        const voice = /\bvoices?\b/i.test(String(credit ?? ''));
        return String(credit ?? '').split(/\s*\/\s*/).map((r) => ({ name: r.trim(), voice }));
      })
      .filter((r) => r.name);
    for (const r of roles) if (r.voice) voiced.add(norm(r.name));
    if (!person.profile_path) continue;
    const spoken = roles.filter((r) => !r.voice).map((r) => r.name);
    const distinct = new Set(spoken.map(norm)).size;
    for (const role of spoken) {
      out.push({ role, image: IMG + person.profile_path, actor: person.name, shared: distinct > 1 });
    }
  }
  return Object.assign(out, { voiced });
}

async function main() {
  const lists = db
    .prepare(
      `SELECT cl.id, cl.name, cl.category,
              EXISTS (SELECT 1 FROM list_selection s WHERE s.list_id = cl.id) AS enabled,
              COUNT(ch.id) AS missing
         FROM character_lists cl
         JOIN characters ch ON ch.list_id = cl.id
        WHERE COALESCE(cl.category, 'Uncategorised') = ? AND ch.image_url IS NULL
        GROUP BY cl.id
        ORDER BY enabled DESC, cl.popularity IS NULL, cl.popularity DESC`
    )
    .all(category)
    .slice(0, listLimit);

  console.log(
    `${category}: ${lists.reduce((n, l) => n + l.missing, 0)} characters without artwork across ${lists.length} list(s)\n`
  );

  const stats = { lists: 0, noTitle: 0, animated: 0, skipped: 0, checked: 0, found: 0, rejected: 0, missed: 0, written: 0 };
  const samples = [];

  for (const list of lists) {
    stats.lists++;
    const title = await findTitle(list.name).catch(couldNotTell);
    await sleep(PAUSE_MS);

    if (!title) {
      stats.noTitle++;
      stats.skipped += list.missing;
      console.log(`  x ${list.name} - no TMDB match`);
      continue;
    }
    if (title.ambiguous) {
      stats.animated++;
      stats.skipped += list.missing;
      console.log(`  - ${list.name} - animated original AND live-action version exist; cannot tell which, skipped`);
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

    // Shaped like castFor's answer (an array carrying .voiced): the old fallback of a bare [] had no
    // .voiced, so one failed cast lookup crashed the run on the next line.
    const cast = await castFor(title.id).catch((err) => (couldNotTell(err), Object.assign([], { voiced: new Set() })));
    await sleep(PAUSE_MS);

    const characters = db
      .prepare('SELECT id, name FROM characters WHERE list_id = ? AND image_url IS NULL ORDER BY fame IS NULL, fame DESC')
      .all(list.id);

    // One picture never goes to two different characters in a list -- see fetch-fandom-images.
    const used = new Set(
      db.prepare('SELECT image_url FROM characters WHERE list_id = ? AND image_url IS NOT NULL').all(list.id).map((r) => r.image_url)
    );

    let found = 0;
    for (const ch of characters) {
      stats.checked++;
      if (cast.voiced.has(norm(ch.name))) {
        stats.rejected++;
        if (verbose) console.log(`      x ${ch.name} - voiced in this title; no on-screen photo is this character`);
        continue;
      }
      // An exact credit first, containment only as a fallback. Containment alone found "Danish
      // Boy" inside "Danish Boy's Father" and "Danish Boy's Mother", and gave both parents the
      // boy's photo; each of them has an exact credit of their own.
      const hit =
        cast.find((c) => norm(c.role) === norm(ch.name)) ?? cast.find((c) => creditMatches(ch.name, c.role));
      if (!hit) {
        stats.missed++;
        if (verbose) console.log(`      . ${ch.name} - no credit`);
        continue;
      }
      if (!imageIsTrustworthy(list.category, hit.image)) {
        stats.rejected++;
        continue;
      }
      if (hit.shared) {
        stats.rejected++;
        if (verbose) console.log(`      x ${ch.name} - ${hit.actor} plays several roles here; their photo is not this one`);
        continue;
      }
      if (used.has(hit.image)) {
        stats.rejected++;
        if (verbose) console.log(`      x ${ch.name} - already another character's picture in this list`);
        continue;
      }
      used.add(hit.image);
      stats.found++;
      found++;
      if (samples.length < 20) samples.push({ list: list.name, name: ch.name, actor: hit.actor, image: hit.image });
      if (!dryRun) {
        setCharacterImage(list.id, ch.name, hit.image);
        stats.written++;
      }
    }
    const titleName = title.name || title.title;
    console.log(`  ${found ? 'v' : '.'} ${list.name} -> ${titleName}  ${found}/${characters.length}${list.enabled ? '  (selected somewhere)' : ''}`);
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
  reportUnanswered();
}

// Exported for test/tmdb-credit-match.test.js; only actually runs as a script.
module.exports = { creditMatches, norm };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
