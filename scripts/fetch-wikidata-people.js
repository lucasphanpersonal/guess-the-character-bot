// Builds data/seed/wikidata-people.json -- famous REAL people, grouped by what they are best
// known for, for a category the bot had nothing in: actors, athletes, scientists, politicians,
// religious figures and the rest.
//
// SOURCE
// Wikidata's SPARQL endpoint, the same one the fictional-character fetcher uses. No API key.
//
//   ?p wdt:P31 wd:Q5        instance of human
//   ?p wdt:P106 wd:<QID>    occupation
//   ?p wikibase:sitelinks ?n    how many language Wikipedias have an article on them
//
// Sitelinks are the fame signal, and for real people they are a good one: Barack Obama has
// 340, Michael Jordan 130, and someone with 12 is a person you have never heard of. The same
// number already ranks the Wikidata-sourced fictional characters, so it needs no new concept.
//
// PHOTOGRAPHS ARE THE EASY CASE HERE
// src/util/characterImages.js exists because Wikidata's image property answers "an image
// associated with this item", which for a fictional character gives you the actor, a
// cosplayer or a wax figure. For a real person that same property gives you a photograph of
// the person, which is exactly right -- 99% of what this fetches arrives with one.
//
// ONE PERSON, ONE LIST
// Wikidata gives Ronald Reagan both "politician" and "actor", and Albert Camus both "writer"
// and "association football player" (he kept goal for Racing Universitaire d'Alger). Rather
// than ask the query to resolve that -- which is what made it time out -- GROUPS is in
// priority order and the seeder gives each person to the first list that claims them.
//
// COST
// The endpoint is slow and flaky at this size: a query for every politician above 90
// sitelinks times out, while [90,130) and [130,500) each answer in about 40s. So a heavy
// occupation falls back to narrow sitelink bands -- see the note on bands(), and note that
// bisecting the range does NOT work, which was the first thing tried.
//
// NO CAP IS APPLIED HERE. Everything above a group's floor is written, with its sitelink
// count, and the trimming happens at seed time where it can be retuned without refetching.
//
// Usage:
//   node scripts/fetch-wikidata-people.js                 # everything still missing
//   node scripts/fetch-wikidata-people.js --group actors  # one group
//   node scripts/fetch-wikidata-people.js --list-groups
//   node scripts/fetch-wikidata-people.js --refresh       # ignore what is already there

const fs = require('fs');
const path = require('path');

const SPARQL = 'https://query.wikidata.org/sparql';
const USER_AGENT =
  'guess-the-character-bot/1.0 (Discord party game; https://github.com/lucasphanpersonal/guess-the-character-bot)';
const OUT_PATH = path.join(__dirname, '..', 'data', 'seed', 'wikidata-people.json');

// Nobody has more than ~350 sitelinks, so this is the top of the range a band can cover.
const SITELINK_CEILING = 500;
const PAUSE_MS = 2000; // the endpoint is shared; this is roughly a 50% duty cycle at these times

/**
 * In priority order -- the first group to claim somebody keeps them.
 *
 * Politicians lead deliberately: Reagan and Trump are both filed as actors by Wikidata, and a
 * server that switches off Politicians to avoid arguments would be surprised to meet them
 * again under Actors. Specific sports come before the general athlete catch-all for the same
 * reason.
 *
 * `min` is a floor on sitelinks, tuned per group because the distributions are nothing alike:
 * 70 sitelinks is a merely notable actor and a world-historic scientist.
 */
