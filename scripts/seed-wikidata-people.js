// Seeds the "Real People" category from data/seed/wikidata-people.json (built by
// scripts/fetch-wikidata-people.js): actors, athletes, scientists, politicians, music groups
// and the rest, one list per field.
//
// Everything the bot could deal until now was fictional, which quietly ruled out the version
// of this game most people have actually played -- the one where the name on your forehead is
// a real person.
//
// ONE ENTITY, ONE LIST
// Wikidata gives Ronald Reagan "politician" AND "actor", Albert Camus "writer" and
// "association football player", Arnold Schwarzenegger three or four. Groups are processed in
// the order fetch-wikidata-people.js declares them and the first list to claim somebody keeps
// them, so a server that switches Politicians off does not meet Reagan again under Actors.
//
// HOW DEEP EACH LIST GOES
// Sitelinks -- how many language Wikipedias carry an article -- rank each list, and the top
// PER_LIST_LIMIT are kept. The cut is per list rather than global for the same reason the
// fictional importer cuts per show: the distributions are nothing alike. 70 sitelinks is a
// merely notable actor and a world-historic scientist, so one threshold across all of them
// would drown the pool in footballers and delete most of the scientists.
//
// PHOTOGRAPHS
// These are the one case where Wikidata's image property is exactly what it looks like. The
// trust rule (src/util/characterImages.js) drops Commons images for Cartoon and Video Games
// because no photograph can depict a drawing -- but a photograph of Marie Curie IS Marie
// Curie, so "Real People" passes through it untouched, by construction rather than exception.
//
// Additive and idempotent, like the other seeders: existing people are skipped and an
// existing image is never overwritten.
//
// Usage:
//   node scripts/seed-wikidata-people.js
//   node scripts/seed-wikidata-people.js --per-list 200
//   node scripts/seed-wikidata-people.js --group actors
//   node scripts/seed-wikidata-people.js --dry-run
//
// Lists land in the shared compendium, which every Discord server and the web app see.

const fs = require('fs');
const path = require('path');
const {
  createList,
  setListCategory,
  getListByName,
  addCharacter,
  getCharacters,
} = require('../src/compendium/characterLists');
const { trustworthyImageOrNull } = require('../src/compendium/characterImages');
const { GROUPS } = require('./fetch-wikidata-people');
const { scriptArgs } = require('./lib/compendiumArgs');

const DATA_PATH = path.join(__dirname, '..', 'data', 'seed', 'wikidata-people.json');
const CATEGORY = 'Real People';

// How many people one field may contribute, best-known first. Generous next to the fictional
// importer's 30-per-show, because a field is a much broader thing than a cast.
const PER_LIST_LIMIT = 150;
// Below this a list is not worth existing -- a lobby drawing from it has nothing to choose
// between, and it clutters `/list select` for everyone.
const MIN_PEOPLE = 5;

// Read lazily-safe at module scope: backfill-popularity.js imports assignPeople from this file,
// and nothing here acts on the arguments until main() runs.
const args = require.main === module ? scriptArgs() : [];
const flagValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : fallback;
};
const dryRun = args.includes('--dry-run');
const perList = Number(flagValue('per-list', PER_LIST_LIMIT));
const onlyGroup = flagValue('group', null);


/**
 * Who ends up in which list, with the priority claim and the per-list cap applied.
 *
 * Exported because backfill-popularity.js has to reach the same answer: it scores a list by
 * summing the sitelinks of the people actually in it, and if it summed the raw group instead
 * then Actors would be ranked on Shakespeare, Trump and Reagan -- none of whom are in it.
 *
 * The fictional pipeline already works this way, reusing the seeders' own merge functions
 * rather than re-deriving the naming. Same reason: two implementations of "what got created"
 * drift, and the one that drifts is always the one nobody is looking at.
 */
function assignPeople(groups, perListLimit = PER_LIST_LIMIT) {
  const claimed = new Set();
  const out = [];
  // Walked in the order GROUPS declares, NOT the order the file happens to be in. The seed
  // file is written in fetch order, so re-ordering the priorities would otherwise change
  // nothing until the whole thing was refetched -- a silent no-op is the worst kind.
  const ordered = GROUPS.map((g) => [g.key, groups?.[g.key]]).filter(([, g]) => g);
  for (const [key, group] of ordered) {
    const mine = group.people.filter((p) => !claimed.has(p.id));
    for (const p of mine) claimed.add(p.id);
    // Two different people can share a name -- Ice Hockey Players holds two Viktor Tikhonovs,
    // the grandfather and the grandson, as separate Wikidata entities. The characters table
    // is UNIQUE(list_id, name), so the second insert throws and takes the whole seed with it.
    // Better known wins, and the game could not tell them apart anyway.
    const byName = new Map();
    for (const p of mine.sort((a, b) => b.sitelinks - a.sitelinks)) {
      const k = p.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, p);
    }

    out.push({ key, list: group.list, people: [...byName.values()].slice(0, perListLimit) });
  }
  return out;
}

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`No ${DATA_PATH}. Run: node scripts/fetch-wikidata-people.js`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const assigned = assignPeople(data.groups, perList);
  if (!assigned.length) {
    console.error('The seed file has no groups in it.');
    process.exit(1);
  }

  let created = 0;
  let added = 0;
  let skippedSmall = 0;

  console.log(
    `${CATEGORY}: ${assigned.length} lists, keeping the ${perList} best-known of each` +
      `${dryRun ? '  [DRY RUN -- nothing will be written]' : ''}\n`
  );

  for (const { key, list: listName, people: keep } of assigned) {
    if (onlyGroup && key !== onlyGroup) continue;
    if (keep.length < MIN_PEOPLE) {
      skippedSmall++;
      console.log(`  · ${listName} — only ${keep.length} left after de-duplication, skipped`);
      continue;
    }

    let list = getListByName(null, listName);
    if (!list && !dryRun) {
      list = { id: createList(null, listName, 'seed-script', CATEGORY) };
      created++;
    } else if (list) {
      setListCategory(list.id, CATEGORY);
    } else {
      created++; // dry run: it would have been created
    }

    const existing = new Set(
      list && !dryRun ? getCharacters(list.id).map((c) => c.name.toLowerCase()) : []
    );
    let newHere = 0;
    for (const person of keep) {
      if (existing.has(person.name.toLowerCase())) continue;
      // A photograph of a real person is the person; the trust rule is applied anyway so
      // there is exactly one place that decides what may be stored.
      const image = trustworthyImageOrNull(CATEGORY, person.image);
      if (!dryRun) addCharacter(list.id, person.name, 'seed-script', image);
      newHere++;
      added++;
    }
    const withPhoto = keep.filter((p) => p.image).length;
    console.log(
      `  ✓ ${listName.padEnd(28)} ${String(keep.length).padStart(4)} kept` +
        ` (${withPhoto} with a photo), ${newHere} new` +
        `   e.g. ${keep.slice(0, 3).map((p) => p.name).join(', ')}`
    );
  }

  console.log(`\n${dryRun ? 'Would create' : 'Created'} ${created} list(s), ${added} entries added.`);
  if (skippedSmall) console.log(`${skippedSmall} list(s) skipped for being too small.`);
  if (!dryRun) {
    console.log(
      'New lists are OFF by default -- switch them on with `/list select category:Real People`' +
        ' or `npm run backfill:popularity`.'
    );
  }
}

// Only run when invoked directly -- backfill-popularity.js imports assignPeople from here.
if (require.main === module) main();

module.exports = { assignPeople, CATEGORY, PER_LIST_LIMIT };
