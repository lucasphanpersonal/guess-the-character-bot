// The compendium's scopes (src/compendium/characterLists.js): one shared set of lists that
// everyone sees, private lists that only their maker sees, and a playable selection per scope.
//
// The bug this structure exists to prevent: the selection used to be an `enabled` column ON the
// list, shared by the Discord server and the web app, so changing what one dealt changed what the
// other dealt. And the migration from that layout is a table rebuild over the live database --
// the one change here that can lose data -- so it is pinned too, against a hand-built old DB.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { assert } = require('./harness');
const lists = require('../src/compendium/characterLists');
const db = require('../src/core/db/connection');
const { migrate } = require('../src/compendium/db');

let n = 0;
// Shared lists are visible to EVERY scope in the test database, including other suites' -- so
// each is uniquely named and removed in a finally, never left for a later count to trip over.
function withSharedList(fn) {
  const name = `Shared Show ${++n}-${Date.now()}`;
  const id = lists.createList(null, name, 'tester', 'Scope Tests');
  lists.addCharacter(id, `Shared Hero ${n}`, 'tester');
  try {
    return fn({ id, name, hero: `Shared Hero ${n}` });
  } finally {
    db.prepare('DELETE FROM character_lists WHERE id = ?').run(id);
  }
}
const scope = (label) => `scope-${label}-${++n}`;

// --- visibility -----------------------------------------------------------------------------

function aSharedListIsVisibleToEveryScope() {
  withSharedList(({ id, name }) => {
    for (const s of [scope('a'), scope('b'), 'web']) {
      assert.equal(lists.getListByName(s, name)?.id, id, `${s} finds it by name`);
      assert.ok(lists.listLists(s).some((l) => l.id === id), `${s} lists it`);
      assert.ok(lists.isVisibleTo(lists.getListsByIds([id], s)[0], s));
    }
  });
}

function aPrivateListIsVisibleOnlyToItsOwner() {
  const owner = scope('owner');
  const other = scope('other');
  const id = lists.createList(owner, 'Our In-Jokes', 'tester', 'Scope Tests');
  const charId = lists.addCharacter(id, 'Dave From Accounts', 'tester');

  assert.ok(lists.getListByName(owner, 'Our In-Jokes'), 'the owner sees it');
  assert.equal(lists.getListByName(other, 'Our In-Jokes'), null, 'nobody else does');
  assert.equal(lists.listLists(other).some((l) => l.id === id), false);
  assert.equal(lists.isVisibleTo(lists.getListsByIds([id], other)[0], other), false, 'a client-supplied id is caught');
  // The lookups that take a client-supplied id or a search term are the ones that could leak.
  assert.ok(lists.getCharacterById(owner, charId));
  assert.equal(lists.getCharacterById(other, charId), null);
  assert.equal(lists.searchCharactersInScope(other, 'Dave From').length, 0);
  assert.equal(lists.getListByName(null, 'Our In-Jokes'), null, 'not part of the shared compendium either');
}

function aScopesOwnListWinsANameClashWithASharedOne() {
  withSharedList(({ name }) => {
    const s = scope('clash');
    const own = lists.createList(s, name, 'tester', 'Scope Tests');
    assert.equal(lists.getListByName(s, name).id, own, 'its own list');
    assert.notEqual(lists.getListByName(scope('else'), name).id, own, 'everyone else gets the shared one');
  });
}

function twoSharedListsCannotShareAName() {
  withSharedList(({ name }) => {
    // The seed scripts rely on this: a second insert of a name must fail, not duplicate. Easy to
    // lose, because a plain UNIQUE(owner_scope, name) treats every NULL owner as distinct.
    assert.throws(() => lists.createList(null, name, 'tester', 'Scope Tests'), /UNIQUE/);
  });
}

// --- selections -----------------------------------------------------------------------------

function selectionsArePerScope() {
  withSharedList(({ id }) => {
    const discord = scope('discord');
    const web = scope('web');

    lists.setListsEnabled(discord, [id], true);
    assert.equal(lists.getListsByIds([id], discord)[0].enabled, 1, 'on for the server that chose it');
    assert.equal(lists.getListsByIds([id], web)[0].enabled, 0, 'and still off for the web');
    assert.ok(lists.getEnabledLists(discord).some((l) => l.id === id));
    assert.equal(lists.getEnabledLists(web).some((l) => l.id === id), false);

    assert.equal(lists.toggleListEnabled(web, id), true, 'the web switches it on for itself');
    lists.disableAllLists(discord);
    assert.equal(lists.getListsByIds([id], web)[0].enabled, 1, "clearing the server's selection leaves the web's alone");
  });
}

function aScopeCannotSelectAListItCannotSee() {
  const id = lists.createList(scope('owner'), 'Private Show', 'tester', 'Scope Tests');
  const outsider = scope('outsider');
  assert.equal(lists.setListsEnabled(outsider, [id], true), 0, 'nothing was switched on');
  assert.equal(lists.getEnabledLists(outsider).length, 0);
}

