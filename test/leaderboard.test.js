// The leaderboard and one player's record must count the same games (src/core/db/stats.js).

const { assert } = require('./harness');
const stats = require('../src/core/db/stats');
const db = require('../src/core/db/connection');

let n = 0;
const freshGuild = () => {
  const guildId = `lb-guild-${++n}`;
  db.prepare('DELETE FROM games WHERE guild_id = ?').run(guildId);
  return guildId;
};
const row = (playerId, outcome, turnsTaken = null) => ({ playerId, outcome, turnsTaken, characterId: null });

module.exports = {
  'a game nobody won still counts, on the board and in the record alike'() {
    const guildId = freshGuild();
    stats.recordGame(guildId, [row('a', 'won', 2), row('b', 'lost', 4)]);
    stats.recordGame(guildId, [row('a', 'gave_up'), row('b', 'gave_up')]); // nobody won this one
    const a = stats.getLeaderboard(guildId).find((r) => r.playerId === 'a');
    assert.equal(a.total, 2, 'both games on the leaderboard');
    assert.equal(a.losses, 1);
    assert.equal(stats.getPlayerStats(guildId, 'a').total, a.total, 'and the same count in the record');
  },

  'a shared win ranks above a loss'() {
    const guildId = freshGuild();
    stats.recordGame(guildId, [row('tie1', 'won', 3), row('tie2', 'won', 3), row('loser', 'lost', 5)]);
    stats.recordGame(guildId, [row('loser', 'lost', 6), row('winner', 'won', 1)]);
    const order = stats.getLeaderboard(guildId).map((r) => r.playerId);
    assert.equal(order[0], 'winner');
    assert.ok(order.indexOf('tie1') < order.indexOf('loser') && order.indexOf('tie2') < order.indexOf('loser'));
  },
};
