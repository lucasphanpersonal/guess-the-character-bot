// A character as a web client sees it -- shared by every web game.
//
// Pure, so the game modules that use it stay testable without a database.
//
// The image goes through this server's /img/<id> route (src/web/server.js), which reads through
// a local disk cache: Commons throttles by IP and a party shares one, so the server fetches each
// image once. A character with no row behind it (a name the host typed) has no id to route by,
// so its upstream URL is passed through as it is.
function publicCharacter(head) {
  const imageUrl = head.imageUrl ? (head.id != null ? `/img/${head.id}` : head.imageUrl) : null;
  return { name: head.name, imageUrl, source: head.source ?? null };
}

module.exports = { publicCharacter };
