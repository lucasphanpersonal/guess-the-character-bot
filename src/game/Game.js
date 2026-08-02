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
    const [p1Id, p2Id] = this.turnOrder;
    const [c1, c2] = characters;
    // Each player's "head" is what THEY must guess -- and what the OTHER player was DM'd.
    this.headByPlayer = {
      [p1Id]: Game.head(lobby, c1),
      [p2Id]: Game.head(lobby, c2),
    };
    this.turnSeconds = turnSeconds;
    this.round = 1;
    this.currentTurnIndex = 0;
    this.rebuttal = false;
    this.finished = false;
    this.timer = null;
    this.countdownHandles = [];
    // The single self-updating message for the current turn, plus that turn's guesses.
    // Both are replaced/reset by engine.startTurn on every new turn.
    this.turnBoardMessage = null;
    this.turnGuesses = [];
    // Every guess of the whole game, which turnGuesses cannot be because it resets each
    // turn. Feeds the board's running count and the reveal's "got it on their 4th guess".
    this.guessLog = [];
    this.voiceConnection = null;
    this.audioPlayer = null;
    // Populated by engine.startGame: { [playerId]: { confirmed, rerollsLeft, rejectedNames } }
    this.confirmState = null;
    // True after a turn's timer expires until the player /guesses or /passes -- they get one
    // last chance to guess before the turn actually moves on.
    this.paused = false;
  }

  get currentPlayerId() {
    return this.turnOrder[this.currentTurnIndex];
  }

  /** The player whose job it is to judge the current turn -- the one who can see the answer. */
  get judgeId() {
    return this.turnOrder.find((id) => id !== this.currentPlayerId);
  }

  /**
   * One guess by the player currently up, recorded in both the per-turn view and the
   * whole-game log.
   *
   * There is no name to store: guesses are called out in voice and ruled on by the other
   * player, so the bot knows that a guess happened and whether it landed, never what it was.
   */
  recordGuess(playerId, correct) {
    const entry = { correct, playerId, round: this.round };
    this.turnGuesses.push(entry);
    this.guessLog.push(entry);
    return entry;
  }

  /** How many guesses this player has made all game -- the efficiency half of the scoring. */
  guessCountFor(playerId) {
    return this.guessLog.filter((g) => g.playerId === playerId).length;
  }

  isFirstMover(playerId) {
    return playerId === this.turnOrder[0];
  }

}

module.exports = Game;
