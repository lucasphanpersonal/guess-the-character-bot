// Every browser script the web server serves must at least parse.
//
// A client that does not parse is the whole page dead -- no socket, no buttons -- yet nothing else
// here would notice: the unit suite never loads a client, and check:web-socket drives the server
// with its own sockets. A second `let pending` in draw/public/app.js got that far once, and only a
// browser showed it. Compiling is enough to catch it: a repeated declaration is an early error.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { assert } = require('./harness');

const WEB = path.join(__dirname, '..', 'src', 'web');

function clientScripts() {
  const found = [];
  const walk = (dir, served) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, served || e.name === 'public' || e.name === 'shared');
      else if (served && e.name.endsWith('.js')) found.push(p);
    }
  };
  walk(WEB, false);
  return found;
}

// The page's own inline <script> blocks, which no file check reaches.
function inlineScripts() {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) {
        const html = fs.readFileSync(p, 'utf8');
        let i = 0;
        for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) found.push({ file: `${p} #${++i}`, code: m[1] });
      }
    }
  };
  walk(WEB);
  return found;
}

module.exports = {
  'every served client script parses'() {
    const files = clientScripts();
    // Positively: an empty walk would pass every check below.
    for (const want of ['draw/public/app.js', 'desk/public/app.js', 'party/public/app.js', 'shared/common.js']) {
      assert.ok(files.some((f) => f.split(path.sep).join('/').endsWith(want)), `found ${want}`);
    }
    for (const f of files) {
      try {
        new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
      } catch (e) {
        assert.fail(`${f}: ${e.message}`);
      }
    }
  },

  'every inline page script parses'() {
    for (const { file, code } of inlineScripts()) {
      try {
        new vm.Script(code, { filename: file });
      } catch (e) {
        assert.fail(`${file}: ${e.message}`);
      }
    }
  },
};
