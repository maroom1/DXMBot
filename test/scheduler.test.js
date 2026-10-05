// Tests for src/assistant/when.js (parseWhen, nextOccurrence) and src/assistant/scheduler.js (TaskScheduler).
// Deterministic: fixed timezone (DST-observing) + injected clock + manual tick().
process.env.TZ = 'America/Los_Angeles';
process.env.CAIRN_MAC_DRYRUN = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, nextOccurrence, normalizeRecurrence, toLocalISO, describeRecurrence } from '../src/assistant/when.js';
import { TaskScheduler } from '../src/assistant/scheduler.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const L = (y, mo, d, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0); // local time, 1-based month

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-sched-'));
  return path.join(dir, 'tasks.json');
}

function fakeClock(start) {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => { t = d.getTime(); },
    advance: (ms) => { t += ms; },
  };
}

// Wednesday 2026-09-30 10:00 local.
const NOW = L(2026, 9, 30, 10, 0);

// ------------------------------------------------------------------ parseWhen table

const CASES = [
  // [text, expected local Date, recurrence|null, title]
  ['in 10 minutes', new Date(NOW.getTime() + 10 * MIN), null, ''],
  ['in 2 hours', new Date(NOW.getTime() + 2 * HOUR), null, ''],
  ['in 3 days', L(2026, 10, 3, 10, 0), null, ''],
  ['in an hour and a half', new Date(NOW.getTime() + 90 * MIN), null, ''],
  ['in half an hour check the oven', new Date(NOW.getTime() + 30 * MIN), null, 'check the oven'],
  ['at 5pm', L(2026, 9, 30, 17, 0), null, ''],
  ['at 17:30', L(2026, 9, 30, 17, 30), null, ''],
  ['at 9am', L(2026, 10, 1, 9, 0), null, ''], // already past today → tomorrow
  ['tomorrow at 9am', L(2026, 10, 1, 9, 0), null, ''],
  ['tonight', L(2026, 9, 30, 20, 0), null, ''],
  ['tomorrow morning', L(2026, 10, 1, 9, 0), null, ''],
  ['tomorrow evening at 7', L(2026, 10, 1, 19, 0), null, ''],
  ['next monday at 10', L(2026, 10, 5, 10, 0), null, ''],
  ['on friday', L(2026, 10, 2, 9, 0), null, ''],
  ['oct 5 at 3pm', L(2026, 10, 5, 15, 0), null, ''],
  ['dentist on 10/14 at 2:15pm', L(2026, 10, 14, 14, 15), null, 'dentist'],
  ['every day at 8am', L(2026, 10, 1, 8, 0), { every: 'day', interval: 1, at: '08:00' }, ''],
  ['every weekday at 9', L(2026, 10, 1, 9, 0), { every: 'weekday', interval: 1, at: '09:00' }, ''],
  ['every monday', L(2026, 10, 5, 9, 0), { every: 'week', interval: 1, at: '09:00', days: ['mon'] }, ''],
  ['every monday and wednesday at 7:30pm', L(2026, 9, 30, 19, 30), { every: 'week', interval: 1, at: '19:30', days: ['mon', 'wed'] }, ''],
  ['every other friday at 5', L(2026, 10, 2, 17, 0), { every: 'week', interval: 2, at: '17:00', days: ['fri'] }, ''],
  ['every 30 minutes', new Date(NOW.getTime() + 30 * MIN), { every: 'minute', interval: 30 }, ''],
  ['every hour', new Date(NOW.getTime() + HOUR), { every: 'hour', interval: 1 }, ''],
  ['every 2 hours drink water', new Date(NOW.getTime() + 2 * HOUR), { every: 'hour', interval: 2 }, 'drink water'],
  ['water the plants every morning', L(2026, 10, 1, 9, 0), { every: 'day', interval: 1, at: '09:00' }, 'water the plants'],
  ['2026-10-05T14:30:00', L(2026, 10, 5, 14, 30), null, ''],
  ['2026-10-05T21:30:00Z', new Date(Date.UTC(2026, 9, 5, 21, 30)), null, ''],
  ['remind me to call mom at 6pm', L(2026, 9, 30, 18, 0), null, 'call mom'],
  ['remind me in 10 minutes to stretch', new Date(NOW.getTime() + 10 * MIN), null, 'stretch'],
  ['Remind me to Pay Rent tomorrow', L(2026, 10, 1, 9, 0), null, 'Pay Rent'],
  ['please remind me to take out the trash every tuesday night', L(2026, 10, 6, 20, 0), { every: 'week', interval: 1, at: '20:00', days: ['tue'] }, 'take out the trash'],
  ['check stock prices every weekday at 4:30 pm', L(2026, 9, 30, 16, 30), { every: 'weekday', interval: 1, at: '16:30' }, 'check stock prices'],
  ['call dad at 6', L(2026, 9, 30, 18, 0), null, 'call dad'],
  ['friday 3pm team lunch', L(2026, 10, 2, 15, 0), null, 'team lunch'],
  ['stand up and walk in 5 minutes', new Date(NOW.getTime() + 5 * MIN), null, 'stand up and walk'],
  ['at noon', L(2026, 9, 30, 12, 0), null, ''],
];

