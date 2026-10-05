import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HostScheduler } from '../src/net/ratelimit.js';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake clock: sleep() advances virtual time instantly and records requested waits.
function fakeClock(start = 1_000_000) {
  const clock = { t: start, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.sleeps.push(ms);
    clock.t += ms;
  };
  return clock;
}

test('per-host FIFO with minimum delay between starts', async () => {
  const c = fakeClock();
  const s = new HostScheduler({ minDelayMs: 100, now: c.now, sleep: c.sleep });
  const starts = [];
  const jobs = [1, 2, 3].map((n) => s.schedule('a.test', async () => starts.push({ n, t: c.t })));
  await Promise.all(jobs);
  assert.deepEqual(starts.map((x) => x.n), [1, 2, 3]);
  assert.equal(starts[1].t - starts[0].t, 100);
  assert.equal(starts[2].t - starts[1].t, 100);
});

test('schedule resolves with fn result and propagates errors', async () => {
  const s = new HostScheduler({ minDelayMs: 0 });
  assert.equal(await s.schedule('a.test', () => 42), 42);
  await assert.rejects(s.schedule('a.test', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await s.schedule('a.test', () => 'next'), 'next', 'queue keeps draining after a failure');
});

test('crawl-delay is honoured when larger than minDelayMs', async () => {
  const c = fakeClock();
  const s = new HostScheduler({ minDelayMs: 100, now: c.now, sleep: c.sleep });
  const t = [];
  await Promise.all([
    s.schedule('b.test', () => t.push(c.t), { crawlDelaySec: 2 }),
    s.schedule('b.test', () => t.push(c.t), { crawlDelaySec: 2 }),
  ]);
  assert.equal(t[1] - t[0], 2000);
  assert.equal(s.stats()[0].nextAllowedAt, t[1] + 2000);
});

test('different hosts run in parallel while one host is serialised', async () => {
  const s = new HostScheduler({ minDelayMs: 0, maxConcurrencyPerHost: 1, globalConcurrency: 8 });
  let active = 0;
  let peak = 0;
  const perHostPeak = {};
  const activeByHost = {};
  const work = (host) => async () => {
    active++;
    activeByHost[host] = (activeByHost[host] || 0) + 1;
    peak = Math.max(peak, active);
    perHostPeak[host] = Math.max(perHostPeak[host] || 0, activeByHost[host]);
    await delay(30);
    activeByHost[host]--;
    active--;
  };
  await Promise.all(['x', 'y', 'z'].flatMap((h) => [s.schedule(h, work(h)), s.schedule(h, work(h))]));
  assert.equal(peak, 3, 'three hosts in flight at once');
  assert.deepEqual(perHostPeak, { x: 1, y: 1, z: 1 });
});

test('global concurrency cap is respected', async () => {
  const s = new HostScheduler({ minDelayMs: 0, globalConcurrency: 2 });
  let active = 0;
  let peak = 0;
  const work = async () => {
    active++;
    peak = Math.max(peak, active);
    await delay(15);
    active--;
  };
  await Promise.all(['h1', 'h2', 'h3', 'h4', 'h5'].map((h) => s.schedule(h, work)));
  assert.equal(peak, 2);
});

test('a host waiting on its delay does not hold a global slot', async () => {
  const s = new HostScheduler({ minDelayMs: 150, globalConcurrency: 1 });
  const order = [];
  await s.schedule('slow.test', () => order.push('slow-1'));
  // slow.test must now wait ~150 ms; fast.test should run meanwhile despite the cap of 1.
  const p1 = s.schedule('slow.test', () => order.push('slow-2'));
  const p2 = s.schedule('fast.test', () => order.push('fast'));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['slow-1', 'fast', 'slow-2']);
});

test('per-host concurrency above 1 allows overlapping requests', async () => {
  const s = new HostScheduler({ minDelayMs: 0, maxConcurrencyPerHost: 2 });
  let active = 0;
  let peak = 0;
  const work = async () => {
    active++;
    peak = Math.max(peak, active);
    await delay(15);
    active--;
  };
  await Promise.all([1, 2, 3, 4].map(() => s.schedule('p.test', work)));
  assert.equal(peak, 2);
});

