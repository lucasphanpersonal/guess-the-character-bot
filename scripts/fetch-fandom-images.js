// Fills in missing character artwork from each show's own Fandom wiki.
//
//   node scripts/fetch-fandom-images.js --category=Cartoon --dry-run
//   node scripts/fetch-fandom-images.js --category=Cartoon --lists=5
//
// Cartoon and Video Games arrive almost entirely without art, because Wikidata only carries
// freely-licensed images and there are none for most drawn characters. A general image
// search would fill the gap and reintroduce exactly the problem src/util/characterImages.js
// was written to stop: "Guts", "Link" and "Zero" pull the wrong franchise, and nothing rules
// out fan art or a meme.
//
// Searching the FRANCHISE'S OWN WIKI makes that structural rather than a heuristic:
// naruto.fandom.com cannot return a Zelda character, however the query is spelled. It is the
// same move the bot already makes with per-title lists and per-list fame.
//
// A name that is not a page title is followed through the wiki's own redirects ("Grampa" ->
// Abraham Simpson) and with a title stripped ("Captain Rex" -> Rex), but only onto a single
// character's page: redirects into sections, lists, groups ("Mobs") and pages that merely
// contain the name ("Steve and Alex") are refused. A Disney or Pixar title with no wiki of its
// own falls back to the studio wikis, where a page must be filed under that title's characters.
//
// Nothing is overwritten -- only characters with no image at all are touched -- and every
// candidate still has to pass the trust rule before it is stored. One image is never given to
// two characters in the same list.

const db = require('../src/compendium/db');
const { setCharacterImage } = require('../src/compendium/characterLists');
const { imageIsTrustworthy } = require('../src/compendium/characterImages');

const UA = 'guess-the-character-bot/1.0 (character artwork backfill; https://github.com/lucasphanpersonal/guess-the-character-bot)';
const PAUSE_MS = 180; // polite serial pacing; Fandom is somebody else's server

// Every list in the category, shared or private, is in reach; lists some scope actually plays
// with go first, since that is where a missing picture is seen.
const args = require('./lib/compendiumArgs').scriptArgs();
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const dryRun = args.includes('--dry-run');
const category = flag('category', 'Cartoon');
const listLimit = Number(flag('lists', 0)) || Infinity;
const verbose = args.includes('--verbose');


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Studio-wide wikis, tried only for a list with no wiki of its own, and only in the categories
// the seeder files Disney and Pixar titles under -- their films land in Movies, their series in
// Cartoon and Television Shows. Pixar is its own wiki; Disney's covers everything else.
const STUDIO_WIKIS = ['disney.fandom.com', 'pixar.fandom.com'];
const STUDIO_WIKI_CATEGORIES = new Set(['Movies', 'Cartoon', 'Television Shows']);

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Comparable form for titles and names: case, punctuation and the articles that wikis add or
// drop freely ("The Simpsons" vs "Simpsons") are all noise here.
const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|a|an)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

/**
 * Lead images that are about the SHOW rather than the character -- worse than nothing, since
 * a title card names the show to someone whose whole job is to not know it.
 *
 * Measured over the first 760 cartoon matches, this is a 3-in-760 problem: a logo, a title
 * card and a group shot. Tempting to fix it structurally instead, by refusing any page whose
 * title is the show's own name -- but 8 of the 10 characters named after their series got the
 * RIGHT image that way (BoJack Horseman, Chowder, Kim Possible), so that rule would have
 * thrown away four good images for every bad one it caught. The narrow filter wins.
 *
 * Matched against the filename with separators normalised: "Steven_Universe_logo.png" has no
 * word boundary before "logo", so \blogo\b silently misses the exact case that motivated it.
 */
const JUNK_IMAGE = /(\blogo\b|\bwordmark\b|favicon|wiki background|placeholder|\bno image\b|noimage|question mark|default avatar|title card|group shot|groupshot|cast photo|characters slide|\bposter\b)/i;

const looksLikeJunk = (url) => JUNK_IMAGE.test(decodeURIComponent(url).replace(/[-_]+/g, ' '));

const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]/g, '');

