// Covers the season merging and role filtering in scripts/seed-anilist-characters.js.
//
// AniList files every cour as its own title, so without merging a lobby offers "Attack on
// Titan", "Attack on Titan Season 2", "Attack on Titan Season 3" and "Attack on Titan: The
// Final Season" as four different picks for one show. The risk in merging is the opposite
// mistake -- eating a number that is part of the real title -- so both directions are
// tested.

const { assert } = require('./harness');
const { baseTitle, mergeSeasons, selectCast } = require('../scripts/seed-anilist-characters');

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
};
