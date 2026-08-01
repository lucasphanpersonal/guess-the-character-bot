const { normalizeLoose } = require('../util/text');
const { getCharacterSource } = require('../db/characterLists');

class Game {
  static STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'de', 'la', 'le']);

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
    return { name: character.name, imageUrl: character.image_url || null, source };
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

  isFirstMover(playerId) {
    return playerId === this.turnOrder[0];
  }

  // Folds diacritics before stripping punctuation, so "Flabebe" still matches "Flabébé"
  // (see src/util/text.js -- stripping first would delete accented letters outright).
  static normalize(str) {
    return normalizeLoose(str);
  }

  // Standard Levenshtein edit distance between two strings.
  static levenshtein(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const dist = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
    for (let j = 0; j < cols; j++) dist[0][j] = j;
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost);
      }
    }
    return dist[rows - 1][cols - 1];
  }

  // Typo tolerance scaled by target length -- exact match required for very short names,
  // since a small edit distance is too easy to hit by accident on a short string.
  static toleranceFor(length) {
    if (length <= 4) return 0;
    if (length <= 7) return 1;
    return 2;
  }

  static fuzzyMatches(a, b) {
    return a === b || Game.levenshtein(a, b) <= Game.toleranceFor(b.length);
  }

  checkGuess(playerId, guessText) {
    const targetFull = this.headByPlayer[playerId].name;
    const target = Game.normalize(targetFull);
    const guess = Game.normalize(guessText);
    if (!guess) return false;
    if (Game.fuzzyMatches(guess, target)) return true;

    // Multi-word names (e.g. "Shikamaru Nara") are commonly known by just one part
    // ("Shikamaru") -- accept a guess that matches any single word of the full name, not
    // just the whole thing, on the assumption that the guesser is using its well-known
    // short form rather than making a typo across the whole name.
    const words = targetFull
      .split(/\s+/)
      .map((w) => Game.normalize(w))
      .filter((w) => w && !Game.STOPWORDS.has(w));
    if (words.length > 1) {
      return words.some((word) => Game.fuzzyMatches(guess, word));
    }
    return false;
  }
}

module.exports = Game;
