const { getCharacterSource } = require('../db/characterLists');

class Game {
  /**
   * Turns a database character row into the shape the DMs and reveal render.
   *
   * `source` names the work the character is from, so whoever is answering questions knows
   * which "Ditto" or "Jack" they were handed. Looked up once, when the character is dealt,
   * because the same value goes out to both players and every spectator.
   *
   * A failed lookup is not worth losing a game over -- it is a display nicety, and the test
   * harness builds lobbies with no guild rows behind them at all.
   */
  static head(lobby, character) {
    let source = null;
    try {
      source = getCharacterSource(lobby.guildId, character.name, character.list_id ?? null);
    } catch {
      source = null;
    }
    // id and listId ride along so a reroll can be recorded against the character, and so
    // "never deal this show again" knows which list to switch off. Both are absent when a
    // character was assigned by hand via /lobby set-characters.
    return {
      name: character.name,
      imageUrl: character.image_url || null,
      source,
      id: character.id ?? null,
      listId: character.list_id ?? null,
    };
  }

  constructor({ lobby, characters, turnSeconds }) {
    this.lobby = lobby;
    this.turnOrder = [...lobby.players];
    // Each player's "head" is what THEY must guess -- and what every OTHER player was DM'd.
    this.headByPlayer = {};
    this.turnOrder.forEach((playerId, i) => {
      this.headByPlayer[playerId] = Game.head(lobby, characters[i]);
    });
    this.turnSeconds = turnSeconds;
    this.currentTurnIndex = 0;
    this.finished = false;
    this.timer = null;
    this.countdownHandles = [];
    // The single self-updating message for the current turn. Replaced by engine.startTurn on
    // every new turn.
    this.turnBoardMessage = null;
    // The board of the turn that just ended, frozen and awaiting deletion by the next turn --
    // see engine.dropRetiredBoard. Left in place when the game ends, so the channel keeps a
    // record of the final turn.
    this.retiredBoardMessage = null;
    // The score. Everyone plays until they get their character, and fewest turns wins, so
    // turns are counted per player rather than as a shared round number -- once players start
    // dropping out of the rotation the two stop agreeing.
    //
    // Turn count is also the only score the bot OBSERVES rather than being told: it hands the
    // turns out. The wrong-guess count it used to keep only existed when a judge remembered
    // to press the button, so it undercounted, and undercounted worst for the players
    // conscientious enough to click.
    this.turnsTaken = new Map(this.turnOrder.map((id) => [id, 0]));
    // playerId -> the turn they got their character on. Presence means they are out of the
    // rotation, and is what `active` is defined against.
    this.finishedBy = new Map();
    // Whoever gave up rather than finishing. Only reachable once you are the last player
    // still guessing, so there can be at most one -- see engine.submitPass.
    this.surrendered = new Set();
    this.voiceConnection = null;
    this.audioPlayer = null;
    // Populated by engine.startGame: { [playerId]: { confirmed, rerollsLeft, rejectedNames } }
    this.confirmState = null;
    // True after a turn's timer expires until the player guesses or passes -- they get one
    // last chance to guess before the turn actually moves on.
    this.paused = false;
  }

  get currentPlayerId() {
    return this.turnOrder[this.currentTurnIndex];
  }

  /**
   * The player whose job it is to judge the current turn -- one who can see the answer.
   *
   * Players who have already finished still qualify and are deliberately included: they were
   * told every character at the start, so they remain able to rule on a guess, and it leaves
   * them a job instead of turning them into spectators.
   */
  get judgeId() {
    return this.turnOrder.find((id) => id !== this.currentPlayerId);
  }

  /** Still guessing: hasn't got their character and hasn't given up. */
  isActive(playerId) {
    return !this.finishedBy.has(playerId) && !this.surrendered.has(playerId);
  }

  get activePlayers() {
    return this.turnOrder.filter((id) => this.isActive(id));
  }

  /** How many turns this player has had, which is the number they're being scored on. */
  turnsFor(playerId) {
    return this.turnsTaken.get(playerId) ?? 0;
  }

  /**
   * Index of the next player still guessing, or null when nobody is left and the game is over.
   *
   * Walks a full lap from the player after the current one, so the current player is
   * considered last -- which is what gives a lone survivor their next turn.
   */
  nextActiveIndex() {
    for (let step = 1; step <= this.turnOrder.length; step++) {
      const index = (this.currentTurnIndex + step) % this.turnOrder.length;
      if (this.isActive(this.turnOrder[index])) return index;
    }
    return null;
  }

  /** Fewest turns anyone needed. null until somebody has finished. */
  get bestTurnCount() {
    const counts = [...this.finishedBy.values()];
    return counts.length ? Math.min(...counts) : null;
  }

  /**
   * Every player's result, best first, for the reveal and for the database.
   *
   * A tie is simply more than one 'won' row -- there is no tiebreaker, deliberately. The
   * game records that two people got there in the same number of turns and stops pretending
   * to know which was better.
   */
  standings() {
    const best = this.bestTurnCount;
    return this.turnOrder
      .map((playerId) => {
        const turns = this.finishedBy.get(playerId) ?? null;
        let outcome;
        if (turns === null) outcome = 'gave_up';
        else if (turns === best) outcome = 'won';
        else outcome = 'lost';
        return { playerId, turnsTaken: turns, outcome };
      })
      .sort((a, b) => (a.turnsTaken ?? Infinity) - (b.turnsTaken ?? Infinity));
  }
}

module.exports = Game;
