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

// Each page's local scripts, in load order, as files. The paths mirror how the server maps them:
// /shared/ and the game mounts by prefix, any other absolute path from the phones' root, and a
// relative one beside the page.
function pageScripts(htmlFile) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const mounts = { '/shared/': 'shared', '/desk/': 'desk/public', '/draw/': 'draw/public' };
  const out = [];
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
    const ref = m[1];
    if (ref.startsWith('/socket.io/') || /^https?:/.test(ref)) continue;
    const mount = Object.keys(mounts).find((p) => ref.startsWith(p));
    if (mount) out.push(path.join(WEB, mounts[mount], ref.slice(mount.length)));
    else if (ref.startsWith('/')) out.push(path.join(WEB, 'party', 'public', ref.slice(1)));
    else out.push(path.join(path.dirname(htmlFile), ref));
  }
  return out;
}

// Top-level declarations, by this codebase's layout: a declaration at the top level starts in
// column 0, and nothing nested does.
const topLevelNames = (code) =>
  [...code.matchAll(/^(?:const|let|var|class|(?:async )?function\*?)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);

module.exports = {
  // Plain scripts share one global scope, so a page's files are one program: the same `let` in two
  // of them is a SyntaxError when the second loads -- and every file parses perfectly on its own,
  // so the test above cannot see it. The phones' client is six files (party/public/app.js).
  "no two of a page's scripts declare the same top-level name"() {
    const pages = ['party/public/index.html', 'desk/public/index.html', 'draw/public/index.html'].map((p) => path.join(WEB, p));
    for (const page of pages) {
      const files = pageScripts(page);
      assert.ok(files.length >= 3, `${page}: found its scripts (${files.length})`);
      const seen = new Map();
      for (const f of files) {
        assert.ok(fs.existsSync(f), `${page} loads ${f}, which exists`);
        for (const name of topLevelNames(fs.readFileSync(f, 'utf8'))) {
          assert.ok(!seen.has(name), `${page}: \`${name}\` is declared in both ${seen.get(name)} and ${path.basename(f)}`);
          seen.set(name, path.basename(f));
        }
      }
    }
  },

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
