const db = require('./connection');

function recordResult(guildId, player1Id, player2Id, result) {
  db.prepare(
    'INSERT INTO game_results (guild_id, player1_id, player2_id, result, finished_at) VALUES (?, ?, ?, ?, ?)'
  ).run(guildId, player1Id, player2Id, result, Date.now());
}

function getPlayerStats(guildId, playerId) {
  const rows = db
    .prepare('SELECT * FROM game_results WHERE guild_id = ? AND (player1_id = ? OR player2_id = ?)')
    .all(guildId, playerId, playerId);

  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const row of rows) {
    if (row.result === 'tie') {
      ties++;
      continue;
    }
    const wonAsP1 = row.player1_id === playerId && row.result === 'player1';
    const wonAsP2 = row.player2_id === playerId && row.result === 'player2';
    if (wonAsP1 || wonAsP2) wins++;
    else losses++;
  }
  return { wins, losses, ties, total: rows.length };
}

function getLeaderboard(guildId, limit = 10) {
  const rows = db
    .prepare(
      `WITH players AS (
         SELECT player1_id AS player_id FROM game_results WHERE guild_id = ?
         UNION
         SELECT player2_id AS player_id FROM game_results WHERE guild_id = ?
       )
       SELECT
         p.player_id AS playerId,
         SUM(CASE WHEN (gr.player1_id = p.player_id AND gr.result = 'player1')
                     OR (gr.player2_id = p.player_id AND gr.result = 'player2') THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN (gr.player1_id = p.player_id AND gr.result = 'player2')
                     OR (gr.player2_id = p.player_id AND gr.result = 'player1') THEN 1 ELSE 0 END) AS losses,
         SUM(CASE WHEN gr.result = 'tie' THEN 1 ELSE 0 END) AS ties,
         COUNT(*) AS total
       FROM players p
       JOIN game_results gr ON gr.guild_id = ? AND (gr.player1_id = p.player_id OR gr.player2_id = p.player_id)
       GROUP BY p.player_id
       ORDER BY wins DESC, losses ASC
       LIMIT ?`
    )
    .all(guildId, guildId, guildId, limit);
  return rows;
}

module.exports = { recordResult, getPlayerStats, getLeaderboard };
