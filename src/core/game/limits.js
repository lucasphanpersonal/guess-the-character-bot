// The bounds a game of Guess the Character is played within, published so the server and every
// client read the same numbers (the client gets MAX_PLAYERS in room state, never its own copy).

// Seats at one game: a forehead game's natural size, everyone watching everyone.
const MAX_PLAYERS = 8;

// Seconds per turn a host may choose. A client-supplied value is clamped to these, never trusted.
const TURN_SECONDS = { min: 15, max: 600 };

module.exports = { MAX_PLAYERS, TURN_SECONDS };