test('penalize grows exponentially, caps, and Retry-After wins when larger', () => {
  const c = fakeClock();
  const s = new HostScheduler({ backoffBaseMs: 100, maxBackoffMs: 500, now: c.now, sleep: c.sleep });
  assert.equal(s.penalize('h'), 100);
  assert.equal(s.penalize('h'), 200);
  assert.equal(s.penalize('h'), 400);
  assert.equal(s.penalize('h'), 500, 'capped at maxBackoffMs');
  assert.equal(s.penalize('h'), 500);
  assert.equal(s.stats().find((x) => x.host === 'h').backoffMs, 500);

  const s2 = new HostScheduler({ backoffBaseMs: 100, maxBackoffMs: 500, now: c.now, sleep: c.sleep });
  assert.equal(s2.penalize('h', 3000), 3000, 'Retry-After larger than cap wins');
  assert.equal(s2.penalize('h', 10), 200, 'smaller Retry-After does not shorten backoff');
  assert.equal(s2.stats()[0].backoffMs, 3000, 'existing longer backoff is kept');
});

test('backoff delays the next scheduled request; reward resets it', async () => {
  const c = fakeClock();
  const s = new HostScheduler({ minDelayMs: 0, backoffBaseMs: 1000, maxBackoffMs: 8000, now: c.now, sleep: c.sleep });
  await s.schedule('r.test', () => {});
  s.penalize('r.test');
  s.penalize('r.test');
  const before = c.t;
  await s.schedule('r.test', () => {});
  assert.equal(c.t - before, 2000, 'waited out the 2nd-level backoff');

  s.penalize('r.test'); // level continues: 4000
  assert.equal(s.stats()[0].backoffMs, 4000);
  s.reward('r.test');
  assert.equal(s.stats()[0].backoffMs, 0);
  assert.equal(s.penalize('r.test'), 1000, 'reward resets exponent');
});

test('stats reports host counters', async () => {
  const s = new HostScheduler({ minDelayMs: 0 });
  await s.schedule('s.test', () => {});
  await s.schedule('s.test', () => {});
  const [st] = s.stats();
  assert.equal(st.host, 's.test');
  assert.equal(st.requests, 2);
  assert.equal(st.inFlight, 0);
  assert.equal(st.queued, 0);
  assert.equal(typeof st.nextAllowedAt, 'number');
});

test('queued task can be aborted', async () => {
  const s = new HostScheduler({ minDelayMs: 200 });
  await s.schedule('ab.test', () => {});
  const ac = new AbortController();
  const p = s.schedule('ab.test', () => 'ran', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p);
  assert.equal(s.stats()[0].queued, 0);
});

test('options are read at use time', async () => {
  const c = fakeClock();
  const politeness = { minDelayMs: 500, now: c.now, sleep: c.sleep };
  const s = new HostScheduler(politeness);
  await s.schedule('live.test', () => {});
  politeness.minDelayMs = 50;
  const before = c.t;
  await s.schedule('live.test', () => {});
  assert.equal(c.t - before, 50);
});

test('parseRetryAfter handles delta-seconds and HTTP-date', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(HostScheduler.parseRetryAfter('120', now), 120000);
  assert.equal(HostScheduler.parseRetryAfter(' 0 ', now), 0);
  assert.equal(HostScheduler.parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now), 30000);
  assert.equal(HostScheduler.parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', now), 0, 'past date → 0');
  assert.equal(HostScheduler.parseRetryAfter('-5', now), null);
  assert.equal(HostScheduler.parseRetryAfter('soon', now), null);
  assert.equal(HostScheduler.parseRetryAfter('', now), null);
  assert.equal(HostScheduler.parseRetryAfter(null, now), null);
  assert.equal(HostScheduler.parseRetryAfter(undefined, now), null);
});

test('huge crawl-delay never overflows setTimeout (waits are chunked, no 1 ms spin)', async () => {
  const c = fakeClock();
  const s = new HostScheduler({ minDelayMs: 0, now: c.now, sleep: c.sleep });
  await s.schedule('slow.test', () => 1, { crawlDelaySec: 3_000_000 }); // ~34.7 days
  await s.schedule('slow.test', () => 2, { crawlDelaySec: 3_000_000 });
  assert.ok(c.sleeps.length >= 2 && c.sleeps.length <= 3, `sleeps: ${c.sleeps.length}`);
  assert.ok(c.sleeps.every((ms) => ms <= 2 ** 31 - 1));
  assert.equal(c.sleeps.reduce((a, b) => a + b, 0), 3_000_000_000);
});

test('idle hosts are pruned so the host map stays bounded', async () => {
  const c = fakeClock();
  const s = new HostScheduler({ minDelayMs: 10, now: c.now, sleep: c.sleep });
  for (let i = 0; i < 1500; i++) await s.schedule(`h${i}.test`, () => i);
  c.t += 1000;
  await s.schedule('last.test', () => 0);
  assert.ok(s.hosts.size <= 1001, `hosts: ${s.hosts.size}`);
});