for (const [text, expected, recurrence, title] of CASES) {
  test(`parseWhen: ${JSON.stringify(text)}`, () => {
    const r = parseWhen(text, NOW);
    assert.ok(r, `expected a parse for ${text}`);
    assert.equal(new Date(r.when).getTime(), expected.getTime(), `when for "${text}": got ${r.when}, want ${toLocalISO(expected)}`);
    assert.deepEqual(r.recurrence, recurrence);
    assert.equal(r.title, title);
    assert.match(r.when, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });
}

test('parseWhen: nonsense and empty input → null', () => {
  for (const t of ['asdf qwerty', 'hello world', 'buy groceries', '', '   ', null, undefined]) {
    assert.equal(parseWhen(t, NOW), null, `expected null for ${JSON.stringify(t)}`);
  }
});

test('parseWhen: "on friday" when today is friday and time has passed → next week', () => {
  const fri = L(2026, 10, 2, 11, 0);
  assert.equal(new Date(parseWhen('on friday', fri).when).getTime(), L(2026, 10, 9, 9, 0).getTime());
  assert.equal(new Date(parseWhen('on friday at 5pm', fri).when).getTime(), L(2026, 10, 2, 17, 0).getTime());
  assert.equal(new Date(parseWhen('next friday', fri).when).getTime(), L(2026, 10, 9, 9, 0).getTime());
});

test('parseWhen: every weekday on a friday afternoon starts monday', () => {
  const r = parseWhen('every weekday at 9', L(2026, 10, 2, 15, 0));
  assert.equal(new Date(r.when).getTime(), L(2026, 10, 5, 9, 0).getTime());
});

// ------------------------------------------------------------------ nextOccurrence

test('nextOccurrence: daily at 08:00 is DST-safe (fall back and spring forward)', () => {
  const r = { every: 'day', at: '08:00' };
  const fallBack = nextOccurrence(r, L(2026, 10, 31, 8, 0)); // DST ends 2026-11-01 in LA
  assert.equal(fallBack.getTime(), L(2026, 11, 1, 8, 0).getTime());
  assert.equal(fallBack.getHours(), 8);
  assert.equal(fallBack.getTime() - L(2026, 10, 31, 8, 0).getTime(), 25 * HOUR);
  const spring = nextOccurrence(r, L(2026, 3, 7, 8, 0)); // DST starts 2026-03-08
  assert.equal(spring.getHours(), 8);
  assert.equal(spring.getTime() - L(2026, 3, 7, 8, 0).getTime(), 23 * HOUR);
});

test('nextOccurrence: weekly across DST keeps wall-clock time', () => {
  const n = nextOccurrence({ every: 'week', days: ['mon'], at: '09:00' }, L(2026, 10, 26, 9, 0));
  assert.equal(n.getTime(), L(2026, 11, 2, 9, 0).getTime());
  assert.equal(n.getHours(), 9);
});

test('nextOccurrence: same day later / next day, weekday, days filter, intervals', () => {
  assert.equal(nextOccurrence({ every: 'day', at: '12:00' }, L(2026, 9, 30, 10, 0)).getTime(), L(2026, 9, 30, 12, 0).getTime());
  assert.equal(nextOccurrence({ every: 'day', at: '08:00' }, L(2026, 9, 30, 10, 0)).getTime(), L(2026, 10, 1, 8, 0).getTime());
  assert.equal(nextOccurrence({ every: 'day', interval: 3, at: '08:00' }, L(2026, 9, 30, 8, 0)).getTime(), L(2026, 10, 3, 8, 0).getTime());
  // weekday: Friday → Monday
  assert.equal(nextOccurrence({ every: 'weekday', at: '09:00' }, L(2026, 10, 2, 9, 0)).getTime(), L(2026, 10, 5, 9, 0).getTime());
  // week with multiple days
  const mwf = { every: 'week', days: ['mon', 'wed', 'fri'], at: '07:00' };
  assert.equal(nextOccurrence(mwf, L(2026, 9, 30, 7, 0)).getTime(), L(2026, 10, 2, 7, 0).getTime());
  assert.equal(nextOccurrence(mwf, L(2026, 10, 2, 7, 0)).getTime(), L(2026, 10, 5, 7, 0).getTime());
  // every other week on friday
  assert.equal(nextOccurrence({ every: 'week', interval: 2, days: ['fri'], at: '17:00' }, L(2026, 10, 2, 17, 0)).getTime(), L(2026, 10, 16, 17, 0).getTime());
  // minute / hour intervals are elapsed time
  assert.equal(nextOccurrence({ every: 'minute', interval: 30 }, NOW).getTime(), NOW.getTime() + 30 * MIN);
  assert.equal(nextOccurrence({ every: 'hour', interval: 2 }, NOW).getTime(), NOW.getTime() + 2 * HOUR);
  // day with a days filter skips non-matching days
  assert.equal(nextOccurrence({ every: 'day', days: ['sat', 'sun'], at: '10:00' }, NOW).getTime(), L(2026, 10, 3, 10, 0).getTime());
  assert.equal(nextOccurrence(null, NOW), null);
});

test('normalizeRecurrence: aliases, validation, describe', () => {
  assert.deepEqual(normalizeRecurrence('daily'), { every: 'day', interval: 1 });
  assert.deepEqual(normalizeRecurrence({ every: 'weekdays', at: '9am' }), { every: 'weekday', interval: 1, at: '09:00' });
  assert.deepEqual(normalizeRecurrence({ every: 'week', days: ['Friday', 'monday', 1] }), { every: 'week', interval: 1, days: ['mon', 'fri'] });
  assert.equal(normalizeRecurrence(null), null);
  assert.throws(() => normalizeRecurrence({ every: 'fortnight' }), (e) => e.code === 'EINVAL');
  assert.throws(() => normalizeRecurrence({ every: 'day', at: '25:00' }), (e) => e.code === 'EINVAL');
  assert.throws(() => normalizeRecurrence({ every: 'week', days: ['funday'] }), (e) => e.code === 'EINVAL');
  assert.equal(describeRecurrence({ every: 'weekday', at: '09:00' }), 'every weekday at 09:00');
});

// ------------------------------------------------------------------ TaskScheduler

test('one-shot reminder fires exactly once', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const fired = [];
  s.on('due', (t) => fired.push(t));
  const task = s.add({ title: 'Call mom', when: new Date(NOW.getTime() + MIN).toISOString() });
  assert.equal(task.status, 'active');
  assert.equal(task.kind, 'reminder');
  assert.equal(s.tick().length, 0);
  clock.advance(MIN - 1);
  s.tick();
  assert.equal(fired.length, 0);
  clock.advance(1);
  s.tick();
  s.tick();
  clock.advance(HOUR);
  s.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, task.id);
  assert.equal(fired[0].title, 'Call mom');
  assert.equal(fired[0].dueAt, task.nextRunAt);
  const after = s.get(task.id);
  assert.equal(after.status, 'done');
  assert.equal(after.runs.length, 1);
  assert.equal(after.runs[0].ok, true);
  assert.equal(Date.parse(after.lastRunAt), NOW.getTime() + MIN);
  assert.equal(s.list().length, 0);
  assert.equal(s.list({ includeDone: true }).length, 1);
});

