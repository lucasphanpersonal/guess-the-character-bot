// Party mode: Guess the Character on phones. Phones on foreheads in one room, tilt to answer.
//
// One of the web games mounted by ../server.js, which owns everything they share (the HTTP
// server, images, browsing, the QR, rooms). The game itself -- dealing, the confirm screen, the
// turn rules, the room protocol -- is ../guess, shared with the computer version (../desk). What
// makes it THIS way of playing is the variant below: the forehead view (./view.js), the grace
// countdown for raising the phone, and the tilt that answers.
//
// It is served at the site root and on the default socket.io namespace because it was the only
// game when the links and QR codes in people's hands were made, and the client is unversioned.

const path = require('path');
const { attachSockets } = require('../guess/socket');
const { setup } = require('../guess/service');
const loop = require('../guess/turnLoop');
const { buildGameView } = require('./view');

const variant = {
  kind: 'party',
  graceSeconds: Number(process.env.WEB_GRACE_SECONDS ?? 10),
  playerView: (room, viewerId, names, now) => buildGameView(room.game, viewerId, names, now),

  attachHandlers(socket, { playerId, room, playing, handleTurnResult }) {
    // A tilt up: the wearer says they got it, and the room -- which can see their phone -- is
    // trusted to object, exactly as the physical game trusts it.
    socket.on('game:gotit', (_p, ack) => {
      const r = room();
      if (!playing(r)) return ack?.({ ok: false, error: 'No game running.' });
      if (r.game.hostPaused) return ack?.({ ok: false, error: 'The game is paused.' });
      const res = loop.gotIt(r.game, playerId);
      ack?.(res);
      if (res.ok) handleTurnResult(r, res, res.reveal);
    });
  },
};

module.exports = {
  // The client, served by ../server.js.
  publicDir: path.join(__dirname, 'public'),
  // The DEFAULT namespace, for the same reason as the site root: the clients already out there
  // connect to it.
  attach: (io, { registry }) => attachSockets(io.of('/'), { registry, setup, variant }),
};
