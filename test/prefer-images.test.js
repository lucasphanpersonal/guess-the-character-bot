// getRandomCharacters / getRandomCharacterExcluding with { preferImages }, used by the web app
// so the full-screen forehead reveal is a picture whenever the pool can supply enough.

const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');

let n = 0;
function seed({ withImages, withoutImages }) {
  const guildId = `prefimg-${++n}`;
  db.prepare('DELETE FROM character_lists WHERE owner_scope = ?').run(guildId);
  const listId = lists.createList(guildId, 'Pref List', 'tester', 'Test', { enabled: true });
  for (let i = 0; i < withImages; i++) lists.addCharacter(listId, `Img ${i}`, 'tester', `https://x/${i}.png`);
  for (let i = 0; i < withoutImages; i++) lists.addCharacter(listId, `Text ${i}`, 'tester', null);
  return [listId];
}

function prefersImagesWhenEnoughExist() {
  const listIds = seed({ withImages: 5, withoutImages: 5 });
  const drawn = lists.getRandomCharacters(listIds, 4, [], 'everything', { preferImages: true });
  assert.equal(drawn.length, 4);
  assert.ok(drawn.every((c) => c.image_url), 'every dealt character has artwork');
}

function fallsBackWhenNotEnoughImagesToFill() {
  const listIds = seed({ withImages: 2, withoutImages: 6 });
  // Need 5 but only 2 have images -> must fall back to the full pool rather than deal short.
  const drawn = lists.getRandomCharacters(listIds, 5, [], 'everything', { preferImages: true });
  assert.equal(drawn.length, 5);
}

function withoutTheFlagImagesAreNotPreferred() {
  const listIds = seed({ withImages: 1, withoutImages: 30 });
  // With 30:1 odds and no preference, a plain draw should (almost surely) include a text one.
  const drawn = lists.getRandomCharacters(listIds, 10, [], 'everything');
  assert.ok(drawn.some((c) => !c.image_url), 'plain draw is not image-restricted');
}

function rerollPrefersAnImageCharacter() {
  const listIds = seed({ withImages: 3, withoutImages: 3 });
  const pick = lists.getRandomCharacterExcluding(listIds, new Set(), 'everything', { preferImages: true });
  assert.ok(pick && pick.image_url, 'reroll lands on an image-bearing character');
}

module.exports = {
  'prefers images when enough exist': prefersImagesWhenEnoughExist,
  'falls back when not enough images to fill': fallsBackWhenNotEnoughImagesToFill,
  'without the flag images are not preferred': withoutTheFlagImagesAreNotPreferred,
  'reroll prefers an image character': rerollPrefersAnImageCharacter,
};
