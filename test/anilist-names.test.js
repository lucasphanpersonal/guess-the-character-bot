// AniList names as English-speaking fans write them, and the rename that moves the live
// database onto them.

const { assert } = require('./harness');
const db = require('../src/core/db/connection');
const lists = require('../src/compendium/characterLists');
const { englishName, surnameFirstName, foldLongVowels } = require('../scripts/lib/anilistNames');
const { planRenames, applyRenames, undoRenames } = require('../scripts/rename-anilist-characters');

const n = (first, last, middle = null, full = null) => ({ first, middle, last, full });

let counter = 0;
function freshList(category = 'Anime') {
  const scope = `anilist-names-${++counter}`;
  const list = lists.createList(scope, `Show ${counter}`, 'tester', category);
  return { scope, listId: list.id ?? lists.getListByName(scope, `Show ${counter}`).id };
}

module.exports = {
  // Real names from the live library, each as the old importer showed it.
  'given name first, which is how English releases write nearly everyone'() {
    assert.equal(englishName(n('Satoru', 'Gojou'), ['JUJUTSU KAISEN']), 'Satoru Gojo');
    assert.equal(englishName(n('Eren', 'Yeager'), ['Attack on Titan']), 'Eren Yeager');
    assert.equal(englishName(n('Spike', 'Spiegel'), ['Cowboy Bebop']), 'Spike Spiegel');
    assert.equal(englishName(n('Loid', 'Forger'), ['SPY x FAMILY']), 'Loid Forger');
    assert.equal(englishName(n('Edward', 'Wong Hau Pepelu Tivrusky IV'), ['Cowboy Bebop']), 'Edward Wong Hau Pepelu Tivrusky IV');
  },

  'ONE PIECE keeps the order its English releases use'() {
    assert.equal(englishName(n('Luffy', 'Monkey', 'D.'), ['ONE PIECE']), 'Monkey D. Luffy');
    assert.equal(englishName(n('Zoro', 'Roronoa'), ['One Piece Film: Red', 'ONE PIECE FILM RED']), 'Roronoa Zoro');
  },

  // AniList files a few with the surname as the given name, so the old flip happened to be right.
  'a character whose AniList parts are swapped keeps the order it was shown in'() {
    assert.equal(englishName(n('Marcoh', 'Tim'), ['Fullmetal Alchemist: Brotherhood']), 'Tim Marcoh');
    assert.equal(englishName(n('Kuroda', 'Heihachirou'), ['Gintama']), 'Heihachiro Kuroda');
  },

  'a rename shaped like swapped parts is flagged for a person to check'() {
    const { looksOrderSwapped } = require('../scripts/lib/anilistNames');
    assert.equal(looksOrderSwapped('Kuroda Heihachiro'), true);
    assert.equal(looksOrderSwapped('Heihachiro Kuroda'), false);
    assert.equal(looksOrderSwapped('Satoru Gojo'), false);
  },

  'a mononym is left whole'() {
    assert.equal(englishName(n('Levi', null, null, 'Levi'), ['Attack on Titan']), 'Levi');
    assert.equal(englishName(n(null, null, null, 'Nami'), ['ONE PIECE']), 'Nami');
  },

  'long vowels are folded the way English releases write them'() {
    assert.equal(englishName(n('Katsuki', 'Bakugou'), []), 'Katsuki Bakugo');
    assert.equal(englishName(n('Shouyou', 'Hinata'), []), 'Shoyo Hinata');
    assert.equal(englishName(n('Kyoujurou', 'Rengoku'), []), 'Kyojuro Rengoku');
    assert.equal(englishName(n('Yuuji', 'Itadori'), []), 'Yuji Itadori');
    assert.equal(englishName(n('Asuka Langley', 'Souryuu'), []), 'Asuka Langley Soryu');
  },

  // The whole point of checking for romaji first: no Western word may ever be touched.
  'only Japanese words are folded'() {
    for (const word of ['Louise', 'Soul', 'Spike', 'Hound', 'Rouge', 'Moon', 'Youssef']) {
      assert.equal(foldLongVowels(word), word, word);
    }
    assert.equal(foldLongVowels('Inoue'), 'Inoue', 'the u starts the next syllable');
    assert.equal(foldLongVowels('You'), 'You', 'short words keep their usual English spelling');
    assert.equal(foldLongVowels('Jounouchi'), 'Jonouchi', 'Jou-no-uchi');
    for (const word of ['Urouge', 'Mouseman', 'Mousse']) assert.equal(foldLongVowels(word), word, word);
    for (const word of ['House', 'Mouse', 'Mountain', 'Toun', 'Kanoune', 'Haruue']) assert.equal(foldLongVowels(word), word, word);
    for (const word of ['Minoura', 'Kiyoura', 'Yotsuura', 'Oura']) assert.equal(foldLongVowels(word), word, `${word}: -ura is its own syllable`);
    assert.equal(foldLongVowels('Kyouka'), 'Kyoka', 'a long ou before other consonants still folds');
    assert.equal(foldLongVowels('Kyouraku'), 'Kyoraku', 'only a FINAL -ura is spared');
    assert.equal(foldLongVowels('Shuuraku'), 'Shuraku');
  },

  'the old surname-first form is recomputed exactly, so the row can be found'() {
    assert.equal(surnameFirstName(n('Luffy', 'Monkey', 'D.')), 'Monkey D. Luffy');
    assert.equal(surnameFirstName(n('Satoru', 'Gojou')), 'Gojou Satoru');
    assert.equal(surnameFirstName(n('Edward', 'Wong Hau Pepelu Tivrusky IV')), 'Wong Hau Pepelu Tivrusky IV Edward');
  },

  'the rename matches by old name and image, and undoes cleanly'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Gojou Satoru', 'seed-script', 'https://s4.anilist.co/a.png');
    lists.addCharacter(listId, 'Levi', 'seed-script', 'https://s4.anilist.co/b.png');
    const series = {
      1: {
        label: 'JUJUTSU KAISEN',
        characters: [
          { name: 'Satoru Gojo', parts: n('Satoru', 'Gojou'), image: 'https://s4.anilist.co/a.png' },
          { name: 'Levi', parts: n('Levi', null, null, 'Levi'), image: 'https://s4.anilist.co/b.png' },
        ],
      },
    };
    const { renames } = planRenames(db, series);
    const mine = renames.filter((r) => r.listId === listId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].to, 'Satoru Gojo');
    assert.equal(mine[0].matchedBy, 'image');

    applyRenames(db, mine);
    assert.deepEqual(lists.getCharacters(listId).map((c) => c.name).sort(), ['Levi', 'Satoru Gojo']);
    undoRenames(db, mine);
    assert.deepEqual(lists.getCharacters(listId).map((c) => c.name).sort(), ['Gojou Satoru', 'Levi']);
  },

  // One old name for two different people: matching on name alone would have to guess.
  'a name-only match is refused when the old name means two characters'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Kurosaki Ichigo', 'seed-script', 'https://s4.anilist.co/changed.png');
    const series = {
      1: { characters: [{ name: 'Ichigo Kurosaki', parts: n('Ichigo', 'Kurosaki'), image: 'https://s4.anilist.co/x.png' }] },
      2: { characters: [{ name: 'Kurosaki Ichigo', parts: n('Ichigo', 'Kurosaki'), image: 'https://s4.anilist.co/y.png' }], label: 'ONE PIECE' },
    };
    // Same old name, two different new names (the second kept surname-first).
    const { renames } = planRenames(db, series);
    assert.equal(renames.filter((r) => r.listId === listId).length, 0);
  },

  'a name-only match works when the old name is unambiguous, in anime lists only'() {
    const anime = freshList('Anime');
    const tv = freshList('Television Shows');
    lists.addCharacter(anime.listId, 'Yeager Eren', 'seed-script', 'https://s4.anilist.co/old.png');
    lists.addCharacter(tv.listId, 'Yeager Eren', 'seed-script', null);
    const series = { 1: { characters: [{ name: 'Eren Yeager', parts: n('Eren', 'Yeager'), image: 'https://s4.anilist.co/new.png' }] } };
    const { renames } = planRenames(db, series);
    assert.equal(renames.filter((r) => r.listId === anime.listId)[0]?.matchedBy, 'name');
    assert.equal(renames.filter((r) => r.listId === tv.listId).length, 0, 'a TV list is not AniList-seeded');
  },

  'a rename that would collide with a name already in the list is skipped'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Elric Edward', 'seed-script', 'https://s4.anilist.co/e1.png');
    lists.addCharacter(listId, 'Edward Elric', 'someone', null);
    const series = { 1: { characters: [{ name: 'Edward Elric', parts: n('Edward', 'Elric'), image: 'https://s4.anilist.co/e1.png' }] } };
    const { renames, skipped } = planRenames(db, series);
    assert.equal(renames.filter((r) => r.listId === listId).length, 0);
    assert.ok(skipped.collision.some((c) => c.from === 'Elric Edward'));
  },
};