/**
 * Wikis the guesser cannot reach, written down by hand.
 *
 * Guessing works because a Fandom subdomain is usually just the title with the punctuation
 * taken out -- but two things defeat it however the string is mangled. A title often lives on
 * the FRANCHISE'S wiki rather than its own (every DC cartoon on dcau, "Mario Kart DS" on mario,
 * every Fate/ title on fate), and plenty of wikis answer to a name their shows never mention:
 * Wookieepedia, Scoobypedia, Bandipedia, Encyclopedia SpongeBobia, MMKB. Fandom used to answer
 * exactly this question; its wiki-search endpoints all 404 now, so the only source left is
 * somebody who already knows which wiki it is.
 *
 * An alias is therefore trusted where a guess is not, and skips the sitename check below.
 * That check exists to stop a MACHINE'S SPECULATION being believed -- nothing but string
 * mangling proposed "justiceleague", so the wiki has to say something that backs it up, which
 * is what keeps that list off the DC Extended Universe. An entry here is instead a person
 * saying which wiki this is, and demanding the wiki's self-chosen name resemble the show would
 * veto precisely the cases a person was needed for: dcau calls itself "DC Animated Universe"
 * and says nothing about Justice League, which is the point of writing it down.
 *
 * The wiki still has to exist and answer. And titleMatches() guards every character lookup
 * underneath this, so an alias pointing somewhere unrelated fails closed -- the characters
 * simply find no page, rather than a stranger's portrait. That backstop is per-character and
 * cannot tell a wrong FRANCHISE from a wrong page, which is why relaxing the sitename check
 * for guesses would not be the same trade: it would hand "Justice League" back to the DCEU,
 * where the characters share their names and every lookup matches.
 */
