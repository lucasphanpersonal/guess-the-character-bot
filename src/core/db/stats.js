const db = require('./connection');

/**
 * @param {Array<{playerId: string, turnsTaken: number|null, outcome: string,
 *                characterId: number|null}>} standings
 *        As produced by Game#standings() -- one entry per player, outcome already decided.
 */
function recordGame(guildId, standings) {
  const insertGame = db.prepare(
    'INSERT INTO games (guild_id, player_count, finished_at) VALUES (?, ?, ?)'
  );
  const insertPlayer = db.prepare(
    'INSERT INTO game_players (game_id, user_id, turns_taken, outcome, character_id) VALUES (?, ?, ?, ?, ?)'
  );
  const write = db.transaction(() => {
    const gameId = insertGame.run(guildId, standings.length, Date.now()).lastInsertRowid;
    for (const { playerId, turnsTaken, outcome, characterId } of standings) {
      // ?? null so a caller that predates the field writes NULL rather than tripping
      // better-sqlite3's refusal to bind undefined.
      insertPlayer.run(gameId, playerId, turnsTaken, outcome, characterId ?? null);
    }
    return gameId;
  });
  return write();
}

// A player's rows, each carrying how many people won that game -- which is what tells a
// solo win apart from a shared one. Ties are not stored as their own outcome, because
// "everyone level on turns and time" is the same fact whether one or three people were.
const PLAYER_ROWS = `
  SELECT
    gp.outcome,
    gp.turns_taken AS turnsTaken,
    (SELECT COUNT(*) FROM game_players w WHERE w.game_id = gp.game_id AND w.outcome = 'won') AS winners
  FROM game_players gp
  JOIN games g ON g.id = gp.game_id
  WHERE g.guild_id = ? AND gp.user_id = ?
`;

function tallyRows(rows) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let bestTurns = null;
  let turnsSum = 0;
  let turnsCount = 0;

  for (const row of rows) {
    if (row.outcome === 'won') {
      if (row.winners > 1) ties++;
      else wins++;
    } else {
      losses++;
    }
    // Recorded for every game they actually finished, won or lost -- "how fast do you
    // usually get there" is not a question about winning. NULL for games that gave up, and
    // for anything migrated from before turns were tracked.
    if (row.turnsTaken != null) {
      bestTurns = bestTurns === null ? row.turnsTaken : Math.min(bestTurns, row.turnsTaken);
      turnsSum += row.turnsTaken;
      turnsCount++;
    }
  }

  return {
    wins,
    losses,
    ties,
    total: rows.length,
    bestTurns,
    avgTurns: turnsCount ? turnsSum / turnsCount : null,
  };
}

function getPlayerStats(guildId, playerId) {
  return tallyRows(db.prepare(PLAYER_ROWS).all(guildId, playerId));
}

// Counts the same games getPlayerStats does. The winners count is LEFT joined: an inner join
// silently dropped any game with no 'won' row (everyone gave up, say) from the leaderboard while
// /leaderboard for one player still counted it, so the two disagreed about the same person.
// Ordered by wins, then shared wins, then fewest losses -- a tie is worth more than a loss.
function getLeaderboard(guildId, limit = 10) {
  const rows = db
    .prepare(
      `SELECT
         gp.user_id AS playerId,
         SUM(CASE WHEN gp.outcome = 'won' AND COALESCE(winners.n, 0) = 1 THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN gp.outcome = 'won' AND COALESCE(winners.n, 0) > 1 THEN 1 ELSE 0 END) AS ties,
         SUM(CASE WHEN gp.outcome <> 'won' THEN 1 ELSE 0 END) AS losses,
         COUNT(*) AS total
       FROM game_players gp
       JOIN games g ON g.id = gp.game_id
       LEFT JOIN (
         SELECT game_id, COUNT(*) AS n FROM game_players WHERE outcome = 'won' GROUP BY game_id
       ) winners ON winners.game_id = gp.game_id
       WHERE g.guild_id = ?
       GROUP BY gp.user_id
       ORDER BY wins DESC, ties DESC, losses ASC
       LIMIT ?`
    )
    .all(guildId, limit);
  return rows;
}

module.exports = { recordGame, getPlayerStats, getLeaderboard };
