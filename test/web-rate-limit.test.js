// Per-client limits on the things a stranger can do in bulk (src/web/rateLimit.js).

const { assert } = require('./harness');
const { clientKey, createLimiter } = require('../src/web/rateLimit');

module.exports = {
  'the client is who the proxy says, or the socket address without one'() {
    assert.equal(clientKey({ 'cf-connecting-ip': '203.0.113.7' }, '127.0.0.1'), '203.0.113.7');
    assert.equal(clientKey({ 'x-forwarded-for': '198.51.100.2, 10.0.0.1' }, '127.0.0.1'), '198.51.100.2');
    assert.equal(clientKey({}, '192.168.1.40'), '192.168.1.40');
  },

  'a request from this machine with no proxy header is local, and never limited'() {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(clientKey({}, addr), null);
    const limit = createLimiter({ max: 1, windowMs: 1000 });
    for (let i = 0; i < 5; i++) assert.equal(limit.take(null), true);
  },

  'a client gets max uses per window, then none, then a fresh window'() {
    const limit = createLimiter({ max: 3, windowMs: 1000 });
    const t = 10_000;
    assert.deepEqual([1, 2, 3, 4].map(() => limit.take('a', t)), [true, true, true, false]);
    assert.equal(limit.allows('a', t + 999), false);
    assert.equal(limit.take('b', t), true, 'another client is unaffected');
    assert.equal(limit.take('a', t + 1000), true, 'the next window starts over');
  },

  'allows() looks without spending'() {
    const limit = createLimiter({ max: 1, windowMs: 1000 });
    assert.equal(limit.allows('a', 0), true);
    assert.equal(limit.allows('a', 0), true);
    assert.equal(limit.take('a', 0), true);
    assert.equal(limit.allows('a', 0), false);
  },
};
