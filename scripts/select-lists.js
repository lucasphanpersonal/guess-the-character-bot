// Shows or changes one scope's playable selection -- which lists its random deals draw from.
//
// The web app has no admin screen, so this is how its selection is set; it works for any scope.
//
//   node scripts/select-lists.js                                  # show the web's selection
//   node scripts/select-lists.js --scope=<id>                     # ... or any scope's
//   node scripts/select-lists.js --top=100 [--category=Anime]     # exactly the top N, by fame
//   node scripts/select-lists.js --top=100 --reset                # clear everything first
//   node scripts/select-lists.js --add="Naruto" --remove="Bleach" # one list at a time
//   node scripts/select-lists.js --copy-from=<scope>              # replace with another's
//
// The default scope is the web app's: WEB_SCOPE if set, else 'web'. --top is EXACT, not
// additive, for the reason setTopN gives in src/compendium/characterLists.js.

const lists = require('../src/compendium/characterLists');
const db = require('../src/compendium/db');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const all = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const scope = flag('scope') || lists.WEB_SCOPE;

function report() {
  const counts = lists.listCategoriesWithEnabledCounts(scope);
  const on = counts.reduce((n, c) => n + c.enabled, 0);
  console.log(`Scope "${scope}": ${on} list(s) in the playable selection.`);
  for (const c of counts) if (c.enabled) console.log(`  ${c.category}: ${c.enabled} of ${c.count}`);
}

function byName(name) {
  const list = lists.getListByName(scope, name);
  if (!list) {
    console.error(`No list named "${name}" is visible to scope "${scope}".`);
    process.exitCode = 1;
  }
  return list;
}

function main() {
  const copyFrom = flag('copy-from');
  if (copyFrom) {
    const source = lists.getEnabledLists(copyFrom).map((l) => l.id);
    // One transaction: a half-copied selection is a pool nobody chose.
    db.transaction(() => {
      lists.disableAllLists(scope);
      lists.setListsEnabled(scope, source, true);
    })();
    // Lists private to the source scope are invisible here and were skipped by setListsEnabled.
    const landed = lists.getEnabledLists(scope).length;
    console.log(`Copied ${landed} of ${source.length} list(s) from "${copyFrom}".`);
  }

  const top = flag('top');
  if (top != null) {
    const n = Number(top);
    if (!Number.isInteger(n) || n < 0) throw new Error('--top needs a whole number');
    if (args.includes('--reset')) console.log(`Cleared ${lists.disableAllLists(scope)} list(s).`);
    const { enabled, disabled } = lists.setTopN(scope, flag('category') ?? null, n);
    console.log(`Top ${n}${flag('category') ? ` of ${flag('category')}` : ' of every category'}: ${enabled} on, ${disabled} off.`);
  }

  for (const name of all('add')) {
    const list = byName(name);
    if (list) console.log(`${lists.setListsEnabled(scope, [list.id], true) ? 'Added' : 'Already in'}: ${list.name}`);
  }
  for (const name of all('remove')) {
    const list = byName(name);
    if (list) console.log(`${lists.setListsEnabled(scope, [list.id], false) ? 'Removed' : 'Was not in'}: ${list.name}`);
  }

  report();
}

main();