function theCompendiumItselfHasNoSelection() {
  withSharedList(({ id }) => {
    assert.throws(() => lists.setListsEnabled(null, [id], true), /scope/);
    assert.throws(() => lists.toggleListEnabled(null, id), /scope/);
    assert.equal(lists.getListsByIds([id], null)[0].enabled, 0);
  });
}

function deletingAListTakesItsSelectionsWithIt() {
  const s = scope('cascade');
  const id = lists.createList(s, 'Short-Lived', 'tester', 'Scope Tests', { enabled: true });
  assert.equal(lists.getEnabledLists(s).length, 1);
  db.prepare('DELETE FROM character_lists WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM list_selection WHERE list_id = ?').get(id).n, 0);
}

// --- /list create ---------------------------------------------------------------------------

// A hand-made list is wanted wherever the bot is played: shared, playable at once where it was
// typed and on the web, and waiting for any other server to choose it.
async function listCreateMakesASharedListPlayableHereAndOnTheWeb() {
  const create = require('../src/discord/commands/actions/list-create');
  const { createRecorder, createFakeClient, createSlashInteraction } = require('./harness');
  const here = scope('creator');
  const elsewhere = scope('elsewhere');
  const name = `Hand Made ${++n}-${Date.now()}`;
  const recorder = createRecorder();
  try {
    await create.execute(
      createSlashInteraction({
        client: createFakeClient(recorder),
        userId: 'owner',
        guildId: here,
        channelId: 'create-channel',
        options: { name, category: 'Scope Tests' },
        recorder,
        canManageGuild: true,
      })
    );
    const list = lists.getListByName(elsewhere, name);
    assert.ok(list, 'another server can see it');
    assert.equal(list.owner_scope, null, 'because it is shared');
    assert.equal(list.enabled, 0, "but it is off there until that server chooses it");
    assert.equal(lists.getListByName(here, name).enabled, 1, 'on where it was made');
    assert.equal(lists.getListByName(lists.WEB_SCOPE, name).enabled, 1, 'and on the web');
    assert.match(recorder.allText(), /Created character list/);
  } finally {
    db.prepare('DELETE FROM character_lists WHERE name = ? AND owner_scope IS NULL').run(name);
  }
}

// --- migration from the guild-scoped layout -------------------------------------------------

// The layout as it shipped before scopes, close enough to the real one to exercise every step.
function legacyDatabase() {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  old.exec(`
    CREATE TABLE character_lists (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, category TEXT, enabled INTEGER NOT NULL DEFAULT 0, popularity INTEGER,
      UNIQUE(guild_id, name COLLATE NOCASE)
    );
    CREATE TABLE characters (
      id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES character_lists(id) ON DELETE CASCADE,
      name TEXT NOT NULL, added_by TEXT NOT NULL, created_at INTEGER NOT NULL, image_url TEXT, fame INTEGER,
      UNIQUE(list_id, name COLLATE NOCASE)
    );
    CREATE TABLE character_rerolls (
      id INTEGER PRIMARY KEY, character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(character_id, user_id)
    );
  `);
  const list = old.prepare(
    'INSERT INTO character_lists (id, guild_id, name, created_by, created_at, category, enabled, popularity) VALUES (?, ?, ?, ?, 0, ?, ?, ?)'
  );
  // The content guild: most enabled lists. Two seeded (one on), one hand-made (on).
  list.run(1, 'main', 'Naruto', 'seed-script', 'Anime', 1, 900);
  list.run(2, 'main', 'Bleach', 'seed-script', 'Anime', 0, 800);
  list.run(3, 'main', 'Our Friends', '1234', 'Real People', 1, null);
  // A second guild with its OWN seeded copy of a name the content guild also has, and a
  // hand-made list of its own.
  list.run(4, 'side', 'Naruto', 'seed-script', 'Anime', 1, 900);
  list.run(5, 'side', 'Side Jokes', '5678', 'Real People', 1, null);
  const character = old.prepare('INSERT INTO characters (list_id, name, added_by, created_at) VALUES (?, ?, ?, 0)');
  for (const [listId, name] of [[1, 'Naruto Uzumaki'], [1, 'Sasuke'], [2, 'Ichigo'], [3, 'Dave'], [4, 'Naruto Uzumaki'], [5, 'Bob']]) {
    character.run(listId, name, 'seed-script');
  }
  old.prepare('INSERT INTO character_rerolls (character_id, user_id, created_at) VALUES (1, ?, 0)').run('u1');
  return old;
}