test('daily recurrence advances to the next day (and survives DST)', () => {
  const clock = fakeClock(L(2026, 10, 30, 7, 0));
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const fired = [];
  s.on('due', (t) => fired.push(t));
  const t = s.add({ title: 'Vitamins', recurrence: { every: 'day', at: '08:00' } });
  assert.equal(Date.parse(t.nextRunAt), L(2026, 10, 30, 8, 0).getTime());
  for (const [day, month] of [[30, 10], [31, 10], [1, 11], [2, 11]]) {
    clock.set(L(2026, month, day, 8, 0, 1));
    s.tick();
    s.tick();
  }
  assert.equal(fired.length, 4);
  const next = new Date(s.get(t.id).nextRunAt);
  assert.equal(next.getTime(), L(2026, 11, 3, 8, 0).getTime());
  assert.equal(next.getHours(), 8);
  assert.equal(s.get(t.id).status, 'active');
  assert.equal(s.get(t.id).runs.length, 4);
});

test('weekday recurrence skips the weekend', () => {
  const clock = fakeClock(L(2026, 10, 1, 12, 0)); // Thursday noon
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const fired = [];
  s.on('due', (t) => fired.push(new Date(t.dueAt).getDay()));
  const t = s.add({ title: 'Standup', when: 'every weekday at 9' });
  assert.deepEqual(t.recurrence, { every: 'weekday', interval: 1, at: '09:00' });
  assert.equal(Date.parse(t.nextRunAt), L(2026, 10, 2, 9, 0).getTime()); // Friday
  clock.set(L(2026, 10, 2, 9, 0));
  s.tick();
  assert.equal(Date.parse(s.get(t.id).nextRunAt), L(2026, 10, 5, 9, 0).getTime()); // Monday
  for (const d of [3, 4]) { clock.set(L(2026, 10, d, 9, 30)); s.tick(); } // Sat, Sun: nothing
  assert.deepEqual(fired, [5]);
  clock.set(L(2026, 10, 5, 9, 0));
  s.tick();
  assert.deepEqual(fired, [5, 1]);
  assert.equal(Date.parse(s.get(t.id).nextRunAt), L(2026, 10, 6, 9, 0).getTime());
});

