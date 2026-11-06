// AniList names as English-speaking fans write them, and the rename that moves the live
// database onto them.

const { assert } = require('./harness');
const db = require('../src/core/db/connection');
const lists = require('../src/compendium/characterLists');
const { englishName, surnameFirstName, foldLongVowels } = require('../scripts/lib/anilistNames');
const { planRenames, applyRenames, undoRenames, planMerges, applyMerges, undoMerges } = require('../scripts/rename-anilist-characters');

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
    // Judged on the OLD name, whose first word is AniList's surname.
    assert.equal(looksOrderSwapped('Heihachirou Kuroda'), true);
    assert.equal(looksOrderSwapped('Kuroda Heihachirou'), false);
    assert.equal(looksOrderSwapped('Fushiguro Megumi'), false, 'a surname ending in -ro is ordinary');
    assert.equal(looksOrderSwapped('Gojou Satoru'), false);
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
    for (const [word, folded] of [['Juura', 'Jura'], ['Yuura', 'Yura'], ['Moura', 'Mora']]) {
      assert.equal(foldLongVowels(word), folded, `${word}: too short to be a stem plus -ura`);
    }
    for (const word of ['Matsuura', 'Ouran', 'Rouran', 'Oura']) assert.equal(foldLongVowels(word), word, word);
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

  // The fetch stored a name computed with that day's rules; the rename must not trust it.
  'the new name is recomputed from the parts, not read from the stored name'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Cider House Leader', 'seed-script', 'https://s4.anilist.co/cider.png');
    const series = {
      1: { label: 'My Hero Academia', characters: [
        // What an older fetch stored, before House was an exception.
        { name: 'Cider Hose Leader', parts: n('Cider House Leader', null, null, 'Cider House Leader'), image: 'https://s4.anilist.co/cider.png' },
      ] },
    };
    const { renames } = planRenames(db, series);
    assert.equal(renames.filter((r) => r.listId === listId).length, 0, 'today\'s rules keep the name; the stale "Hose" is ignored');
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

  // Inside a word "oo" is as often two syllables as one long vowel, so only the start folds.
  'a long "oo" folds at the start of a word, and inside one only where listed'() {
    for (const [word, folded] of [['Ootsutsuki', 'Otsutsuki'], ['Oota', 'Ota'], ['Oono', 'Ono'], ['Tooru', 'Toru'], ['Oouchi', 'Ouchi']]) {
      assert.equal(foldLongVowels(word), folded, word);
    }
    for (const word of ['Hiroomi', 'Kiyoomi', 'Morooka', 'Kuroo', 'Moon', 'Goose', 'Moodie', 'Boota', 'Ooi']) {
      assert.equal(foldLongVowels(word), word, word);
    }
  },

  'official spellings and hand-set names win over the rules'() {
    assert.equal(englishName(n('Shouei', 'Barou'), ['Blue Lock']), 'Shoei Barou');
    // Kyouraku's middle names were added on AniList after seeding; the override ignores them.
    assert.equal(englishName(n('Shunsui', 'Kyouraku', 'Jirou Soukyuu'), ['BLEACH']), 'Shunsui Kyoraku');
  },

  // The first pass ran with older rules; the next must find its output, not just the seed's.
  'a second pass finds rows the first one already renamed'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Tooru Oikawa', 'seed-script', 'https://s4.anilist.co/oikawa.png');
    lists.addCharacter(listId, 'Shouei Baro', 'seed-script', 'https://s4.anilist.co/barou.png');
    lists.addCharacter(listId, 'Kyouraku Shunsui', 'seed-script', 'https://s4.anilist.co/shunsui.png');
    lists.addCharacter(listId, 'Satoru Gojo', 'seed-script', 'https://s4.anilist.co/gojo2.png');
    const series = {
      1: { label: 'Mixed', characters: [
        { parts: n('Tooru', 'Oikawa'), image: 'https://s4.anilist.co/oikawa.png' },
        { parts: n('Shouei', 'Barou'), image: 'https://s4.anilist.co/barou.png' },
        { parts: n('Shunsui', 'Kyouraku', 'Jirou Soukyuu'), image: 'https://s4.anilist.co/shunsui.png' },
        { parts: n('Satoru', 'Gojou'), image: 'https://s4.anilist.co/gojo2.png' },
      ] },
    };
    const mine = planRenames(db, series).renames.filter((r) => r.listId === listId);
    assert.deepEqual(mine.map((r) => r.to).sort(), ['Shoei Barou', 'Shunsui Kyoraku', 'Toru Oikawa']);
  },

  'a duplicate is merged into the row holding the name, and the merge undoes'() {
    const { listId } = freshList();
    lists.addCharacter(listId, 'Elric Alphonse', 'seed-script', 'https://s4.anilist.co/al.png');
    lists.addCharacter(listId, 'Alphonse Elric', 'someone', null);
    // Two different characters whose names fold alike: never merged.
    lists.addCharacter(listId, 'Satou Yuuki', 'seed-script', 'https://s4.anilist.co/yuuki.png');
    lists.addCharacter(listId, 'Yuki Sato', 'seed-script', 'https://s4.anilist.co/yuki.png');
    const series = { 1: { characters: [
      { parts: n('Alphonse', 'Elric'), image: 'https://s4.anilist.co/al.png' },
      { parts: n('Yuuki', 'Satou'), image: 'https://s4.anilist.co/yuuki.png' },
      { parts: n('Yuki', 'Sato', 'X'), image: 'https://s4.anilist.co/yuki.png' },
    ] } };
    const collisions = planRenames(db, series).skipped.collision;
    const al = collisions.find((c) => c.from === 'Elric Alphonse');
    const yuuki = collisions.find((c) => c.from === 'Satou Yuuki');
    assert.equal(al.duplicate, true);
    assert.equal(yuuki.duplicate, false, 'another AniList character\'s art means another character');

    const merges = planMerges(db, [al, yuuki]);
    assert.equal(merges.length, 1);
    assert.equal(applyMerges(db, merges), 1);
    const after = lists.getCharacters(listId);
    assert.equal(after.filter((c) => /alphonse/i.test(c.name)).length, 1);
    assert.equal(after.find((c) => c.name === 'Alphonse Elric').image_url, 'https://s4.anilist.co/al.png', 'the picture moves over');

    undoMerges(db, merges);
    const restored = lists.getCharacters(listId);
    assert.deepEqual(restored.filter((c) => /alphonse/i.test(c.name)).map((c) => c.name).sort(), ['Alphonse Elric', 'Elric Alphonse']);
    assert.equal(restored.find((c) => c.name === 'Alphonse Elric').image_url, null);
  },

  // AniList's placeholder is shared by 1,813 characters; INUYASHIKI's Joshi and Joushi both wear it.
  'a shared image is no evidence two rows are one character'() {
    const { listId } = freshList();
    const placeholder = 'https://s4.anilist.co/character/large/default.jpg';
    lists.addCharacter(listId, 'Joushi', 'seed-script', placeholder);
    lists.addCharacter(listId, 'Joshi', 'seed-script', placeholder);
    const series = { 1: { characters: [
      { id: 1, parts: n('Joushi', null, null, 'Joushi'), image: placeholder },
      { id: 2, parts: n('Joshi', null, null, 'Joshi'), image: placeholder },
    ] } };
    const joushi = planRenames(db, series).skipped.collision.find((c) => c.from === 'Joushi');
    assert.equal(joushi.duplicate, false);
    assert.equal(planMerges(db, [joushi]).length, 0);
  },

  'a merge moves rerolls and past games, and undo puts back exactly what was there'() {
    const stats = require('../src/core/db/stats');
    const { listId } = freshList();
    lists.addCharacter(listId, 'Elric Edward', 'seed-script', 'https://s4.anilist.co/ed-merge.png');
    lists.addCharacter(listId, 'Edward Elric', 'someone', null);
    const byName = (name) => lists.getCharacters(listId).find((c) => c.name === name);
    const gone = byName('Elric Edward');
    const kept = byName('Edward Elric');
    // U rerolled both rows; V only the duplicate. U's reroll on the kept row must survive an undo.
    lists.recordReroll(kept.id, 'merge-U');
    lists.recordReroll(gone.id, 'merge-U');
    lists.recordReroll(gone.id, 'merge-V');
    stats.recordGame('merge-guild', [{ playerId: 'merge-P', turnsTaken: 3, outcome: 'won', characterId: gone.id }]);
    const rerollUsers = (id) => db.prepare('SELECT user_id FROM character_rerolls WHERE character_id = ? ORDER BY user_id').all(id).map((r) => r.user_id);
    const gamesOf = (id) => db.prepare('SELECT COUNT(*) AS n FROM game_players WHERE character_id = ?').get(id).n;
    const keptBefore = db.prepare('SELECT id FROM character_rerolls WHERE character_id = ? AND user_id = ?').get(kept.id, 'merge-U').id;

    const series = { 1: { characters: [{ id: 3, parts: n('Edward', 'Elric'), image: 'https://s4.anilist.co/ed-merge.png' }] } };
    const collision = planRenames(db, series).skipped.collision.find((c) => c.id === gone.id);
    const merges = planMerges(db, [collision]);
    assert.equal(applyMerges(db, merges), 1);
    assert.deepEqual(rerollUsers(kept.id), ['merge-U', 'merge-V']);
    assert.equal(gamesOf(kept.id), 1, 'the past game now names the kept row');

    undoMerges(db, merges);
    assert.deepEqual(rerollUsers(kept.id), ['merge-U']);
    assert.equal(db.prepare('SELECT id FROM character_rerolls WHERE character_id = ? AND user_id = ?').get(kept.id, 'merge-U').id, keptBefore);
    assert.deepEqual(rerollUsers(gone.id), ['merge-U', 'merge-V']);
    assert.equal(gamesOf(gone.id), 1);
    assert.equal(gamesOf(kept.id), 0);
  },

  'a row kept by one merge and deleted by another is left alone'() {
    const { listId } = freshList();
    for (const name of ['Chain A', 'Chain B', 'Chain C']) lists.addCharacter(listId, name, 'someone', null);
    const [a, b, c] = ['Chain A', 'Chain B', 'Chain C'].map((name) => lists.getCharacters(listId).find((x) => x.name === name).id);
    // A merges into B, B into C: B would take A's games and then be deleted with them.
    const merges = planMerges(db, [
      { id: a, keepId: b, duplicate: true },
      { id: b, keepId: c, duplicate: true },
    ]);
    assert.deepEqual(merges.map((m) => [m.gone.id, m.keepId]), [[b, c]]);
  },
};
