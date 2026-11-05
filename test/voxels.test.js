// The voxel objects (src/web/shared/voxels.js). The cap below is what keeps them affordable: each
// cube is an instance a mid-range phone draws up to 24 times a second.

const { assert } = require('./harness');
const Voxels = require('../src/web/shared/voxels');

const MAX_CUBES = 3000;

module.exports = {
  'every object is real, within budget, and has no two cubes in one cell'() {
    assert.ok(Voxels.names.length >= 4, 'found the objects');
    for (const name of Voxels.names) {
      const cubes = Voxels.build(name);
      assert.ok(cubes.length > 50, `${name} has cubes (${cubes.length})`);
      assert.ok(cubes.length <= MAX_CUBES, `${name} is within budget (${cubes.length})`);
      const cells = new Set(cubes.map((c) => `${c.x},${c.y},${c.z}`));
      assert.equal(cells.size, cubes.length, `${name}: one cube per cell`);
      for (const c of cubes) {
        assert.ok(Number.isInteger(c.x) && Number.isInteger(c.y) && Number.isInteger(c.z), `${name}: whole-number cells`);
        assert.ok(c.colour >= 0 && c.colour <= 0xffffff, `${name}: a real colour`);
      }
      assert.ok(typeof Voxels.pose(name).spin === 'boolean', `${name} has a pose`);
    }
  },

  'hidden cubes are left out'() {
    // A solid object with every cube kept would be far over budget, so this is what pays for them.
    const head = Voxels.build('mascot');
    const has = new Set(head.map((c) => `${c.x},${c.y},${c.z}`));
    // The middle of the head has no reason to exist.
    assert.ok(!has.has('0,2,0'), 'the inside of the head is not drawn');
    // And the front of the head is: positively, or an empty model would pass the line above.
    assert.ok(has.has('-4,0,5'), 'an eye is drawn');
  },

  'an unknown name falls back to the mascot rather than throwing'() {
    assert.equal(Voxels.build('nope').length, Voxels.build('mascot').length);
  },
};
