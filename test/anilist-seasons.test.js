// Covers the season merging and role filtering in scripts/seed-anilist-characters.js.
//
// AniList files every cour as its own title, so without merging a lobby offers "Attack on
// Titan", "Attack on Titan Season 2", "Attack on Titan Season 3" and "Attack on Titan: The
// Final Season" as four different picks for one show. The risk in merging is the opposite
// mistake -- eating a number that is part of the real title -- so both directions are
// tested.

const { assert } = require('./harness');
const {
  baseTitle,
  mergeSeasons,
  selectCast,
  parseArgs,
  MIN_CHARACTERS,
  FAME_FLOOR,
  PER_SHOW_LIMIT,
} = require('../scripts/seed-anilist-characters');

const character = (name, favourites = 0, role = 'MAIN') => ({ name, favourites, role, image: null });

module.exports = {
  'season and part markers are stripped'() {
    assert.equal(baseTitle('Attack on Titan Season 2'), 'Attack on Titan');
    assert.equal(baseTitle('Attack on Titan: The Final Season'), 'Attack on Titan');
    assert.equal(baseTitle('Jujutsu Kaisen 2nd Season'), 'Jujutsu Kaisen');
    assert.equal(baseTitle('Vinland Saga Season 2'), 'Vinland Saga');
    assert.equal(baseTitle('Spy x Family Part 2'), 'Spy x Family');
    assert.equal(baseTitle('Overlord IV'), 'Overlord');
  },

  // A trailing number is usually part of the name, not a season marker.
  'numbers that belong to the title are left alone'() {
    assert.equal(baseTitle('Steins;Gate 0'), 'Steins;Gate 0');
    assert.equal(baseTitle('Mob Psycho 100'), 'Mob Psycho 100');
    assert.equal(baseTitle('One Piece'), 'One Piece');
    assert.equal(baseTitle('Hunter x Hunter (2011)'), 'Hunter x Hunter (2011)');
    assert.equal(baseTitle('Demon Slayer: Kimetsu no Yaiba'), 'Demon Slayer: Kimetsu no Yaiba');
  },

  'seasons collapse into one title with the casts unioned'() {
    const merged = mergeSeasons([
      { label: 'Attack on Titan', category: 'Anime', popularity: 900, characters: [character('Eren Yeager'), character('Mikasa Ackerman')] },
      { label: 'Attack on Titan Season 2', category: 'Anime', popularity: 400, characters: [character('Mikasa Ackerman'), character('Zeke Yeager')] },
      { label: 'One Piece', category: 'Anime', popularity: 950, characters: [character('Monkey D. Luffy')] },
    ]);

    assert.equal(merged.length, 2, 'two shows, not three');
    const aot = merged.find((m) => m.label === 'Attack on Titan');
    assert.equal(aot.mergedFrom, 2, 'recorded the merge');
    assert.deepEqual(
      aot.characters.map((c) => c.name),
      ['Eren Yeager', 'Mikasa Ackerman', 'Zeke Yeager'],
      'union, no duplicate Mikasa'
    );
  },

  // AniList's own BACKGROUND label is the walk-on marker, which is a better signal than any
  // fame threshold -- it is the show's view of who matters.
  'background characters are skipped unless asked for'() {
    const cast = [
      character('Monkey D. Luffy', 36038, 'MAIN'),
      character('Shanks', 5815, 'SUPPORTING'),
      character('Random Marine', 0, 'BACKGROUND'),
    ];

    assert.deepEqual(
      selectCast(cast, { includeBackground: false, perShow: null }).map((c) => c.name),
      ['Monkey D. Luffy', 'Shanks']
    );
    assert.equal(selectCast(cast, { includeBackground: true, perShow: null }).length, 3);
  },

  'the cast is ordered by favourites and can be capped'() {
    const cast = [
      character('Usopp', 6756),
      character('Monkey D. Luffy', 36038),
      character('Roronoa Zoro', 28790),
    ];
    assert.deepEqual(
      selectCast(cast, { includeBackground: false, perShow: 2 }).map((c) => c.name),
      ['Monkey D. Luffy', 'Roronoa Zoro']
    );
  },

  // The fame floor is measured against the show's own best-known character, which is the
  // whole point: a flat rank cut keeps One Piece's #30 (1,486 favourites, famous) and Cowboy
  // Bebop's #30 (3 favourites, nobody) on the same reasoning.
  'the fame floor is relative to the show, not to anime as a whole'() {
    // The same 30-favourite character, in two shows of very different reach.
    const bigShow = [
      character('Monkey D. Luffy', 36038, 'SUPPORTING'),
      character('Roronoa Zoro', 28790, 'SUPPORTING'),
      character('Sanji', 15256, 'SUPPORTING'),
      character('Minor Marine', 30, 'SUPPORTING'),
    ];
    const smallShow = [
      character('Spike Spiegel', 1000, 'SUPPORTING'),
      character('Faye Valentine', 700, 'SUPPORTING'),
      character('Jet Black', 500, 'SUPPORTING'),
      character('Vicious', 30, 'SUPPORTING'),
    ];
    const opts = { includeBackground: false, perShow: null, fameFloor: 0.02 };

    assert.deepEqual(
      selectCast(bigShow, opts).map((c) => c.name),
      ['Monkey D. Luffy', 'Roronoa Zoro', 'Sanji'],
      '2% of 36,038 is 721, so 30 favourites is nothing here'
    );
    assert.deepEqual(
      selectCast(smallShow, opts).map((c) => c.name),
      ['Spike Spiegel', 'Faye Valentine', 'Jet Black', 'Vicious'],
      '2% of 1,000 is 20, so the same 30 favourites is a known character here'
    );
  },

  // The show's own billing outranks a popularity vote: in an ensemble where one character
  // dwarfs the rest, the other leads are still leads.
  'a MAIN character is kept however few favourites they have'() {
    const cast = [
      character('Breakout Star', 50000, 'MAIN'),
      character('Second Billing', 2000, 'SUPPORTING'),
      character('Third Billing', 1500, 'SUPPORTING'),
      character('Overlooked Lead', 12, 'MAIN'),
      // Identical fame to the overlooked lead, but no billing to stand on.
      character('Some Extra', 12, 'SUPPORTING'),
    ];
    const kept = selectCast(cast, { includeBackground: false, perShow: null, fameFloor: 0.02 });
    assert.deepEqual(
      kept.map((c) => c.name),
      ['Breakout Star', 'Second Billing', 'Third Billing', 'Overlooked Lead'],
      'the lead is rescued by their role, the extra on the same favourites is not'
    );
  },

  // A title nobody has favourited would otherwise be trimmed out of existence.
  'a show with no famous members keeps a playable list rather than vanishing'() {
    const cast = [
      character('A', 0, 'SUPPORTING'),
      character('B', 0, 'SUPPORTING'),
      character('C', 0, 'SUPPORTING'),
      character('D', 0, 'SUPPORTING'),
    ];
    // Everything ties at zero, so the floor cannot separate them -- but a zero threshold
    // keeps them all, and the MIN_CHARACTERS fallback covers the case where it can't.
    const kept = selectCast(cast, { includeBackground: false, perShow: null, fameFloor: 0.5 });
    assert.ok(kept.length >= MIN_CHARACTERS, `kept ${kept.length}, need at least ${MIN_CHARACTERS}`);
  },

  'trimming is on by default and can be turned off from the command line'() {
    const defaults = parseArgs(['guild-1']);
    assert.equal(defaults.fameFloor, FAME_FLOOR, 'the floor applies without being asked for');
    assert.equal(defaults.perShow, PER_SHOW_LIMIT, 'and so does the cap');

    // Taken as a percent, so the flag reads the way the trade-off is discussed.
    assert.equal(parseArgs(['guild-1', '--fame-floor', '1.5']).fameFloor, 0.015);
    assert.equal(parseArgs(['guild-1', '--fame-floor', '0']).fameFloor, 0, 'keep everything');
    assert.throws(() => parseArgs(['guild-1', '--fame-floor', '250']), /fame-floor/);
  },
};
