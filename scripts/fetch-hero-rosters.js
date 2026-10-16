// Fetches the playable rosters of hero games into data/seed/, one file per game, for
// scripts/seed-roster.js to load. Names and image URLs only -- no lore, abilities or stats.
//
//   node scripts/fetch-hero-rosters.js            # every game below
//   node scripts/fetch-hero-rosters.js dota-2     # just one
//
// Sources, both public and keyless:
//   Dota 2     OpenDota's hero constants (api.opendota.com); portraits from Valve's Steam CDN.
//   Deadlock   deadlock-api.com's assets (api.deadlock-api.com/v1/assets/heroes); hero cards
//              from its bucket. Its old host, assets.deadlock-api.com, no longer resolves.
//
// Deadlock's list includes heroes that are not in the game: test heroes, cut ones, and ones
// still in development (Kali, Gunslinger, hero_testhero). Only the ones a player can pick today
// are kept -- a character nobody has seen is not a character anyone can guess.

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
        .filter((h) => h.player_selectable && !h.disabled && !h.in_development && h.name)
        .map((h) => ({ name: h.name, image: h.images?.icon_hero_card ?? h.images?.icon_image_small ?? null }));
    },
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