const WIKI_ALIASES = {
  // Cartoon.
  'The Adventures of Tintin': 'tintin',
  'Teen Titans Go!': 'teentitans',
  'Phineas and Ferb the Movie': 'phineasandferb',
  'She-Ra and the Princesses of Power': 'shera',
  'Kim Possible Movie: So the Drama': 'kimpossible',
  'Merry Madagascar': 'madagascar',
  'The Penguins of Madagascar': 'madagascar',
  'Total Drama Island': 'totaldrama',
  'Total Drama Presents: The Ridonculous Race': 'totaldrama',
  Ben: 'ben10', // the list is Ben 10; the seed dropped the number
  'The Adventures of Jimmy Neutron, Boy Genius': 'jimmyneutron',
  'Steven Universe Future': 'steven-universe',
  "OK K.O.! Let's Be Heroes": 'ok-ko',
  "Marvel's Avengers Assemble": 'avengersassemble',
  'Invader Zim': 'zim',
  'My Life as a Teenage Robot': 'mlaatr',
  'Biker Mice from Mars': 'bikermice',
  'Tiny Toon Adventures': 'tinytoons',
  'The New Woody Woodpecker Show': 'woodywoodpecker',
  "The Emperor's New School": 'emperorsnewgroove',
  'Harvey Birdman, Attorney at Law': 'harveybirdman',
  'Uncle Grandpa': 'uncle-grandpa',
  'Go, Dog. Go!': 'go-dog-go',
  'The Cleveland Show': 'cleveland',
  "Chip 'n Dale Rescue Rangers": 'chipndale',
  "Mickey's House of Villains": 'mickeymouse',
  'DC Nation Shorts': 'dcnation',
  'Dogs in Space': 'dogs-in-space',
  'Lyla in the Loop': 'lyla-in-the-loop',
  "Teacher's Pet": 'teachers-pet',
  'Sonic Prime': 'sonic-prime',
  'Q-Force': 'q-force',

  // Video games. Long runs of one franchise -- the whole point of keeping a map.
  'Mario Party': 'mario',
  'Super Mario Kart': 'mario',
  'Mario Baseball': 'mario',
  'Mario Tennis': 'mario',
  'Mario & Sonic at the Olympic Games': 'mario',
  'Super Mario Land': 'mario',
  'Hotel Mario': 'mario',
  'Mario Is Missing!': 'mario',
  'Mario Kart DS': 'mario',
  'Mario & Luigi': 'mario',
  'Mario Kart 8 Deluxe': 'mario',
  'Super Mario 3D World': 'mario',
  'Mario role-playing games': 'mario',
  'New Super Mario Bros. U': 'mario',
  'Super Mario Sunshine': 'mario',
  'Super Mario 3D Land': 'mario',
  'Mario Kart Tour': 'mario',
  'Super Mario Advance': 'mario',
  'Mario Kart World': 'mario',
  'Donkey Kong Country': 'donkeykong', // Mario Wiki covers it, but never says "Donkey Kong"
  'Crisis Core: Final Fantasy VII': 'finalfantasy',
  'Dissidia Final Fantasy NT': 'finalfantasy',
  'Dissidia Final Fantasy Opera Omnia': 'finalfantasy',
  'Dissidia Final Fantasy': 'finalfantasy',
  'Dissidia 012 Final Fantasy': 'finalfantasy',
  'World of Final Fantasy': 'finalfantasy',
  'Final Fantasy X subseries': 'finalfantasy',
  'Final Fantasy X-2': 'finalfantasy',
  'Fabula Nova Crystallis Final Fantasy': 'finalfantasy',
  'Final Fantasy Record Keeper': 'finalfantasy',
  'Fate/stay night': 'fate',
  'Fate/Extra': 'fate',
  'Fate/hollow ataraxia': 'fate',
  'Fate/unlimited codes': 'fate',
  'Fate/tiger colosseum': 'fate',
  'Fate/Extella: The Umbral Star': 'fate',
  'Tekken Tag Tournament': 'tekken',
  'Tekken Card Tournament': 'tekken',
  'Guilty Gear Xrd Revelator': 'guiltygear',
  'Guilty Gear XX Accent Core Plus R': 'guiltygear',
  'X-Men vs. Street Fighter': 'streetfighter',
  'Street Fighter Alpha': 'streetfighter',
  'Resident Evil Re:Verse': 'residentevil',
  'Resident Evil Outbreak': 'residentevil',
  'Resident Evil Zero': 'residentevil',
  'Batman Forever': 'batman',
  'Batman & Robin': 'batman',
  'The Adventures of Batman & Robin': 'batman',
  'Batman Begins': 'batman',
  'Apollo Justice: Ace Attorney': 'aceattorney',
  'Ace Attorney Investigations': 'aceattorney',
  'Spyro the Dragon': 'spyro',
  'The Legend of Spyro': 'spyro',
  'Spyro Reignited Trilogy': 'spyro',
  'Dragon Ball Heroes': 'dragonball',
  'Dragon Ball Z: Budokai Tenkaichi': 'dragonball',
  "Kirby's Adventure": 'kirby',
  'Kirby Star Allies': 'kirby',
  "Assassin's Creed Unity": 'assassinscreed',
  "Assassin's Creed Valhalla": 'assassinscreed',
  "Assassin's Creed Syndicate": 'assassinscreed',
  'Touhou Project': 'touhou',
  'Dead or Alive Xtreme': 'deadoralive',
  'Lilo & Stitch': 'liloandstitch',
  'Professor Layton': 'layton',
  'Ratchet & Clank': 'ratchetandclank',
  'Ultimate Marvel vs. Capcom 3': 'marvelvscapcom',
  'PlayStation All-Stars Battle Royale': 'playstationallstars',
  'Xenoblade Chronicles': 'xenoblade',
  'Danganronpa V3: Killing Harmony': 'danganronpa',
  'Treasure Planet': 'treasure-planet',
  'Pokémon video games': 'pokemon',

  // Franchise wikis that go by a nickname. Every one of these is the RIGHT wiki and every
  // one is rejected by the name check -- 'Wookieepedia' says nothing about Star Wars, and
  // 'DC Animated Universe' says nothing about Justice League. They are reachable only
  // because an alias is taken at its word; before that they were the largest single
  // block of unreachable lists.
  'Digimon': 'digimon',
  'Digimon Adventure': 'digimon',
  'Digimon Tamers': 'digimon',
  'Digimon World': 'digimon',
  'Digimon World Dawn': 'digimon',
  'Digimon World Dusk': 'digimon',
  'Digimon World Re:Digitize Decode': 'digimon',
  'Pocket Digimon World': 'digimon',
  'Digimon Typing': 'digimon',
  'Digimon Story': 'digimon',
  'Digimon Park': 'digimon',
  'Digimon New Century': 'digimon',
  'Digimon ReArise': 'digimon',
  'Digimon Links': 'digimon',
  'Star Wars': 'starwars',
  'Star Wars: Knights of the Old Republic': 'starwars',
  'Lego Star Wars': 'starwars',
  'Star Wars: Battlefront': 'starwars',
  'Star Wars: Jedi Knight': 'starwars',
  'Star Wars Galaxies': 'starwars',
  'Star Wars Jedi': 'starwars',
  'Star Wars Resistance': 'starwars',
  'Scooby-Doo! The Mystery Begins': 'scoobydoo',
  'Scooby-Doo! Curse of the Lake Monster': 'scoobydoo',
  'Scooby-Doo 2: Monsters Unleashed': 'scoobydoo',
  'Scooby-Doo! Mystery Incorporated': 'scoobydoo',
  'Crash Bandicoot': 'crashbandicoot',
  'Super Smash Bros.': 'supersmashbros',
  'SpongeBob SquarePants': 'spongebob',
  "Kamp Koral: SpongeBob's Under Years": 'spongebob',
  'SpongeBob SquarePants video games': 'spongebob',
  'Sonic the Hedgehog': 'sonic',
  'Sonic Adventure': 'sonic',
  'Sonic Rivals': 'sonic',
  'Sonic Riders': 'sonic',
  'Justice League Unlimited': 'dcau',
  'Justice League Action': 'dcau',
  'Justice League': 'dcau',
  'Justice League Heroes': 'dcau',
  'Static Shock': 'dcau',
  'Teenage Mutant Ninja Turtles': 'tmnt',
  'Rise of the Teenage Mutant Ninja Turtles': 'tmnt',
  'Imagicard Teenage Mutant Ninja Turtles': 'tmnt',
  'list of Teenage Mutant Ninja Turtles video games': 'tmnt',
  'Shrek': 'shrek',
  'Shrek the Third': 'shrek',
  'Shrek Forever After': 'shrek',
  'Shrek SuperSlam': 'shrek',
  'Shrek the Halls': 'shrek',
  'Scared Shrekless': 'shrek',
  "Shrek Smash n' Crash Racing": 'shrek',
  'Shrek Super Party': 'shrek',
  'Mega Man': 'megaman',
  'Mega Man Legends': 'megaman',
  'Warcraft': 'warcraft',
  'Warcraft Rumble': 'warcraft',
  'Warcraft Adventures: Lord of the Clans': 'warcraft',
  'Star Fox': 'starfox',
  'Star Trek': 'memory-alpha',
  'Star Trek Online': 'memory-alpha',
  'Star Trek Trexels': 'memory-alpha',
  'Star Trek Fleet Command': 'memory-alpha',
  'Tomb Raider': 'tombraider',
  'Hunter × Hunter': 'hunterxhunter',
  'Marvel': 'marvel',
  'Marvel Super Heroes': 'marvel',
  "Marvel's Avengers Assemble": 'marvel',
  'Lego Marvel Super Heroes': 'marvel',
  'Dynasty Warriors': 'koei',
  'The Grim Adventures of Billy & Mandy': 'grimadventures',
};