test('interval minutes: fires each interval, no burst after sleep, phase preserved', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  let count = 0;
  s.on('due', () => count++);
  const t = s.add({ title: 'Drink water', recurrence: { every: 'minute', interval: 15 } });
  assert.equal(Date.parse(t.nextRunAt), NOW.getTime() + 15 * MIN);
  clock.advance(15 * MIN);
  s.tick();
  assert.equal(count, 1);
  assert.equal(Date.parse(s.get(t.id).nextRunAt), NOW.getTime() + 30 * MIN);
  clock.advance(15 * MIN);
  s.tick();
  assert.equal(count, 2);
  // Machine sleeps for 5h07m: exactly one catch-up fire, next occurrence is in the future on the 15-min grid.
  clock.advance(5 * HOUR + 7 * MIN);
  s.tick();
  s.tick();
  assert.equal(count, 3);
  const next = Date.parse(s.get(t.id).nextRunAt);
  assert.ok(next > clock.now().getTime());
  assert.ok(next - clock.now().getTime() <= 15 * MIN);
  assert.equal((next - NOW.getTime()) % (15 * MIN), 0);
});

test('daily task after multi-day sleep fires once and skips missed days', () => {
  const clock = fakeClock(L(2026, 9, 30, 7, 0));
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  let count = 0;
  s.on('due', () => count++);
  const t = s.add({ title: 'Journal', when: 'every day at 8am' });
  clock.set(L(2026, 10, 5, 13, 0)); // asleep for 5+ days
  const fired = s.tick();
  assert.equal(fired.length, 1);
  assert.ok(fired[0].lateMs > 5 * 24 * HOUR - 1);
  s.tick();
  assert.equal(count, 1);
  assert.equal(Date.parse(s.get(t.id).nextRunAt), L(2026, 10, 6, 8, 0).getTime());
});

test('overdue one-shot found at start fires once; not again after restart', () => {
  const file = tmpFile();
  const clock = fakeClock(NOW);
  const s1 = new TaskScheduler({ file, now: clock.now });
  const t = s1.add({ title: 'Take pills', when: new Date(NOW.getTime() + 10 * MIN) });
  const r = s1.add({ title: 'Hourly', recurrence: { every: 'hour' } });
  // Server is down for 3 hours.
  clock.advance(3 * HOUR);
  const s2 = new TaskScheduler({ file, now: clock.now, tickMs: 60_000 });
  const fired = [];
  s2.on('due', (x) => fired.push(x.id));
  s2.start();
  s2.tick();
  s2.stop();
  assert.deepEqual(fired.sort(), [t.id, r.id].sort());
  assert.equal(s2.get(t.id).status, 'done');
  assert.ok(Date.parse(s2.get(r.id).nextRunAt) > clock.now().getTime());
  // Restart again at the same instant: persisted state prevents duplicate firing.
  const s3 = new TaskScheduler({ file, now: clock.now });
  const again = [];
  s3.on('due', (x) => again.push(x.id));
  s3.start();
  s3.stop();
  assert.deepEqual(again, []);
});

