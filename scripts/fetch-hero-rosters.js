// Fetches game casts into data/seed/, one file per game, for scripts/seed-roster.js to load:
// the playable rosters of hero games, and the casts of story games the other seeds miss. Names,
// image URLs and (where there is one) a fame score -- no lore, abilities or stats.
//
//   node scripts/fetch-hero-rosters.js            # every game below
//   node scripts/fetch-hero-rosters.js dota-2     # just one
//
// Sources, both public and keyless:
//   Dota 2     OpenDota's hero constants (api.opendota.com); portraits from Valve's Steam CDN.
//   Deadlock   deadlock-api.com's assets (api.deadlock-api.com/v1/assets/heroes); hero cards
//              from its bucket. Its old host, assets.deadlock-api.com, no longer resolves.
//   Persona    the Megami Tensei wiki (megamitensei.fandom.com): each GAME's character
//              category, the anime, film and novel ones left out -- the cast as the games have
//              it. Wikidata files every Persona game under "Megami Tensei" and has entries for
//              only a handful of its characters, so the Wikidata seed made one thin list that
//              no one looking for Persona would find; and the anime fell below the AniList
//              seed's popularity cut. Fame is the length of a character's wiki page: the
//              protagonists and party run to tens of thousands of bytes, a classmate with one
//              line to a few hundred, which is what difficulty needs to tell them apart.
//
// Deadlock's list includes heroes that are not in the game: cut and test ones (Gunslinger, The
// Boss, hero_testhero) and removed ones (Kali). Those are the ones marked `disabled`, and only
// those are left out -- a character nobody has seen is not one anyone can guess. NOT
// `player_selectable`, which the first version went by: the newest heroes (Violet, Nurse Harrow)
// are marked pre-release and unselectable in the data while players have them, and Baba still
// carries an in-development flag after release. All three were missing until a player noticed.
// The newest have no hero card yet; their portrait strip stands in.

const path = require('path');
const { writeFileAtomic } = require('./lib/writeAtomic');

const USER_AGENT =
  'guess-the-character-bot/1.0 (Discord party game; https://github.com/lucasphanpersonal/guess-the-character-bot)';
const SEED_DIR = path.join(__dirname, '..', 'data', 'seed');

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// One wiki's members of several categories, deduplicated, with each page's lead image and
// length. Fandom answers 500 per request; the categories here are well under that.
async function wikiCast(domain, categories) {
  const byTitle = new Map();
  for (const category of categories) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', generator: 'categorymembers',
      gcmtitle: `Category:${category}`, gcmnamespace: '0', gcmlimit: '500',
      prop: 'pageimages|info', piprop: 'original', pilicense: 'any',
    });
    const body = await getJson(`https://${domain}/api.php?${params}`);
    const pages = body.query?.pages ?? [];
    if (!pages.length) throw new Error(`${domain}: no pages in Category:${category} -- renamed?`);
    for (const p of pages) if (!byTitle.has(p.title)) byTitle.set(p.title, p);
  }
  // The wiki disambiguates a few titles ("Kaneko (Persona 4 The Animation)"); the character is
  // the name before it.
  const out = new Map();
  for (const p of byTitle.values()) {
    // Not characters: sub-pages ("Akihiko Sanada/Quotes", "Party/Teddie"), index pages ("List of
    // Persona Q Characters"), and groups ("Order of the Holy Lance").
    if (p.title.includes('/') || /^List of /i.test(p.title) || /^(Order|Society|Organization|Church) of /i.test(p.title)) continue;
    const name = p.title.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const prior = out.get(name.toLowerCase());
    if (!prior || p.length > prior.fame) out.set(name.toLowerCase(), { name, image: p.original?.source ?? null, fame: p.length });
  }
  // "Shadow Yu" is Yu Narukami's dark self, a boss -- the same character to anyone guessing. Kept
  // only where the wiki has no page for the person (then the Shadow is who the games show).
  const firstNames = new Set([...out.values()].flatMap((c) => c.name.toLowerCase().split(/\s+/)));
  for (const [k, c] of out) {
    const who = c.name.match(/^Shadow (.+)$/i)?.[1]?.toLowerCase();
    if (who && who.split(/\s+/).every((w) => firstNames.has(w))) out.delete(k);
  }
  return [...out.values()];
}

const GAMES = {
  'dota-2': {
    list: 'Dota 2',
    source: 'OpenDota hero constants (api.opendota.com/api/constants/heroes)',
    async characters() {
      const heroes = Object.values(await getJson('https://api.opendota.com/api/constants/heroes'));
      return heroes
        .filter((h) => h.localized_name && h.img)
        .map((h) => ({ name: h.localized_name, image: `https://cdn.cloudflare.steamstatic.com${h.img.replace(/\?$/, '')}` }));
    },
  },
  deadlock: {
    list: 'Deadlock',
    source: 'deadlock-api.com assets (api.deadlock-api.com/v1/assets/heroes)',
    async characters() {
      const heroes = await getJson('https://api.deadlock-api.com/v1/assets/heroes');
      return heroes
        .filter((h) => !h.disabled && h.name)
        .map((h) => ({ name: h.name, image: h.images?.icon_hero_card ?? h.images?.icon_image_small ?? h.images?.top_bar_vertical_image ?? null }));
    },
  },
  persona: {
    list: 'Persona',
    source: "Megami Tensei wiki (megamitensei.fandom.com), the games' character categories",
    characters: () =>
      wikiCast('megamitensei.fandom.com', [
        'Persona Characters',
        'Persona 2: Innocent Sin Characters',
        'Persona 2: Eternal Punishment Characters',
        'Persona 3 Characters', 'Persona 3 FES Characters', 'Persona 3 Portable Characters', 'Persona 3 Reload Characters',
        'Persona 4 Characters', 'Persona 4 Golden Characters',
        'Persona 5 Characters', 'Persona 5 Royal Characters',
        'Persona 4 Arena Characters', 'Persona Q Characters', 'Persona Q2 Characters',
        'Persona 5 Strikers Characters', 'Persona 5 Tactica Characters', 'Persona 5: The Phantom X Characters',
        'Persona 3: Dancing in Moonlight Characters', 'Persona 4: Dancing All Night Characters', 'Persona 5: Dancing in Starlight Characters',
      ]),
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const keys = wanted.length ? wanted : Object.keys(GAMES);
  for (const key of keys) {
    const game = GAMES[key];
    if (!game) throw new Error(`Unknown game "${key}" -- one of: ${Object.keys(GAMES).join(', ')}`);
    const characters = (await game.characters()).sort((a, b) => a.name.localeCompare(b.name));
    const file = path.join(SEED_DIR, `${key}.json`);
    writeFileAtomic(file, JSON.stringify({ list: game.list, category: 'Video Games', source: game.source, fetchedAt: new Date().toISOString(), characters }, null, 1));
    console.log(`${game.list}: ${characters.length} characters (${characters.filter((c) => c.image).length} with a picture) -> ${path.relative(process.cwd(), file)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
