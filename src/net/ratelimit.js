// Per-host politeness scheduler: FIFO queue per host, minimum spacing between
// request starts (min delay or robots Crawl-delay, whichever is larger),
// exponential backoff after 429/5xx, per-host and global concurrency caps.
//
// Options are read at use time from the object passed in, so live edits to
// config.politeness (POST /api/config) take effect without a restart.

const DEFAULTS = {
  minDelayMs: 1000,
  maxConcurrencyPerHost: 1,
  globalConcurrency: 8,
  backoffBaseMs: 2000,
  maxBackoffMs: 60000,
};

// A Retry-After beyond this is treated as nonsense and clamped.
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
// setTimeout overflows above 2^31-1 ms (Node then fires after 1 ms), so longer
// waits are slept in chunks of at most this.
export const MAX_TIMER_MS = 2 ** 31 - 1;
// Idle per-host state is pruned once more hosts than this are tracked.
const MAX_IDLE_HOSTS = 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

export class HostScheduler {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now || Date.now;
    this.sleep = options.sleep || defaultSleep;
    this.hosts = new Map();
    this.globalInFlight = 0;
    // Hosts that are ready to start but blocked on the global cap, in arrival order.
    this.waitingForSlot = [];
  }

  opt(name) {
    const v = this.options[name];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULTS[name];
  }

  state(host) {
    let s = this.hosts.get(host);
    if (!s) {
      if (this.hosts.size >= MAX_IDLE_HOSTS) this.pruneIdle();
      s = {
        host,
        queue: [],
        inFlight: 0,
        requests: 0,
        lastStart: null,
        crawlDelayMs: 0,
        backoffUntil: 0,
        backoffLevel: 0,
        timerPending: false,
        waitingSlot: false,
      };
      this.hosts.set(host, s);
    }
    return s;
  }

  // Forget hosts with nothing queued or running whose delay has fully elapsed:
  // dropping them loses no politeness (their next request could start now anyway).
  pruneIdle() {
    const now = this.now();
    for (const [host, s] of this.hosts) {
      if (s.queue.length || s.inFlight || s.timerPending || s.waitingSlot) continue;
      if (this.readyAt(s) > now) continue;
      this.hosts.delete(host);
    }
  }

  // Earliest time the next request to this host may start.
  readyAt(s, crawlDelayMs = s.crawlDelayMs) {
    const spacing = Math.max(this.opt('minDelayMs'), crawlDelayMs || 0);
    const fromSpacing = s.lastStart === null ? 0 : s.lastStart + spacing;
    return Math.max(fromSpacing, s.backoffUntil);
  }

  schedule(host, fn, { crawlDelaySec, signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const s = this.state(host);
    if (typeof crawlDelaySec === 'number' && Number.isFinite(crawlDelaySec) && crawlDelaySec >= 0) {
      s.crawlDelayMs = crawlDelaySec * 1000;
    }
    return new Promise((resolve, reject) => {
      const task = { fn, resolve, reject, crawlDelayMs: s.crawlDelayMs, signal, onAbort: null };
      if (signal) {
        task.onAbort = () => {
          const i = s.queue.indexOf(task);
          if (i !== -1) {
            s.queue.splice(i, 1);
            reject(abortError(signal));
          }
        };
        signal.addEventListener('abort', task.onAbort, { once: true });
      }
      s.queue.push(task);
      this.pump(s);
    });
  }

  pump(s) {
    while (s.queue.length && s.inFlight < Math.max(1, this.opt('maxConcurrencyPerHost'))) {
      if (s.timerPending || s.waitingSlot) return;
      const head = s.queue[0];
      const now = this.now();
      const readyAt = this.readyAt(s, head.crawlDelayMs);
      if (now < readyAt) {
        // Wait on the host delay without holding a global slot.
        s.timerPending = true;
        this.sleep(Math.min(readyAt - now, MAX_TIMER_MS)).then(() => {
          s.timerPending = false;
          this.pump(s);
        });
        return;
      }
      if (this.globalInFlight >= Math.max(1, this.opt('globalConcurrency'))) {
        s.waitingSlot = true;
        this.waitingForSlot.push(s);
        return;
      }
      s.queue.shift();
      this.start(s, head, now);
    }
  }

  start(s, task, now) {
    if (task.signal && task.onAbort) task.signal.removeEventListener('abort', task.onAbort);
    s.inFlight++;
    s.requests++;
    s.lastStart = now;
    this.globalInFlight++;
    let result;
    try {
      result = Promise.resolve(task.fn());
    } catch (err) {
      result = Promise.reject(err);
    }
    // Release slots before settling so callers observe up-to-date stats.
    const finish = () => {
      s.inFlight--;
      this.globalInFlight--;
      this.releaseSlot();
      this.pump(s);
    };
    result.then(
      (value) => {
        finish();
        task.resolve(value);
      },
      (err) => {
        finish();
        task.reject(err);
      },
    );
  }

  releaseSlot() {
    while (this.waitingForSlot.length && this.globalInFlight < Math.max(1, this.opt('globalConcurrency'))) {
      const s = this.waitingForSlot.shift();
      s.waitingSlot = false;
      this.pump(s);
    }
  }

  // Exponential backoff: base * 2^n (n = consecutive penalties so far), capped at
  // maxBackoffMs. A server-supplied Retry-After wins when it is longer.
  penalize(host, retryAfterMs = null) {
    const s = this.state(host);
    const exp = Math.min(this.opt('maxBackoffMs'), this.opt('backoffBaseMs') * 2 ** s.backoffLevel);
    s.backoffLevel++;
    let wait = exp;
    if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > wait) {
      wait = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    s.backoffUntil = Math.max(s.backoffUntil, this.now() + wait);
    return wait;
  }

  reward(host) {
    const s = this.hosts.get(host);
    if (!s) return;
    s.backoffLevel = 0;
    s.backoffUntil = 0;
  }

  stats() {
    const now = this.now();
    return [...this.hosts.values()].map((s) => ({
      host: s.host,
      inFlight: s.inFlight,
      queued: s.queue.length,
      requests: s.requests,
      backoffMs: Math.max(0, s.backoffUntil - now),
      nextAllowedAt: this.readyAt(s),
    }));
  }

  // Retry-After is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3).
  static parseRetryAfter(value, now = Date.now()) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
    const str = String(value).trim();
    if (!str) return null;
    if (/^\d+$/.test(str)) return Number(str) * 1000;
    if (/^-?\d+(\.\d+)?$/.test(str)) return null;
    const t = Date.parse(str);
    if (Number.isNaN(t)) return null;
    return Math.max(0, t - now);
  }
}