test('cancel prevents firing; list/includeDone reflect it; unknown id → null', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  let count = 0;
  s.on('due', () => count++);
  const t = s.add({ title: 'Cancel me', when: new Date(NOW.getTime() + MIN) });
  const c = s.cancel(t.id);
  assert.equal(c.status, 'cancelled');
  assert.equal(s.cancel(t.id).status, 'cancelled'); // idempotent
  clock.advance(HOUR);
  s.tick();
  assert.equal(count, 0);
  assert.equal(s.list().length, 0);
  assert.equal(s.list({ includeDone: true })[0].status, 'cancelled');
  assert.equal(s.cancel('nope'), null);
  assert.equal(s.get('nope'), null);
  assert.equal(s.remove(t.id), true);
  assert.equal(s.get(t.id), null);
});

test('update patches fields, reschedules, validates', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const t = s.add({ title: 'Old', when: new Date(NOW.getTime() + HOUR), notes: 'n1' });
  const u = s.update(t.id, { title: 'New', when: new Date(NOW.getTime() + 2 * HOUR).toISOString(), notes: 'n2' });
  assert.equal(u.title, 'New');
  assert.equal(u.notes, 'n2');
  assert.equal(Date.parse(u.nextRunAt), NOW.getTime() + 2 * HOUR);
  const u2 = s.update(t.id, { recurrence: { every: 'day', at: '07:15' } });
  assert.deepEqual(u2.recurrence, { every: 'day', interval: 1, at: '07:15' });
  assert.equal(Date.parse(u2.nextRunAt), L(2026, 10, 1, 7, 15).getTime());
  const u3 = s.update(t.id, { when: 'tomorrow at 6pm', recurrence: null });
  assert.equal(u3.recurrence, null);
  assert.equal(Date.parse(u3.nextRunAt), L(2026, 10, 1, 18, 0).getTime());
  assert.throws(() => s.update(t.id, { kind: 'bogus' }), (e) => e.code === 'EINVAL' && e.status === 400);
  assert.throws(() => s.update(t.id, { when: 'whenever' }), (e) => e.code === 'EINVAL');
  assert.throws(() => s.update(t.id, { title: '  ' }), (e) => e.code === 'EINVAL');
  assert.equal(s.update('missing', { title: 'x' }), null);
  assert.equal(s.get(t.id).title, 'New'); // failed updates left the task untouched
});

test('runNow emits due immediately without moving the schedule; markRun completes agent runs', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const fired = [];
  s.on('due', (t) => fired.push(t));
  const t = s.add({ title: 'Price check', kind: 'agent', prompt: 'Check the price of AirPods', recurrence: { every: 'day', at: '08:00' } });
  const before = t.nextRunAt;
  const r = s.runNow(t.id);
  assert.equal(r.id, t.id);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].manual, true);
  assert.equal(fired[0].prompt, 'Check the price of AirPods');
  assert.equal(s.get(t.id).nextRunAt, before);
  assert.equal(s.get(t.id).status, 'active');
  assert.equal(s.get(t.id).runs.at(-1).ok, null); // pending until markRun
  const m = s.markRun(t.id, { ok: true, summary: '$129 at Target' });
  assert.equal(m.runs.length, 1);
  assert.equal(m.runs[0].ok, true);
  assert.equal(m.runs[0].summary, '$129 at Target');
  s.markRun(t.id, { ok: false, summary: 'second' }); // no pending entry → appended
  assert.equal(s.get(t.id).runs.length, 2);
  assert.equal(s.runNow('missing'), null);
  assert.equal(s.markRun('missing', { ok: true }), null);
});

test('persistence: reload restores tasks; file is valid JSON; no temp files left', () => {
  const file = tmpFile();
  const clock = fakeClock(NOW);
  const s1 = new TaskScheduler({ file, now: clock.now });
  const a = s1.add({ title: 'A', when: new Date(NOW.getTime() + HOUR), notes: 'note' });
  const b = s1.add({ title: 'B', kind: 'agent', prompt: 'do b', recurrence: { every: 'weekday', at: '09:00' } });
  s1.cancel(a.id);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.tasks.length, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')), []);
  const s2 = new TaskScheduler({ file, now: clock.now });
  assert.deepEqual(s2.get(a.id), s1.get(a.id));
  assert.deepEqual(s2.get(b.id), s1.get(b.id));
  assert.equal(s2.get(b.id).recurrence.every, 'weekday');
  assert.equal(s2.list().length, 1);
});