/**
 * Subdomains worth trying for a title, most specific first.
 *
 * Fandom retired every wiki-search endpoint it used to publish (Wikis/ByString and the whole
 * SearchApiController now 404), so discovery is guesswork -- but a Fandom subdomain is just
 * the title with the punctuation taken out, which makes it good guesswork.
 */
function wikiCandidates(listName) {
  const beforeColon = listName.split(/[:–—]/)[0];
  const noArticle = listName.replace(/^\s*(the|a|an)\s+/i, '');
  const guesses = [listName, noArticle, beforeColon, beforeColon.replace(/^\s*(the|a|an)\s+/i, '')]
    .map(slug)
    .filter((s) => s.length >= 3);
  // The hand-written answer goes first: where one exists, the guesses below it are the ones
  // that already failed. `asserted` is what earns it the shortcut past the sitename check.
  const alias = WIKI_ALIASES[listName];
  const subdomains = [...new Set(alias ? [alias, ...guesses] : guesses)];
  return subdomains.map((subdomain) => ({ subdomain, asserted: subdomain === alias }));
}

/**
 * The Fandom wiki for a title: guess a subdomain, then make it prove itself.
 *
 * The proof is the point for a GUESS. "Justice League" resolves to a real wiki that turns out
 * to be the DC Extended Universe, and lifting character art out of the wrong franchise is
 * exactly the failure this whole approach exists to make impossible -- so a subdomain nothing
 * but string mangling proposed has to advertise a name that looks like the show.
 *
 * An alias from WIKI_ALIASES answers that question already, and only has to exist: see the
 * reasoning above the map.
 */
