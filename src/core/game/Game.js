const { getCharacterSource } = require('../../compendium/characterLists');

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
    // "never deal this show again" knows which list to switch off. Hand-picked characters
    // carry them too -- /lobby set-characters resolves a real row -- so both survive there;
    // they are only null for a shape that never came out of the database.
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
    // A null character is a seat nobody has chosen for yet: the web's pick-for-each-other mode
    // deals empty and fills each one as its checker picks. Play cannot begin until every seat
    // holds someone (see the web's gameSetup.applyConfirm), so only the setup phase sees a null.
    this.turnOrder.forEach((playerId, i) => {
      this.headByPlayer[playerId] = characters[i] ? Game.head(lobby, characters[i]) : null;
    });
    this.turnSeconds = turnSeconds;
    this.currentTurnIndex = 0;
    this.finished = false;
    this.timer = null;
    this.countdownHandles = [];
    // Unique instance ID for this game, used in button customIds to prevent stale controls
    // from old games in the same channel from affecting this one.
    this.gameInstanceId = Math.random().toString(36).substring(2, 9);
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
    // rotation, and is what `active` is defined against. Written only through recordFinish.
    this.finishedBy = new Map();
    // playerId -> whole seconds left on their clock the moment they got it, or null where no
    // clock was read. The tiebreak between equal turn counts -- see standings.
    this.secondsLeftBy = new Map();
    // Everyone who left the rotation without finishing -- always a deliberate act: pressing
    // 🏳️ Give up (engine.submitGiveUp), or leaving mid-game via `/lobby leave`
    // (engine.submitForfeit). Passing never adds anyone here -- it only ever hands the turn on
    // -- and nobody is ever added for merely going quiet, since a timed-out turn just passes
    // (see engine.checkLastChanceTimeout). Membership is what `active` is defined against, and
    // there can be several.
    this.surrendered = new Set();
    // Players whose character has already been shown publicly BEFORE the final reveal -- today
    // that means someone who left mid-game (engine.submitForfeit reveals what they were wearing
    // the moment they go). finalizeGame skips these so the end-of-game reveal doesn't show the
    // same character twice. Finishers aren't tracked here: finishedBy already excludes them.
    this.revealed = new Set();
    // "<playerId>:<turnNumber>" for every turn that has already been resolved, so no turn can
    // be resolved twice. See the note in engine.endTurn: judging is open to everyone who
    // isn't guessing, so simultaneous presses are routine rather than exotic.
    this.resolvedTurns = new Set();
    this.voiceConnection = null;
    this.audioPlayer = null;
    // Populated by engine.startGame:
    // { [playerId]: { confirmed, rerollsLeft, rejectedNames, checkMessage, referenceMessages } }
    this.confirmState = null;
    // Display names, resolved once when the game starts. They label characters in three
    // different DMs and are re-rendered on every reroll, which is a lot of user lookups for
    // something that cannot change mid-game.
    this.names = {};
    // True after a turn's timer expires until the player guesses or passes -- they get one
    // last chance to guess before the turn actually moves on.
    this.paused = false;
    // Handle for the last-chance grace timer; when it lapses the turn passes (see
    // engine.checkLastChanceTimeout) -- it never removes anyone.
    this.lastChanceHandle = null;
  }

  get currentPlayerId() {
    return this.turnOrder[this.currentTurnIndex];
  }

  /**
   * Everyone entitled to rule on the current turn: every player who isn't the one guessing.
   *
   * Players who have already finished are deliberately included. They were told every
   * character at the start, so they remain able to rule on a guess, and it leaves them a job
   * instead of turning them into spectators.
   */
  get judges() {
    return this.turnOrder.filter((id) => id !== this.currentPlayerId);
  }

  /** The single judge, for the two-player case and for messages that name one. */
  get judgeId() {
    return this.judges[0];
  }

  /**
   * Whose character this player checks before the game begins -- the next one round the
   * rotation, wrapping. Every character therefore has exactly one person who may reroll it.
   *
   * Characters are shared, not per-viewer: each player sees the N-1 they aren't wearing. So a
   * reroll is not private the way it is at two players, and letting any viewer reroll any
   * character would mean two people can reject the same one at once, and that one player's
   * unfamiliarity overrides N-2 who were happy. One checker each removes both, and at two
   * players it reduces to exactly what the bot did before: each player checks the other's.
   */
  checkTargetOf(playerId) {
    const i = this.turnOrder.indexOf(playerId);
    return this.turnOrder[(i + 1) % this.turnOrder.length];
  }

  /** The inverse of checkTargetOf: who may reroll THIS player's character. */
  checkerOf(playerId) {
    const i = this.turnOrder.indexOf(playerId);
    return this.turnOrder[(i - 1 + this.turnOrder.length) % this.turnOrder.length];
  }

  setNames(names) {
    this.names = names;
  }

  /** Display name, falling back to a mention so a missed lookup still reads as somebody. */
  nameOf(playerId) {
    return this.names[playerId] ?? `<@${playerId}>`;
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

  /**
   * This player got their character on the turn in hand. The one way a finish is recorded, for
   * both frontends, so the tiebreak cannot be measured two different ways.
   *
   * `msLeft` is how long that turn's clock still had to run. It is kept in WHOLE seconds, the
   * unit every clock in the game shows: below that, the gap between two players is the tilt hold
   * and the network, not play, and a win decided by it would read as "41s left, beaten by 41s
   * left". Players level to the second stay level. A finish after the clock ran out (Discord's
   * last-chance window) is 0. null means there was no clock to read, and ties stay ties.
   */
  recordFinish(playerId, msLeft = null) {
    this.finishedBy.set(playerId, this.turnsFor(playerId));
    this.secondsLeftBy.set(playerId, msLeft == null ? null : Math.max(0, Math.round(msLeft / 1000)));
  }

  /**
   * True when the win was decided by the clock: one winner, and somebody else who matched their
   * turns. Every result screen has to say so when it happens, or a player who "also got it in
   * one" is simply told they lost -- so it is defined here once rather than per screen.
   */
  get wonOnTime() {
    const rows = this.standings();
    const winners = rows.filter((r) => r.outcome === 'won');
    return winners.length === 1 && rows.some((r) => r.outcome !== 'won' && r.turnsTaken === winners[0].turnsTaken);
  }

  /** Fewest turns anyone needed. null until somebody has finished. */
  get bestTurnCount() {
    const counts = [...this.finishedBy.values()];
    return counts.length ? Math.min(...counts) : null;
  }

  /**
   * Whether this player is out of contention FOR THE WIN -- they can no longer finish in few
   * enough turns to match the best result already on the board, so their own best-possible
   * score can't equal or beat it.
   *
   * This is NOT elimination. Nobody is ever removed from the game: the only score is turns
   * taken, compared at the very end (see `standings`), and a player out of contention keeps
   * playing, keeps being handed turns, and still gets a real placement for however many turns
   * they take. All this decides is one informational note on the board -- "you can't catch the
   * leader now, but you can still get your own character" -- so nobody is left silently playing
   * a turn that can no longer change who wins without being told. It has no mechanical effect:
   * it does not change the buttons, the rotation, or scoring.
   *
   * The condition is `min(finished turn counts) < your earliest possible finish`. The subtlety
   * is what "your earliest possible finish" is at the moment we ask:
   *
   *   - For the player currently guessing, that is the turn in hand. `engine.startTurn` has
   *     already incremented their `turnsTaken` for it, so `turnsFor` IS that turn's number,
   *     and they can still TIE by getting it now whenever that number <= bestTurnCount.
   *   - For anyone waiting, their earliest chance is their NEXT turn, `turnsFor + 1`.
   *
   * Hence the +1 for everyone but the current player. Without it, a guesser on turn k whose
   * leader also finished on k -- who can still tie by getting it this very turn -- would be
   * told they were out of contention a turn too early.
   */
  isOutOfContention(playerId) {
    const best = this.bestTurnCount;
    if (best == null) return false;
    if (this.finishedBy.has(playerId) || this.surrendered.has(playerId)) return false;
    const earliestFinish = this.turnsFor(playerId) + (playerId === this.currentPlayerId ? 0 : 1);
    return earliestFinish > best;
  }

  /**
   * Every player's result, best first, for the reveal and for the database.
   *
   * Fewest turns wins, and equal turns are decided by time: whoever had more seconds left on
   * the turn they got it. That is the same thing as least total time spent, because every
   * earlier turn cost exactly the full clock -- a turn only ends early by a pass, and a pass
   * counts as the whole turn -- so nobody can bank time by passing fast. This used to have no
   * tiebreaker at all, deliberately; the reason for adding one is that the clock was already
   * the thing everyone was racing, and "tie" was throwing away who actually won the race.
   *
   * A tie is still more than one 'won' row, now only when players are level on turns AND on
   * whole seconds, or when there was no clock to read. `place` is competition ranking (level
   * players share a place, the next skips) and every screen takes it from here rather than
   * re-deriving it, so the two frontends cannot rank the same game differently.
   *
   * characterId rides along because this is the last moment the pairing exists: once the game
   * is gone, nothing can say what anyone was wearing. Null for hand-assigned characters, which
   * have no row behind them.
   */
  standings() {
    const finishers = this.turnOrder.filter((id) => this.finishedBy.has(id));
    // Strictly ahead: fewer turns, or the same turns with more seconds left. Unknown seconds put
    // nobody ahead of anybody, so a game with no clock ranks exactly as it always did.
    const ahead = (a, b) => {
      const ta = this.finishedBy.get(a);
      const tb = this.finishedBy.get(b);
      if (ta !== tb) return ta < tb;
      const sa = this.secondsLeftBy.get(a) ?? null;
      const sb = this.secondsLeftBy.get(b) ?? null;
      return sa !== null && sb !== null && sa > sb;
    };
    return this.turnOrder
      .map((playerId) => {
        const turns = this.finishedBy.get(playerId) ?? null;
        const place = turns === null ? null : 1 + finishers.filter((o) => ahead(o, playerId)).length;
        let outcome;
        // Never got their character. `gave_up` when they chose to stop (surrender is always a
        // deliberate act now); otherwise a plain loss -- e.g. a player the host cut off mid-game,
        // who made no such choice, so recording it as a surrender would put a decision in their
        // mouth.
        if (turns === null) outcome = this.surrendered.has(playerId) ? 'gave_up' : 'lost';
        else outcome = place === 1 ? 'won' : 'lost';
        return {
          playerId,
          turnsTaken: turns,
          secondsLeft: turns === null ? null : (this.secondsLeftBy.get(playerId) ?? null),
          place,
          outcome,
          characterId: this.headByPlayer[playerId].id,
        };
      })
      .sort((a, b) => (a.place ?? Infinity) - (b.place ?? Infinity));
  }
}

module.exports = Game;
