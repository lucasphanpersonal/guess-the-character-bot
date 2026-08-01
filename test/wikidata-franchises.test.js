// Covers mergeFranchises in scripts/seed-wikidata-characters.js.
//
// Wikidata files every numbered game as its own item, so without merging, one franchise
// like Kingdom Hearts would offer "Kingdom Hearts", "Kingdom Hearts II" and "Kingdom Hearts
// III" as three unrelated lists with overlapping casts. fetch-wikidata-characters.js tags
// each entry with its franchise via Wikidata's own "part of the series" link; this is the
// merge that link enables.

const { assert } = require('./harness');
const { mergeFranchises, baseGameTitle } = require('../scripts/seed-wikidata-characters');

const ch = (name, sitelinks = 0) => ({ qid: `Q${name}`, name, sitelinks, image: null });

module.exports = {
  'franchise entries collapse into one list with the casts unioned'() {
    const series = [
      { label: 'Kingdom Hearts', category: 'Video Games', franchise: 'Kingdom Hearts', characters: [ch('Sora', 10), ch('Kairi', 5)] },
      { label: 'Kingdom Hearts II', category: 'Video Games', franchise: 'Kingdom Hearts', characters: [ch('Sora', 10), ch('Roxas', 8)] },
      { label: 'Kingdom Hearts III', category: 'Video Games', franchise: 'Kingdom Hearts', characters: [ch('Sora', 10), ch('Riku', 9)] },
    ];
    const merged = mergeFranchises(series);
    assert.equal(merged.length, 1, 'one list, not three');
    assert.equal(merged[0].label, 'Kingdom Hearts');
    assert.equal(merged[0].mergedFrom, 3);
    assert.deepEqual(
      merged[0].characters.map((c) => c.name).sort(),
      ['Kairi', 'Riku', 'Roxas', 'Sora'],
      'union, Sora counted once'
    );
  },

  'a title with no franchise tag passes through untouched'() {
    const series = [
      { label: 'Persona 5', category: 'Video Games', characters: [ch('Joker'), ch('Ryuji')] },
    ];
    const merged = mergeFranchises(series);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].label, 'Persona 5');
    assert.equal(merged[0].mergedFrom, undefined, 'no merge marker on a standalone title');
  },

  'category is decided by majority vote among the merged entries'() {
    const series = [
      { label: 'A', category: 'Movies', franchise: 'Mixed', characters: [ch('X'), ch('Y'), ch('Z')] },
      { label: 'B', category: 'Video Games', franchise: 'Mixed', characters: [ch('X')] },
      { label: 'C', category: 'Video Games', franchise: 'Mixed', characters: [ch('X')] },
    ];
    const merged = mergeFranchises(series);
    assert.equal(merged[0].category, 'Video Games', '2 votes beats 1');
  },

  // P179 only covered about half the games swept, so titles are the fallback.
  'entry markers are stripped to find a series name'() {
    assert.equal(baseGameTitle('Final Fantasy XVI'), 'Final Fantasy');
    assert.equal(baseGameTitle('Resident Evil 5'), 'Resident Evil');
    assert.equal(baseGameTitle('Final Fantasy XIV: Endwalker'), 'Final Fantasy');
    assert.equal(baseGameTitle('Kingdom Hearts Final Mix'), 'Kingdom Hearts');
    assert.equal(baseGameTitle('Resident Evil 2'), 'Resident Evil');
  },

  // Only merge on title when two entries agree, so a one-off game keeps its own name
  // rather than being renamed to a series that does not exist.
  'a lone untagged title is not renamed'() {
    const merged = mergeFranchises([
      { label: 'Hades II', category: 'Video Games', characters: [{ name: 'Melinoe', sitelinks: 1 }] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].label, 'Hades II', 'kept its full title');
  },

  'two untagged entries sharing a base do merge'() {
    const merged = mergeFranchises([
      { label: 'Resident Evil 2', category: 'Video Games', characters: [{ name: 'Leon S. Kennedy', sitelinks: 5 }] },
      { label: 'Resident Evil 5', category: 'Video Games', characters: [{ name: 'Chris Redfield', sitelinks: 4 }] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].label, 'Resident Evil');
    assert.equal(merged[0].mergedFrom, 2);
  },

  'franchise and standalone titles can coexist in the same sweep'() {
    const series = [
      { label: 'Zelda I', category: 'Video Games', franchise: 'The Legend of Zelda', characters: [ch('Link', 5)] },
      { label: 'Zelda II', category: 'Video Games', franchise: 'The Legend of Zelda', characters: [ch('Link', 5), ch('Zelda', 4)] },
      { label: 'Hades', category: 'Video Games', characters: [ch('Zagreus'), ch('Hades')] },
    ];
    const merged = mergeFranchises(series);
    const labels = merged.map((m) => m.label).sort();
    assert.deepEqual(labels, ['Hades', 'The Legend of Zelda']);
  },
};