async function findWiki(listName) {
  const want = norm(listName);
  for (const { subdomain, asserted } of wikiCandidates(listName)) {
    const domain = `${subdomain}.fandom.com`;
    let sitename;
    try {
      const data = await getJson(`https://${domain}/api.php?action=query&format=json&meta=siteinfo&siprop=general`);
      sitename = data?.query?.general?.sitename;
    } catch {
      continue; // no wiki on that subdomain
    } finally {
      await sleep(PAUSE_MS);
    }
    if (!sitename) continue;

    if (asserted) {
      if (verbose) console.log(`      (alias ${domain} — "${sitename}", named by hand and taken at its word)`);
      return { domain, name: sitename, asserted: true };
    }

    const bare = norm(sitename).replace(/\bwiki(pedia)?\b/g, '').trim();
    let score = 0;
    if (bare === want) score = 3;
    else if (bare.startsWith(want) || want.startsWith(bare)) score = 2;
    else if (bare.includes(want) || want.includes(bare)) score = 1;
    if (score > 0) {
      if (verbose) console.log(`      (guessed ${domain} — it calls itself "${sitename}", score ${score})`);
      return { domain, name: sitename, score };
    }
    if (verbose) console.log(`      (skipped ${domain} — it calls itself "${sitename}")`);
  }
  return null;
}

// The page's lead image -- which on a character page is the infobox portrait -- plus what the
// checks below need to judge whether the page is really the character: whether the title was
// reached by a redirect (and whether that redirect points into a SECTION of a bigger page), and
// the page's categories. Fetched in the same request, so none of it costs another call.
async function leadImage(domain, title) {
  const url =
    `https://${domain}/api.php?action=query&format=json&redirects=1&prop=pageimages|categories` +
    `&piprop=original|thumbnail&pithumbsize=600&cllimit=max&titles=${encodeURIComponent(title)}`;
  const data = await getJson(url);
  const pages = data?.query?.pages ?? {};
  const page = Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  const image = page.original?.source ?? page.thumbnail?.source ?? null;
  const redirect = data?.query?.redirects?.[0] ?? null;
  return image
    ? {
        image,
        title: page.title,
        redirected: Boolean(redirect),
        toSection: Boolean(redirect?.tofragment),
        categories: (page.categories ?? []).map((c) => c.title.replace(/^Category:/, '')),
      }
    : null;
}

// Titles and ranks that sit in front of a name the wiki may file without them: the Frozen wiki
// has "Agnarr", not "King Agnarr". Also excluded from the shared-name test below, or every
// "Captain X" would count as sharing a name with every other captain.
const HONORIFIC =
  /^(king|queen|prince|princess|captain|capt|lord|lady|sir|dame|dr|doctor|professor|prof|mr|mrs|ms|miss|general|admiral|commander|colonel|major|lieutenant|sergeant|officer|detective|agent|chief|emperor|empress|duke|duchess|count|countess|baron|baroness|uncle|aunt|grandma|grandpa|granny|mother|father|sister|brother|master|madame|mayor|judge|coach|nurse|principal)\.?\s+/i;
const nameTokens = (s) =>
  new Set(norm(s).split(' ').filter((t) => t.length >= 3 && !HONORIFIC.test(`${t} `)));
const isCharacterPage = (hit) => hit.categories.some((c) => /\bcharacters?\b/i.test(c));

/**
 * A redirect is the wiki's own editors saying "this name is that character" -- the assertion
 * titleMatches already honours for "Darth Maul" -> "Maul", which happens to share a substring.
 * "Captain Salazar" -> "Armando Salazar", "Bootstrap Bill Turner" -> "William Turner Sr." and
 * "Prince Ali Ababwa" -> "Aladdin" are the same statement without one, and rejecting them threw
 * away portraits the wiki was handing over (measured: all four have one).
 *
 * A redirect can also point at things that are NOT a character: a section of a "minor
 * characters" page, the film itself, a list. So it must land on a page of its own that either
 * shares a real name with what was asked ("Salazar") or is filed as a character ("Aladdin").
 * Categories alone were not enough -- the Pirates wiki files William Turner Sr. only under crew
 * and ranks -- and a shared name alone would admit a family page, hence either-or.
 */
function redirectIsIdentity(name, hit, listName) {
  if (!hit.redirected || hit.toSection) return false;
  const got = norm(hit.title);
  if (/\b(list|gallery|category|episode|season|characters)\b/.test(got)) return false;
  if (got === norm(listName)) return false;
  if (isGroupPage(hit)) return false;
  const asked = nameTokens(name);
  if ([...nameTokens(hit.title)].some((t) => asked.has(t))) return true;
  // With no name in common, the only evidence is the wiki filing the page as a character -- which
  // a team filed as ONE entry also is: "Yuna" -> "Gullwings", the trio, pictured together. That
  // title looks plural, as group titles do; losing a singular name that happens to end in "s"
  // is the cheap side of the trade on this, the weakest route.
  return isCharacterPage(hit) && !/s$/.test(got);
}

