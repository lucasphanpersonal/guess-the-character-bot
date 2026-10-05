// Writes a file so that it is either the old version or the new one, never half of the new one.
//
// The fetch scripts rewrite their whole output file after every chunk, and that file is both the
// committed seed data and the resume log. Written in place, a Ctrl-C or a crash mid-write left it
// truncated -- invalid JSON that the next run (and the seeder) could not read. Writing beside it
// and renaming over it is atomic on the same filesystem.

const fs = require('fs');

function writeFileAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

module.exports = { writeFileAtomic };
