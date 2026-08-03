// A local web browser for the character database: `npm run browse`.
//
// `/list show` paginates inside Discord, which is fine for checking one show and hopeless for
// 43,000 characters across 2,000 lists. This serves the same data as a searchable grid with
// the artwork visible, which is the only way to actually judge whether a list is worth
// playing with.
//
// Read-only, deliberately: it opens the live database in readonly mode so it is safe to run
// while the bot is up (SQLite's WAL allows concurrent readers), and nothing here can change
// what the bot deals. Curation still happens through `/list toggle` and `/list select`.
//
// No new dependencies -- node's own http server, and the better-sqlite3 the bot already uses.

const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PORT = Number(flag('port', process.env.PORT || 4173));
const DB_PATH = flag('db', process.env.BOT_DB_PATH || path.join(__dirname, '..', 'data', 'bot.sqlite'));
const PAGE_SIZE = 60;

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database at ${DB_PATH}. Seed one first, or pass --db=<path>.`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const HTML = fs.readFileSync(path.join(__dirname, 'browse-characters.html'), 'utf8');

// The bot is keyed by guild, and a seeded database has one real guild plus whatever the tests
// left behind, so the busiest one is the right default rather than making people choose.
function guilds() {
  return db
    .prepare(
      `SELECT guild_id AS id, COUNT(*) AS lists
       FROM character_lists GROUP BY guild_id ORDER BY lists DESC`
    )
    .all();
}

function meta(guildId) {
  const categories = db
    .prepare(
      `SELECT COALESCE(cl.category, 'Uncategorised') AS category,
              COUNT(DISTINCT cl.id) AS lists,
              COUNT(ch.id) AS characters,
              SUM(CASE WHEN cl.enabled = 1 THEN 1 ELSE 0 END) AS enabledRows
       FROM character_lists cl
       LEFT JOIN characters ch ON ch.list_id = cl.id
       WHERE cl.guild_id = ?
       GROUP BY COALESCE(cl.category, 'Uncategorised')
       ORDER BY characters DESC`
    )
    .all(guildId);

  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT cl.id) AS lists,
              COUNT(ch.id) AS characters,
              SUM(CASE WHEN ch.image_url IS NOT NULL THEN 1 ELSE 0 END) AS withImage
       FROM character_lists cl
       LEFT JOIN characters ch ON ch.list_id = cl.id
       WHERE cl.guild_id = ?`
    )
    .get(guildId);

  const enabledLists = db
    .prepare('SELECT COUNT(*) AS n FROM character_lists WHERE guild_id = ? AND enabled = 1')
    .get(guildId).n;

  return { guilds: guilds(), guildId, categories, totals, enabledLists, pageSize: PAGE_SIZE };
}

// Shared WHERE building, so the count and the page can never disagree about what is being
// looked at -- which is the classic way a "1 of 340" ends up lying.
function characterFilters(query) {
  const where = ['cl.guild_id = ?'];
  const params = [query.guild];

  if (query.category) {
    where.push("COALESCE(cl.category, 'Uncategorised') = ?");
    params.push(query.category);
  }
  if (query.list) {
    where.push('cl.id = ?');
    params.push(Number(query.list));
  }
  if (query.q) {
    where.push('ch.name LIKE ? ESCAPE \'\\\'');
    params.push(`%${String(query.q).replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (query.image === 'yes') where.push('ch.image_url IS NOT NULL');
  if (query.image === 'no') where.push('ch.image_url IS NULL');
  if (query.enabled === 'yes') where.push('cl.enabled = 1');
  if (query.enabled === 'no') where.push('cl.enabled = 0');

  return { clause: where.join(' AND '), params };
}

const SORTS = {
  // Fame is only ever comparable inside a list (AniList favourites vs Wikipedia sitelinks),
  // so sorting the whole pool by it is a rough guide, not a ranking. Unranked sorts last.
  fame: 'ch.fame IS NULL, ch.fame DESC, ch.name COLLATE NOCASE',
  name: 'ch.name COLLATE NOCASE, cl.name COLLATE NOCASE',
  list: 'cl.name COLLATE NOCASE, ch.fame IS NULL, ch.fame DESC',
  rerolled: 'rerolls DESC, ch.name COLLATE NOCASE',
};

function characters(query) {
  const { clause, params } = characterFilters(query);
  const page = Math.max(0, Number(query.page) || 0);
  const order = SORTS[query.sort] ?? SORTS.fame;

  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM characters ch JOIN character_lists cl ON cl.id = ch.list_id WHERE ${clause}`)
    .get(...params).n;

  const rows = db
    .prepare(
      `SELECT ch.id, ch.name, ch.image_url AS imageUrl, ch.fame,
              cl.id AS listId, cl.name AS listName, cl.enabled,
              COALESCE(cl.category, 'Uncategorised') AS category,
              (SELECT COUNT(*) FROM character_rerolls r WHERE r.character_id = ch.id) AS rerolls
       FROM characters ch
       JOIN character_lists cl ON cl.id = ch.list_id
       WHERE ${clause}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`
    )
    .all(...params, PAGE_SIZE, page * PAGE_SIZE);

  return { total, page, pageSize: PAGE_SIZE, rows };
}

function lists(query) {
  const where = ['cl.guild_id = ?'];
  const params = [query.guild];
  if (query.category) {
    where.push("COALESCE(cl.category, 'Uncategorised') = ?");
    params.push(query.category);
  }
  if (query.q) {
    where.push('cl.name LIKE ? ESCAPE \'\\\'');
    params.push(`%${String(query.q).replace(/[\\%_]/g, '\\$&')}%`);
  }
  if (query.enabled === 'yes') where.push('cl.enabled = 1');
  if (query.enabled === 'no') where.push('cl.enabled = 0');

  return db
    .prepare(
      `SELECT cl.id, cl.name, cl.enabled, cl.popularity,
              COALESCE(cl.category, 'Uncategorised') AS category,
              COUNT(ch.id) AS characters,
              SUM(CASE WHEN ch.image_url IS NOT NULL THEN 1 ELSE 0 END) AS withImage
       FROM character_lists cl
       LEFT JOIN characters ch ON ch.list_id = cl.id
       WHERE ${where.join(' AND ')}
       GROUP BY cl.id
       ORDER BY cl.popularity IS NULL, cl.popularity DESC, cl.name COLLATE NOCASE
       LIMIT 400`
    )
    .all(...params);
}

const ROUTES = {
  '/api/meta': (q) => meta(q.guild),
  '/api/characters': characters,
  '/api/lists': lists,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  const route = ROUTES[url.pathname];
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  try {
    // Every query is guild-scoped; default to the one with the most lists.
    query.guild = query.guild || guilds()[0]?.id || '';
    const body = JSON.stringify(route(query));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(body);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  const { lists: l, characters: c, withImage } = meta(guilds()[0]?.id ?? '').totals;
  console.log(`Character browser: http://localhost:${PORT}`);
  console.log(`  ${c} characters in ${l} lists, ${withImage} with artwork`);
  console.log(`  reading ${DB_PATH} (read-only -- safe to run while the bot is up)`);
  console.log('  Ctrl+C to stop.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
