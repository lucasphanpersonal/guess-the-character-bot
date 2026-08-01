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

  // Wall-clock deadline, which is what the watchdog enforces when setTimeout can't be
  // trusted to have run (see timerWatchdog.js). Null until the timer is started.
  expiresAt() {
    return this.startedAt === null ? null : this.startedAt + this.durationMs;
  }
}

module.exports = TurnTimer;