/**
 * On a studio-wide wiki (Disney's, Pixar's) the franchise-wiki guarantee is gone -- Disney's has
 * a "King" in a dozen films. It is restored by demanding the page be FILED under this very title,
 * as those wikis do: "Toy Story characters" for the Toy Story list. Matched on whole words, so
 * the "Cars" list cannot be satisfied by a "Racecars" category.
 */
function filedUnderTitle(hit, listName) {
  const want = norm(listName);
  if (want.length < 3) return false;
  const re = new RegExp(`(^| )${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  // Filed as a CHARACTER of this title -- "Cars characters" -- not merely somewhere under it.
  // The first dry run took "Tow Mater (The One You Want to Call)", a song filed under "Cars
  // songs", as Tow Mater, and stored Cars Land's soundtrack art.
  return hit.categories.some((c) => re.test(norm(c)) && /\bcharacters?\b/.test(norm(c)));
}

async function searchTitle(domain, name) {
  const url =
    `https://${domain}/api.php?action=query&format=json&list=search` +
    `&srsearch=${encodeURIComponent(name)}&srlimit=3&srnamespace=0`;
  try {
    const data = await getJson(url);
    return (data?.query?.search ?? []).map((r) => r.title);
  } catch {
    return [];
  }
}

/**
 * A title only counts if it is recognisably the character asked for.
 *
 * The search fallback happily answers "Ed" with "List of Ed, Edd n Eddy characters", and an
 * image lifted off a cast list is a picture of somebody else.
 */
// A disambiguating qualifier that says the page is NOT a person: "Tow Mater (The One You Want to
// Call)" is fine to norm() away, but "(song)" or "(video game)" is the wiki telling us outright.
const NOT_A_CHARACTER =
  /\((song|film|movie|episode|album|soundtrack|video game|game|book|novel|comic|comics|series|tv series|show|attraction|ride|level|location|place|ship|vehicle|franchise|toy|merchandise)\)/i;

// Words that, added to a character's name, make the page about something other than that one
// character: a pairing, a group, or the work itself.
const MORE_THAN_A_NAME = new Set([
  'and', 'movie', 'film', 'series', 'show', 'game', 'games', 'episode', 'season', 'soundtrack', 'album',
  'song', 'comic', 'comics', 'novel', 'book', 'franchise', 'family', 'siblings', 'brothers', 'sisters',
  'twins', 'team', 'gang', 'crew', 'group', 'clan', 'squad', 'duo', 'trio', 'mobs',
]);
// A page about a GROUP, whatever it is called: redirects send a member to their team's page
// ("Yuna" -> "Gullwings", "Creeper" -> "Mobs", "Anya Von Drake" -> "Von Drake siblings"), and
// its picture is everyone. Judged by the title's words and by how the wiki files the page. Used
// on the redirect route only, where that failure happened: "species" and "enemies" are kept
// out of the category test on purpose, because a Goomba's page IS a species page and is right.
const isGroupPage = (hit) =>
  norm(hit.title).split(' ').some((w) => MORE_THAN_A_NAME.has(w)) ||
  hit.categories.some((c) => /\b(groups?|teams?|organi[sz]ations?|factions?|families)\b/i.test(c));

function titleMatches(characterName, pageTitle, { viaSearch = false } = {}) {
  if (NOT_A_CHARACTER.test(pageTitle)) return false;
  const want = norm(characterName);
  const got = norm(pageTitle);
  if (!want || !got) return false;
  if (want === got) return true;
  if (/\b(list|gallery|category|episode|season|characters)\b/.test(got)) return false;

  // The page being MORE specific than the name is safe when the extra words are MORE NAME:
  // asking for "Palpatine" and landing on "Sheev Palpatine" is the wiki using a fuller name. It is
  // not safe when they name something else -- "Steve and Alex" is two characters (and a duo
  // picture), "The SpongeBob SquarePants Movie" is the film -- both found in a dry run.
  if (got.includes(want)) {
    const extra = got.split(' ').filter((w) => !want.split(' ').includes(w));
    return !extra.some((w) => MORE_THAN_A_NAME.has(w));
  }

  // The page being LESS specific is only safe when the wiki itself said so. A redirect from
  // "Darth Maul" to "Maul" is the wiki asserting they are the same character; a search result
  // of "Grand Moff" for "Grand Moff Tarkin" is a rank, not a person, and the portrait on it
  // belongs to whoever the article happened to lead with.
  return !viaSearch && want.includes(got);
}

// `filedUnder` is set on a studio-wide wiki: every route must then also land on a page filed
// under the list's title (see filedUnderTitle).
async function imageFor(domain, name, listName, { filedUnder = null } = {}) {
  const accept = (hit) => !filedUnder || filedUnderTitle(hit, filedUnder);

  const hit = await leadImage(domain, name).catch(() => null);
  if (hit && titleMatches(name, hit.title) && accept(hit)) return { ...hit, via: 'direct' };
  if (hit && redirectIsIdentity(name, hit, listName) && accept(hit)) return { ...hit, via: 'redirect' };

  await sleep(PAUSE_MS);
  for (const title of await searchTitle(domain, name)) {
    if (!titleMatches(name, title, { viaSearch: true })) continue;
    await sleep(PAUSE_MS);
    const found = await leadImage(domain, title).catch(() => null);
    if (found && accept(found)) return { ...found, via: 'search' };
  }

  // "King Agnarr" when the wiki files him as plain "Agnarr". Direct lookup only, never search,
  // and only onto a page the wiki itself files as a character: without that, "Captain Hook"
  // -> "Hook" would take the portrait off the 1991 film's page.
  const bare = name.replace(HONORIFIC, '');
  if (bare !== name && bare.length >= 3) {
    await sleep(PAUSE_MS);
    const plain = await leadImage(domain, bare).catch(() => null);
    if (plain && titleMatches(bare, plain.title) && isCharacterPage(plain) && accept(plain)) {
      return { ...plain, via: 'honorific' };
    }
  }
  return null;
}

/**
 * Clears every image this script has ever added, and nothing else.
 *
 * Backfilling 1,600 rows off a heuristic deserves a way back. It is safe precisely because
 * the script only ever fills a NULL: anything on a Fandom domain got there this way, so
 * removing them restores exactly the state before the run.
 */
function undo() {
  const rows = db
    .prepare(
      `SELECT ch.id FROM characters ch
         JOIN character_lists cl ON cl.id = ch.list_id
        WHERE COALESCE(cl.category, 'Uncategorised') = ?
          AND (ch.image_url LIKE '%wikia.nocookie.net%' OR ch.image_url LIKE '%fandom.com%')`
    )
    .all(category);

  console.log(`${category}: ${rows.length} Fandom image(s) to clear${dryRun ? '  [DRY RUN]' : ''}`);
  if (dryRun || !rows.length) return;

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  const run = db.transaction((ids) => { for (const id of ids) clear.run(id); });
  run(rows.map((r) => r.id));
  console.log(`Cleared ${rows.length}.`);
}

/**
 * Re-applies the junk filter to images already stored.
 *
 * The filter learns from what it lets through, and a run that has already written hundreds of
 * good rows should not have to be thrown away and repeated to drop a handful of bad ones.
 */
function prune() {
  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url AS url, cl.name AS list
         FROM characters ch JOIN character_lists cl ON cl.id = ch.list_id
        WHERE COALESCE(cl.category, 'Uncategorised') = ?
          AND (ch.image_url LIKE '%wikia.nocookie.net%' OR ch.image_url LIKE '%fandom.com%')`
    )
    .all(category)
    .filter((r) => looksLikeJunk(r.url));

  console.log(`${category}: ${rows.length} stored image(s) fail the junk filter${dryRun ? '  [DRY RUN]' : ''}`);
  for (const r of rows) {
    console.log(`  ${r.name}  [${r.list}]  ->  ${decodeURIComponent(r.url.split('/').slice(-3)[0])}`);
  }
  if (dryRun || !rows.length) return;

  const clear = db.prepare('UPDATE characters SET image_url = NULL WHERE id = ?');
  db.transaction((ids) => { for (const id of ids) clear.run(id); })(rows.map((r) => r.id));
  console.log(`Cleared ${rows.length}. They read as text again, which is the honest state.`);
}

async function main() {
  if (args.includes('--undo')) return undo();
  if (args.includes('--prune')) return prune();

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

  const totalMissing = lists.reduce((n, l) => n + l.missing, 0);
  console.log(
    `${category}: ${totalMissing} characters without artwork across ${lists.length} list(s)` +
      `${dryRun ? '  [DRY RUN -- nothing will be written]' : ''}\n`
  );

  const stats = { lists: 0, noWiki: 0, skipped: 0, checked: 0, found: 0, rejected: 0, missed: 0, written: 0 };
  const samples = [];

  for (const list of lists) {
    stats.lists++;
    const wiki = await findWiki(list.name);
    // No wiki of its own: a Disney or Pixar title usually lives on the studio's wiki instead
    // (Toy Story's own domain even calls itself "Pixar Wiki"). Tried only where such titles are
    // filed, and every page there must be filed under THIS title -- see filedUnderTitle.
    const wikis = wiki
      ? [{ domain: wiki.domain, filedUnder: null }]
      : STUDIO_WIKI_CATEGORIES.has(list.category)
        ? STUDIO_WIKIS.map((domain) => ({ domain, filedUnder: list.name }))
        : [];
    if (!wikis.length) {
      stats.noWiki++;
      stats.skipped += list.missing;
      console.log(`  ✗ ${list.name} — no matching wiki`);
      continue;
    }
    await sleep(PAUSE_MS);

    const characters = db
      .prepare('SELECT id, name FROM characters WHERE list_id = ? AND image_url IS NULL ORDER BY fame IS NULL, fame DESC')
      .all(list.id);
    // One picture never goes to two different characters in a list. A group screencap reached
    // from two names, or a redirect that sends two characters to one page, both look like this,
    // and 73 stored images of exactly that shape had to be cleared by hand.
    const used = new Set(
      db.prepare('SELECT image_url FROM characters WHERE list_id = ? AND image_url IS NOT NULL').all(list.id).map((r) => r.image_url)
    );

    let found = 0;
    for (const ch of characters) {
      stats.checked++;
      let hit = null;
      for (const w of wikis) {
        hit = await imageFor(w.domain, ch.name, list.name, { filedUnder: w.filedUnder }).catch(() => null);
        await sleep(PAUSE_MS);
        if (hit) break;
      }

      if (!hit) {
        stats.missed++;
        if (verbose) console.log(`      · ${ch.name} — nothing`);
        continue;
      }
      if (looksLikeJunk(hit.image) || !imageIsTrustworthy(list.category, hit.image)) {
        stats.rejected++;
        if (verbose) console.log(`      · ${ch.name} — rejected ${hit.image}`);
        continue;
      }
      if (used.has(hit.image)) {
        stats.rejected++;
        if (verbose) console.log(`      · ${ch.name} — rejected: already another character's picture in this list`);
        continue;
      }
      used.add(hit.image);

      stats.found++;
      found++;
      if (samples.length < 25) samples.push({ list: list.name, name: ch.name, title: hit.title, via: hit.via, image: hit.image });
      if (!dryRun) {
        setCharacterImage(list.id, ch.name, hit.image);
        stats.written++;
      }
    }
    console.log(
      `  ${found ? '✓' : '·'} ${list.name} → ${wiki ? wiki.domain : `${STUDIO_WIKIS.join(' / ')} (filed under the title)`}` +
        `  ${found}/${characters.length}${list.enabled ? '  (selected somewhere)' : ''}`
    );
  }

  console.log('\n--- sample of what was matched ---');
  for (const s of samples) {
    console.log(`  ${s.name}  [${s.list}]`);
    console.log(`      page: ${s.title}  (${s.via})`);
    console.log(`      ${s.image}`);
  }

  const rate = stats.checked ? ((stats.found / stats.checked) * 100).toFixed(1) : '0.0';
  console.log('\n--- summary ---');
  console.log(`  lists:            ${stats.lists}, of which ${stats.noWiki} had no wiki we could find`);
  console.log(`  skipped:          ${stats.skipped}  (characters in those lists -- never asked)`);
  console.log(`  characters asked: ${stats.checked}`);
  console.log(`  artwork found:    ${stats.found}  (${rate}% of those asked)`);
  console.log(`  rejected:         ${stats.rejected}  (junk image, or failed the trust rule)`);
  console.log(`  no match:         ${stats.missed}  (wiki had no usable page)`);
  console.log(dryRun ? '  written:         0  (dry run)' : `  written:         ${stats.written}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
