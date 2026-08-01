class TurnTimer {
  constructor(durationMs, onExpire) {
    this.durationMs = durationMs;
    this.onExpire = onExpire;
    this.startedAt = null;
    this.handle = null;
  }

  start() {
    this.startedAt = Date.now();
    this.handle = setTimeout(() => {
      this.handle = null;
      this.onExpire();
    }, this.durationMs);
  }

  clear() {
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = null;
    }
  }

  remainingMs() {
    if (!this.startedAt) return this.durationMs;
    return Math.max(0, this.durationMs - (Date.now() - this.startedAt));
  }
}

module.exports = TurnTimer;