test('persistence: corrupt file is set aside and scheduler starts empty', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  const s = new TaskScheduler({ file, now: () => NOW });
  assert.equal(s.list({ includeDone: true }).length, 0);
  assert.ok(s.loadError);
  s.add({ title: 'x', when: new Date(NOW.getTime() + MIN) });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length, 1);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
});

test('list is sorted by nextRunAt', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  s.add({ title: 'third', when: new Date(NOW.getTime() + 3 * HOUR) });
  s.add({ title: 'first', when: new Date(NOW.getTime() + 1 * HOUR) });
  s.add({ title: 'second', recurrence: { every: 'hour', interval: 2 } });
  s.add({ title: 'fourth', when: 'tomorrow at 9am' });
  assert.deepEqual(s.list().map((t) => t.title), ['first', 'second', 'third', 'fourth']);
  assert.equal(s.nextTaskAt(), new Date(NOW.getTime() + HOUR).toISOString());
  assert.equal(s.stats().active, 4);
});

test('add: natural-language when, defaults and validation', () => {
  const s = new TaskScheduler({ now: () => NOW }); // in-memory (no file)
  const t = s.add({ when: 'remind me to call mom at 6pm' });
  assert.equal(t.title, 'call mom');
  assert.equal(Date.parse(t.nextRunAt), L(2026, 9, 30, 18, 0).getTime());
  const w = s.add({ title: 'Weekly review', recurrence: { every: 'week' }, when: L(2026, 10, 2, 16, 0) });
  assert.deepEqual(w.recurrence, { every: 'week', interval: 1, at: '16:00', days: ['fri'] }); // anchored from first run
  const g = s.add({ kind: 'agent', prompt: 'Summarize the news', when: 'every day at 7am' });
  assert.equal(g.title, 'Summarize the news');
  assert.equal(g.kind, 'agent');
  // Recurring task with a past first run rolls forward instead of firing now.
  const past = s.add({ title: 'Morning pages', when: L(2026, 9, 30, 8, 0), recurrence: { every: 'day' } });
  assert.equal(Date.parse(past.nextRunAt), L(2026, 10, 1, 8, 0).getTime());
  assert.equal(past.recurrence.at, '08:00');
  assert.equal(s.tick().filter((x) => x.id === past.id).length, 0);
  assert.throws(() => s.add({ title: 'x' }), (e) => e.code === 'EINVAL');
  assert.throws(() => s.add({ title: 'x', when: 'sometime maybe' }), (e) => e.code === 'EINVAL');
  assert.throws(() => s.add({ title: 'x', when: NOW, kind: 'robot' }), (e) => e.code === 'EINVAL');
  assert.throws(() => s.add({ title: 'x', recurrence: { every: 'century' } }), (e) => e.code === 'EINVAL');
});

test('runs history is capped at 20', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const t = s.add({ title: 'tick', recurrence: { every: 'minute' } });
  for (let i = 0; i < 25; i++) { clock.advance(MIN); s.tick(); }
  assert.equal(s.get(t.id).runs.length, 20);
});

test('a throwing due listener does not break the loop or cause re-firing', () => {
  const clock = fakeClock(NOW);
  const s = new TaskScheduler({ file: tmpFile(), now: clock.now });
  const errors = [];
  s.on('error', (e) => errors.push(e));
  let calls = 0;
  s.on('due', () => { calls++; throw new Error('boom'); });
  s.add({ title: 'a', when: NOW });
  s.add({ title: 'b', when: NOW });
  s.tick();
  s.tick();
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

test('start() uses an unref()ed real timer and fires due tasks promptly', async () => {
  const s = new TaskScheduler({ file: tmpFile(), tickMs: 1000 });
  const got = new Promise((resolve) => s.once('due', resolve));
  s.start();
  s.add({ title: 'soon', when: new Date(Date.now() + 50) });
  assert.ok(s._timer, 'timer armed');
  assert.equal(s._timer.hasRef(), false, 'timer must not keep the process alive');
  const t = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
  assert.equal(t.title, 'soon');
  s.stop();
  assert.equal(s._timer, null);
});
