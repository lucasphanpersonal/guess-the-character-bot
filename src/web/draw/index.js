// Draw the Character: one player draws a character, everyone else types guesses.
//
// A game of its own, not a way of playing Guess the Character: its turn is one drawer and many
// guessers at once, scored on speed, so it shares none of ../guess. What it does share is
// everything around a game -- rooms (kind 'draw'), getting into them (../roomAccess.js), pools and
// dealing (../content.js), the guess-checker (src/compendium/answers.js) and pictures (/img).
//
// The rules: ./game.js (pure, tested). The protocol and the clock: ./socket.js. The client:
// ./public, served at /draw/ with its own socket.io namespace (/draw).

const path = require('path');
const { attachDrawSockets } = require('./socket');

module.exports = {
  publicDir: path.join(__dirname, 'public'),
  attach: (io, { registry }) => attachDrawSockets(io.of('/draw'), { registry }),
};