const GROUPS = [
  { key: 'politicians', list: 'Politicians & Leaders', min: 90, qids: ['Q82955', 'Q48352', 'Q116'] },
  { key: 'religious', list: 'Religious Figures', min: 40, qids: ['Q43115', 'Q42603', 'Q1234713'] },
  { key: 'scientists', list: 'Scientists & Inventors', min: 35, qids: ['Q901', 'Q169470', 'Q170790', 'Q593644', 'Q864503', 'Q205375'] },
  // Deliberately NOT the broad "writer" (Q36180): it covers anyone who ever wrote a
  // screenplay, which files Charlie Chaplin under Writers & Philosophers. Novelist, poet,
  // playwright and philosopher keep Shakespeare and Camus and let Chaplin go where he belongs.
  { key: 'writers', list: 'Writers & Philosophers', min: 55, qids: ['Q6625963', 'Q49757', 'Q214917', 'Q4964182'] },
  { key: 'artists', list: 'Artists', min: 45, qids: ['Q1028181', 'Q1281618', 'Q483501'] },
  { key: 'explorers', list: 'Explorers & Astronauts', min: 25, qids: ['Q11631', 'Q11900058'] },

  // Sport before the performing arts. An athlete who turned up in a film is still an athlete
  // -- Wikidata files Maradona as an actor and Kobe Bryant as a screenwriter (he won an Oscar
  // for one), and both led the wrong list before this. The reverse mistake exists too, but it
  // is rarer: far more athletes appear on screen than actors play professional sport.
  { key: 'footballers', list: 'Footballers', min: 55, qids: ['Q937857'] },
  { key: 'basketball', list: 'Basketball Players', min: 30, qids: ['Q3665646'] },
  { key: 'tennis', list: 'Tennis Players', min: 28, qids: ['Q10833314'] },
  { key: 'motorsport', list: 'Racing Drivers', min: 22, qids: ['Q10841764'] },
  { key: 'icehockey', list: 'Ice Hockey Players', min: 18, qids: ['Q11774891'] },
  { key: 'athletes', list: 'Athletes', min: 40, qids: ['Q2066131'] },

  // Comedians before actors, so the list keeps the people it exists for: Chaplin, Robin
  // Williams and Jim Carrey are all filed as both, and Comedians led by its supporting cast
  // would be the weaker of the two lists.
  { key: 'comedians', list: 'Comedians', min: 30, qids: ['Q245068'] },
  { key: 'musicians', list: 'Musicians & Singers', min: 50, qids: ['Q177220', 'Q639669', 'Q2252262'] },
  { key: 'actors', list: 'Actors', min: 60, qids: ['Q33999', 'Q10800557'] },
  // Musicians before BOTH actors and composers.
  //
  // Before composers because the two are indistinguishable from the data -- Michael Jackson
  // and Mozart carry exactly the same pair of occupations -- and Mozart in Musicians reads
  // far better than Michael Jackson at the top of Composers.
  //
  // Before actors because measuring it settled an argument two examples could not. Actors
  // first looks right from Marilyn Monroe alone, but it drags Shakira, Madonna, Louis
  // Armstrong, Eminem and Beyoncé into the top ten of Actors. This way round Actors reads
  // Jolie, Bruce Lee, Jackie Chan, Brando, DiCaprio, Pitt -- and the whole price is Monroe
  // and Marlene Dietrich filed as singers, which they also were.
  // These three sit AFTER the performing arts, unlike the sports above, because their tag is
  // a biographical footnote for a lot of famous Americans rather than what they are known
  // for: John Wayne, Dwayne Johnson and Burt Reynolds all played college football, Bing
  // Crosby and Will Ferrell are filed as baseball players, Dean Martin as a boxer. Moving a
  // sport later only affects people who are ALSO something else -- Muhammad Ali is tagged
  // nothing but boxer, so he stays put either way.
  { key: 'boxers', list: 'Boxers', min: 28, qids: ['Q11338576'] },
  { key: 'americanfootball', list: 'American Football Players', min: 18, qids: ['Q19204627'] },
  { key: 'baseball', list: 'Baseball Players', min: 22, qids: ['Q10871364'] },
  { key: 'composers', list: 'Composers', min: 45, qids: ['Q36834'] },
  { key: 'filmmakers', list: 'Directors & Screenwriters', min: 45, qids: ['Q2526255', 'Q28389', 'Q3387717'] },
  { key: 'business', list: 'Business & Tech', min: 45, qids: ['Q43845', 'Q131524'] },
];

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function peopleQuery(qid, lo, hi) {
  return `SELECT ?p ?pLabel ?sitelinks ?img WHERE {
  ?p wdt:P31 wd:Q5 ; wdt:P106 wd:${qid} ; wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${lo} && ?sitelinks < ${hi})
  OPTIONAL { ?p wdt:P18 ?img }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`;
}