function theMigrationSharesTheContentGuildAndKeepsEverySelection() {
  const old = legacyDatabase();
  migrate(old);

  const owners = Object.fromEntries(
    old.prepare('SELECT id, owner_scope FROM character_lists').all().map((r) => [r.id, r.owner_scope])
  );
  assert.equal(owners[1], null, "the content guild's seeded lists become shared");
  assert.equal(owners[2], null);
  // The web could already see these, so the migration must not take them away from it.
  assert.equal(owners[3], null, "and so do its hand-made ones");
  assert.equal(owners[4], 'side', "another guild's seeded copy stays private -- two shared Narutos would clash");
  assert.equal(owners[5], 'side', "and so does another guild's hand-made list");

  const selected = (s) =>
    old.prepare('SELECT list_id FROM list_selection WHERE scope = ? ORDER BY list_id').all(s).map((r) => r.list_id);
  assert.deepEqual(selected('main'), [1, 3], 'each guild keeps exactly what it had on');
  assert.deepEqual(selected('side'), [4, 5]);
  assert.deepEqual(selected('web'), [1, 3], "the web inherits the content guild's selection, hand-made lists included");

  // Nothing lost, nothing dangling.
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM characters').get().n, 6);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM character_rerolls').get().n, 1);
  assert.deepEqual(old.pragma('foreign_key_check'), []);
  assert.equal(old.pragma('foreign_keys', { simple: true }), 1, 'foreign keys are back on');
}

function theMigratedForeignKeysStillCascade() {
  const old = legacyDatabase();
  migrate(old);
  // The failure the rebuild guards against: rename the OLD table away and characters' foreign
  // key follows it, so deleting a list no longer reaches its characters.
  old.prepare('DELETE FROM character_lists WHERE id = 1').run();
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM characters WHERE list_id = 1').get().n, 0);
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM list_selection WHERE list_id = 1').get().n, 0);
}

function theMigrationIsIdempotentAndMatchesAFreshDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'compendium', 'schema.sql'), 'utf8');
  const old = legacyDatabase();
  migrate(old);
  old.exec(schema);
  migrate(old); // a second start must find nothing to do
  old.exec(schema);

  const fresh = new Database(':memory:');
  fresh.exec(schema);
  const columns = (h, t) => h.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}`);
  for (const table of ['character_lists', 'characters', 'list_selection', 'character_rerolls']) {
    assert.deepEqual(columns(old, table), columns(fresh, table), `${table} has the fresh layout`);
  }
  assert.equal(old.prepare('SELECT COUNT(*) AS n FROM character_lists').get().n, 5, 'and the second run changed nothing');
}

// The live database is already scoped; what it lacks is the column added since. The migration
// must add it there too -- not only on the legacy rebuild -- and leave the rows alone.
function aScopedDatabaseGainsReachAndKeepsItsLists() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'compendium', 'schema.sql'), 'utf8');
  const h = new Database(':memory:');
  h.exec(schema.replace(/,\s*--[^\n]*\n(?:\s*--[^\n]*\n)*\s*reach INTEGER/, '')); // the layout before reach
  assert.ok(!h.prepare('PRAGMA table_info(character_lists)').all().some((c) => c.name === 'reach'), 'the fixture starts without it');
  h.prepare("INSERT INTO character_lists (id, owner_scope, name, created_by, created_at, popularity) VALUES (1, NULL, 'Kept', 't', 0, 7)").run();
  migrate(h);
  migrate(h);
  const fresh = new Database(':memory:');
  fresh.exec(schema);
  const columns = (db) => db.prepare('PRAGMA table_info(character_lists)').all().map((c) => `${c.name}:${c.type}`);
  assert.deepEqual(columns(h), columns(fresh), 'the fresh layout, column for column');
  assert.deepEqual(h.prepare('SELECT name, popularity, reach FROM character_lists').get(), { name: 'Kept', popularity: 7, reach: null });
}

module.exports = {
  'migration: a scoped database gains reach and keeps its lists': aScopedDatabaseGainsReachAndKeepsItsLists,
  'a shared list is visible to every scope': aSharedListIsVisibleToEveryScope,
  'a private list is visible only to its owner': aPrivateListIsVisibleOnlyToItsOwner,
  "a scope's own list wins a name clash with a shared one": aScopesOwnListWinsANameClashWithASharedOne,
  'two shared lists cannot share a name': twoSharedListsCannotShareAName,
  'selections are per scope': selectionsArePerScope,
  'a scope cannot select a list it cannot see': aScopeCannotSelectAListItCannotSee,
  'the compendium itself has no selection': theCompendiumItselfHasNoSelection,
  'deleting a list takes its selections with it': deletingAListTakesItsSelectionsWithIt,
  '/list create makes a shared list, on here and on the web': listCreateMakesASharedListPlayableHereAndOnTheWeb,
  'migration: the content guild is shared and every selection is kept': theMigrationSharesTheContentGuildAndKeepsEverySelection,
  'migration: foreign keys still cascade afterwards': theMigratedForeignKeysStillCascade,
  'migration: idempotent, and matches a fresh database': theMigrationIsIdempotentAndMatchesAFreshDatabase,
};