async function runSparql(query) {
  const url = `${SPARQL}?format=json&query=${encodeURIComponent(query)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/sparql-results+json' },
        signal: AbortSignal.timeout(75000),
      });
      if (res.ok) return (await res.json()).results.bindings;
      throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // 504 usually means the query was too expensive, but the endpoint also throws it under
      // load -- the same query that fails once can succeed a minute later. Retry either way
      // and let the caller narrow the range only if retrying does not help.
      if (attempt === 3) throw err;
      await sleep(PAUSE_MS * attempt * 3);
    }
  }
  return [];
}

/**
 * Ascending sitelink bands, narrow at the bottom and open-ended at the top.
 *
 * Bisection was the obvious approach and it does not work here: sitelink counts are
 * exponentially distributed, so halving [90,500) leaves essentially the whole population in
 * the lower half and the query is no cheaper. Measured, [90,130) and [130,500) both answer in
 * about 40s while [90,500) times out every time -- the cost tracks how many humans match, and
 * only a narrow band near the floor actually reduces that.
 */
function bands(min) {
  const edges = [];
  for (let x = min; x < 200; x += 20) edges.push(x);
  edges.push(200, SITELINK_CEILING);
  return edges.slice(0, -1).map((lo, i) => [lo, edges[i + 1]]);
}

/**
 * Everyone in one occupation above a floor.
 *
 * Tries the whole range in one query first, because most occupations answer that way in a few
 * seconds and banding them would be twenty requests for no benefit. Only the heavy ones --
 * politician, association football player -- fall through to the bands.
 */
async function fetchOccupation(qid, min) {
  try {
    const rows = await runSparql(peopleQuery(qid, min, SITELINK_CEILING));
    await sleep(PAUSE_MS);
    return rows;
  } catch {
    console.log(`      · ${qid} too heavy in one query — falling back to sitelink bands`);
  }

  const rows = [];
  for (const [lo, hi] of bands(min)) {
    try {
      rows.push(...(await runSparql(peopleQuery(qid, lo, hi))));
    } catch (err) {
      console.warn(`      ! ${qid} [${lo},${hi}) gave up: ${err.message}`);
    }
    await sleep(PAUSE_MS);
  }
  return rows;
}

async function fetchGroup(group) {
  const byId = new Map();
  for (const qid of group.qids) {
    const rows = await fetchOccupation(qid, group.min);
    for (const row of rows) {
      const id = row.p.value.split('/').pop();
      if (byId.has(id)) continue;
      const name = row.pLabel?.value ?? '';
      // An unlabelled entity comes back as its own Q-number, which is not a person's name.
      if (!name || /^Q\d+$/.test(name)) continue;
      byId.set(id, {
        id,
        name,
        sitelinks: Number(row.sitelinks.value),
        image: row.img?.value ?? null,
      });
    }
    console.log(`    ${qid}: ${byId.size} cumulative`);
  }
  return [...byId.values()].sort((a, b) => b.sitelinks - a.sitelinks);
}

async function main() {
  if (args.includes('--list-groups')) {
    for (const g of GROUPS) console.log(`  ${g.key.padEnd(18)} ${g.list.padEnd(28)} min ${g.min}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : {};
  const out = args.includes('--refresh') ? {} : existing.groups ?? {};

  const only = flag('group');
  const todo = GROUPS.filter((g) => (!only || g.key === only) && !out[g.key]);
  if (!todo.length) {
    console.log('Nothing to fetch. --refresh to start over, or --group=<key> for one.');
    return;
  }
  console.log(`Fetching ${todo.length} group(s). The output file doubles as the resume log.\n`);

  for (const group of todo) {
    console.log(`  ${group.list} (min ${group.min} sitelinks)`);
    const people = await fetchGroup(group);
    out[group.key] = { list: group.list, min: group.min, people };
    // Written after every group, so Ctrl+C costs only the group in flight.
    fs.writeFileSync(
      OUT_PATH,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          source: 'Wikidata SPARQL (P31 human, P106 occupation, ranked by sitelinks)',
          groups: out,
        },
        null,
        2
      )
    );
    console.log(`  -> ${people.length} people, ${people.filter((p) => p.image).length} with a photo\n`);
  }

  const total = Object.values(out).reduce((n, g) => n + g.people.length, 0);
  console.log(`Done. ${total} people across ${Object.keys(out).length} groups -> ${OUT_PATH}`);
}

// Only when invoked directly -- seed-wikidata-people.js imports GROUPS for the priority
// order, and importing a module should never kick off a twenty-minute network sweep.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { GROUPS };
