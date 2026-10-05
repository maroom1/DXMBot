// Natural-language schedule parsing + recurrence arithmetic for the assistant scheduler.
//
// Everything here works in the machine's LOCAL timezone and is DST-safe: day/week
// arithmetic is done by building dates from local components (new Date(y, m, d + n, h, mi))
// instead of adding fixed 24h offsets. Minute/hour recurrences are elapsed-time intervals.
//
// Exports:
//   parseWhen(text, now?)            → {when: ISO(local offset), recurrence|null, title} | null
//   nextOccurrence(recurrence, from) → Date (first occurrence strictly after `from`) | null
//   firstOccurrence(recurrence, from)→ Date (first run for a brand-new recurring task)
//   normalizeRecurrence(rec)         → {every, interval, at?, days?} | null  (throws code 'EINVAL')
//   parseAt('9am' | '17:30')         → {h, m} | null ;  formatAt({h, m}) → 'HH:MM'
//   toLocalISO(date)                 → 'YYYY-MM-DDTHH:MM:SS±HH:MM'
//   toDate(x)                        → Date | null   (Date | epoch ms | ISO string)
//   describeRecurrence(rec)          → 'every weekday at 09:00'

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);

const DAY_ALIASES = {
  sunday: 'sun', sun: 'sun',
  monday: 'mon', mon: 'mon',
  tuesday: 'tue', tue: 'tue', tues: 'tue',
  wednesday: 'wed', wed: 'wed', weds: 'wed',
  thursday: 'thu', thu: 'thu', thur: 'thu', thurs: 'thu',
  friday: 'fri', fri: 'fri',
  saturday: 'sat', sat: 'sat',
};

const EVERY_ALIASES = {
  minute: 'minute', minutes: 'minute', min: 'minute', mins: 'minute', minutely: 'minute',
  hour: 'hour', hours: 'hour', hr: 'hour', hrs: 'hour', hourly: 'hour',
  day: 'day', days: 'day', daily: 'day', everyday: 'day',
  week: 'week', weeks: 'week', weekly: 'week',
  weekday: 'weekday', weekdays: 'weekday', workday: 'weekday', workdays: 'weekday',
};

const PART_DEFAULTS = { morning: [9, 0], noon: [12, 0], afternoon: [15, 0], evening: [18, 0], night: [20, 0] };
const DEFAULT_TIME = [9, 0];

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  'forty-five': 45, 'forty five': 45, fortyfive: 45, sixty: 60, ninety: 90,
  couple: 2, 'a couple': 2, 'a couple of': 2, 'couple of': 2, few: 3, 'a few': 3,
};

function invalid(message) {
  const err = new Error(message);
  err.code = 'EINVAL';
  err.status = 400;
  return err;
}

const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------- basic helpers

export function toDate(x) {
  if (x == null || x === '') return null;
  if (x instanceof Date) return Number.isNaN(x.getTime()) ? null : new Date(x.getTime());
  if (typeof x === 'number') return Number.isFinite(x) ? new Date(x) : null;
  if (typeof x === 'string') {
    const s = x.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dateOnly) {
      // Date-only ISO → local date at the default time (NOT UTC midnight).
      const d = new Date(+dateOnly[1], +dateOnly[2] - 1, +dateOnly[3], DEFAULT_TIME[0], DEFAULT_TIME[1], 0, 0);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(s)) return null;
    const d = new Date(s.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function toLocalISO(date) {
  const d = toDate(date);
  if (!d) return null;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

export function parseAt(at) {
  if (at && typeof at === 'object' && Number.isInteger(at.h)) {
    return at.h >= 0 && at.h < 24 && at.m >= 0 && at.m < 60 ? { h: at.h, m: at.m || 0 } : null;
  }
  if (typeof at !== 'string') return null;
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\s*$/i.exec(at);
  if (!m) {
    if (/^\s*noon\s*$/i.test(at)) return { h: 12, m: 0 };
    if (/^\s*midnight\s*$/i.test(at)) return { h: 0, m: 0 };
    return null;
  }
  let h = Number(m[1]);
  const mi = m[2] ? Number(m[2]) : 0;
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    const pm = m[3][0].toLowerCase() === 'p';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  if (h > 23) return null;
  return { h, m: mi };
}

export function formatAt({ h, m }) {
  return `${pad2(h)}:${pad2(m)}`;
}

export function normalizeDay(x) {
  if (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6) return DAY_NAMES[x];
  if (typeof x !== 'string') return null;
  const s = x.trim().toLowerCase().replace(/\.$/, '');
  if (DAY_ALIASES[s]) return DAY_ALIASES[s];
  if (s.endsWith('s') && DAY_ALIASES[s.slice(0, -1)]) return DAY_ALIASES[s.slice(0, -1)];
  return null;
}

// ---------------------------------------------------------------- recurrence

/** Validate + canonicalize a recurrence. null/undefined/false → null. Throws Error{code:'EINVAL'}. */
export function normalizeRecurrence(rec) {
  if (rec == null || rec === false || rec === '') return null;
  if (typeof rec === 'string') {
    const alias = EVERY_ALIASES[rec.trim().toLowerCase()];
    if (alias) return normalizeRecurrence({ every: alias });
    const parsed = parseWhen(/^\s*(every|each)\b/i.test(rec) ? rec : `every ${rec}`);
    if (parsed && parsed.recurrence) return parsed.recurrence;
    throw invalid(`Unrecognized recurrence: ${rec}`);
  }
  if (typeof rec !== 'object') throw invalid('recurrence must be an object');
  const every = EVERY_ALIASES[String(rec.every || rec.unit || rec.frequency || '').trim().toLowerCase()];
  if (!every) throw invalid(`recurrence.every must be one of minute|hour|day|week|weekday (got ${JSON.stringify(rec.every)})`);
  let interval = rec.interval == null || rec.interval === '' ? 1 : Number(rec.interval);
  if (!Number.isFinite(interval) || interval < 1) throw invalid('recurrence.interval must be a positive integer');
  interval = Math.min(Math.floor(interval), 10000);
  const out = { every, interval };
  if (rec.at != null && rec.at !== '') {
    if (every === 'minute' || every === 'hour') {
      // `at` has no meaning for elapsed-time intervals; ignore rather than reject.
    } else {
      const at = parseAt(rec.at);
      if (!at) throw invalid(`recurrence.at must be HH:MM (got ${JSON.stringify(rec.at)})`);
      out.at = formatAt(at);
    }
  }
  if (rec.days != null) {
    const list = Array.isArray(rec.days) ? rec.days : String(rec.days).split(/[\s,]+/).filter(Boolean);
    const set = new Set();
    for (const d of list) {
      const n = normalizeDay(d);
      if (!n) throw invalid(`recurrence.days contains an unknown day: ${JSON.stringify(d)}`);
      set.add(n);
    }
    let days = DAY_NAMES.filter((d) => set.has(d));
    if (every === 'weekday') days = days.filter((d) => WEEKDAYS.has(d));
    if (days.length && !(every === 'weekday' && days.length === 5)) out.days = days;
  }
  return out;
}

export function describeRecurrence(rec) {
  let r;
  try { r = normalizeRecurrence(rec); } catch { return ''; }
  if (!r) return '';
  const unit = r.interval === 1 ? r.every : `${r.interval} ${r.every}s`;
  let s = r.every === 'weekday' ? 'every weekday' : `every ${unit}`;
  if (r.every === 'week' && r.days) s = `every ${r.interval > 1 ? `${r.interval} weeks on ` : ''}${r.days.join(', ')}`;
  else if (r.days) s += ` on ${r.days.join(', ')}`;
  if (r.at) s += ` at ${r.at}`;
  return s;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * First occurrence strictly after `from`. Minute/hour: from + interval (elapsed time).
 * Day/weekday/week: next local wall-clock `at` (default: from's HH:MM) on an allowed day,
 * honouring `interval` relative to `from`'s day/week (from is assumed to be an occurrence).
 */
export function nextOccurrence(recurrence, from = new Date()) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return null;
  const f = toDate(from);
  if (!f) throw invalid('nextOccurrence: invalid `from` date');
  const fromMs = f.getTime();
  const daysSet = rec.days ? new Set(rec.days) : null;
  const dayOk = (d) => !daysSet || daysSet.has(DAY_NAMES[d.getDay()]);

  if (rec.every === 'minute' || rec.every === 'hour') {
    const step = rec.interval * (rec.every === 'minute' ? MINUTE_MS : HOUR_MS);
    let t = fromMs + step;
    for (let i = 0; i < 200_000 && !dayOk(new Date(t)); i++) t += step;
    return new Date(t);
  }

  const at = rec.at ? parseAt(rec.at) : { h: f.getHours(), m: f.getMinutes() };
  const y = f.getFullYear();
  const mo = f.getMonth();
  const d0 = f.getDate();
  const mk = (i) => new Date(y, mo, d0 + i, at.h, at.m, 0, 0); // local components → DST-safe
  const n = rec.interval;

  const search = (useInterval) => {
    if (rec.every === 'day') {
      const limit = 400 * (useInterval ? n : 1) + 14;
      for (let i = 0; i <= limit; i++) {
        if (useInterval && i % n) continue;
        const c = mk(i);
        if (c.getTime() > fromMs && dayOk(c)) return c;
      }
    } else if (rec.every === 'weekday') {
      for (let i = 0; i <= 14; i++) {
        const c = mk(i);
        if (c.getTime() > fromMs && WEEKDAYS.has(DAY_NAMES[c.getDay()]) && dayOk(c)) return c;
      }
    } else if (rec.every === 'week') {
      const days = daysSet || new Set([DAY_NAMES[f.getDay()]]);
      const offset = (f.getDay() + 6) % 7; // position of `from` in its Monday-based week
      const limit = 7 * (useInterval ? n : 1) + 14;
      for (let i = 0; i <= limit; i++) {
        const weekIdx = Math.floor((offset + i) / 7);
        if (useInterval && weekIdx % n) continue;
        const c = mk(i);
        if (c.getTime() > fromMs && days.has(DAY_NAMES[c.getDay()])) return c;
      }
    }
    return null;
  };
  // An unsatisfiable interval/days combination falls back to ignoring the interval.
  return search(true) || search(false);
}

/** First run for a new recurring task created at `from` (interval phase starts at the first run). */
export function firstOccurrence(recurrence, from = new Date()) {
  const rec = normalizeRecurrence(recurrence);
  if (!rec) return null;
  if (rec.every === 'minute' || rec.every === 'hour') return nextOccurrence(rec, from);
  return nextOccurrence({ ...rec, interval: 1 }, from);
}

// ---------------------------------------------------------------- parseWhen

const NUM_RE = '(\\d+(?:\\.\\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty[- ]?five|forty|sixty|ninety|(?:a\\s+)?couple(?:\\s+of)?|(?:a\\s+)?few)';
const UNIT_RE = '(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|wks?)';
const DAY_FULL = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)';
const DAY_ABBR = '(?:sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)';
const DAY_ANY = `(?:${DAY_FULL}s?|${DAY_ABBR}s?)`;
const MONTH_RE = '(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';

function numValue(s) {
  const k = s.toLowerCase().replace(/\s+/g, ' ');
  if (/^\d/.test(k)) return Number(k);
  if (k in NUM_WORDS) return NUM_WORDS[k];
  return NUM_WORDS[k.replace(/-/g, ' ')] ?? NaN;
}

function unitKind(u) {
  const k = u.toLowerCase();
  if (/^s(ec)?/.test(k)) return 's';
  if (/^m(in)?/.test(k)) return 'm';
  if (/^h/.test(k)) return 'h';
  if (/^d/.test(k)) return 'd';
  if (/^w/.test(k)) return 'w';
  return null;
}

function applyMeridiem(h, mer) {
  const pm = mer[0].toLowerCase() === 'p';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

const SENT = '\u0000';

/**
 * Parse common English scheduling phrases. Returns null when no time expression is found.
 * `when` is a local ISO string with offset; `recurrence` is normalized or null; `title` is the
 * remaining text with filler like "remind me to" stripped ('' if nothing is left).
 */
export function parseWhen(text, now = new Date()) {
  if (text == null) return null;
  const nowD = toDate(now) || new Date();
  const nowMs = nowD.getTime();
  let s = String(text).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 2000) return null;

  const st = {
    iso: null, rec: null, durMs: 0, durDays: 0, hasDur: false, dayOffset: null, date: null,
    weekday: null, time: null, part: null, tonight: false, recStartsNextWeek: false,
  };
  const take = (re, fn) => {
    s = s.replace(re, (...args) => (fn(...args) === false ? args[0] : SENT));
  };

  // 1. ISO 8601 date-time (anywhere in the text).
  take(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\w:])/i, (m) => {
    const d = toDate(m.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (!d) return false;
    st.iso = d;
  });

  // 2. Recurrence.
  take(/\b(?:every|each|on)\s+(?:week\s?day|work\s?day|business\s+day)s?\b|\bweekdays\b/i, () => {
    st.rec = { every: 'weekday' };
  });
  if (!st.rec) {
    take(/\b(?:every|each)\s+weekend\b|\b(?:on\s+)?weekends\b/i, () => {
      st.rec = { every: 'week', days: ['sat', 'sun'] };
    });
  }
  if (!st.rec) {
    const list = `${DAY_ANY}(?:\\s*(?:,|and|&|\\/|\\+)\\s*(?:and\\s+)?${DAY_ANY})*`;
    take(new RegExp(`\\b(?:every|each)\\s+(other\\s+)?(${list})\\b\\.?`, 'i'), (m, other, days) => {
      const names = days.split(/\s*(?:,|and|&|\/|\+)\s*/i).map((d) => normalizeDay(d.trim())).filter(Boolean);
      if (!names.length) return false;
      st.rec = { every: 'week', days: names, interval: other ? 2 : 1 };
    });
  }
  if (!st.rec) {
    const plural = '(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)';
    take(new RegExp(`\\b(?:on\\s+)?(${plural}(?:\\s*(?:,|and|&)\\s*(?:and\\s+)?${plural})*)\\b`, 'i'), (m, days) => {
      st.rec = { every: 'week', days: days.split(/\s*(?:,|and|&)\s*/i).map((d) => normalizeDay(d.trim())).filter(Boolean) };
    });
  }
  if (!st.rec) {
    take(/\b(?:every|each)\s+(morning|afternoon|evening|night)\b/i, (m, part) => {
      st.rec = { every: 'day' };
      st.part = part.toLowerCase();
    });
  }
  if (!st.rec) {
    take(new RegExp(`\\b(?:every|each)\\s+(?:(other)\\s+|${NUM_RE}\\s*)?(minute|min|hour|hr|day|week)s?\\b`, 'i'), (m, other, num, unit) => {
      let interval = other ? 2 : num ? numValue(num) : 1;
      if (!Number.isFinite(interval) || interval <= 0) return false;
      let every = EVERY_ALIASES[unit.toLowerCase()];
      if (!Number.isInteger(interval)) {
        if (every === 'hour') { every = 'minute'; interval = Math.round(interval * 60); } else interval = Math.max(1, Math.round(interval));
      }
      st.rec = { every, interval };
    });
  }
  if (!st.rec) {
    take(/\b(everyday|daily|hourly|weekly)\b/i, (m, w) => {
      st.rec = { every: EVERY_ALIASES[w.toLowerCase()] };
    });
  }

  // 3. Relative durations: "in 10 minutes", "in 1 hour and 30 minutes", "in half an hour", "2 hours from now".
  const addDur = (n, kind) => {
    st.hasDur = true;
    if (kind === 's') st.durMs += n * 1000;
    else if (kind === 'm') st.durMs += n * MINUTE_MS;
    else if (kind === 'h') st.durMs += n * HOUR_MS;
    else if (kind === 'd') st.durDays += n;
    else if (kind === 'w') st.durDays += n * 7;
  };
  take(/\b(?:in|within|after)\s+(?:a\s+)?half\s+(?:an?\s+)?hour\b/i, () => addDur(30, 'm'));
  take(/\b(?:in|within|after)\s+(?:a\s+)?quarter\s+(?:of\s+)?(?:an?\s+)?hour\b/i, () => addDur(15, 'm'));
  // "<number> <unit word>" or a compact digit form like "10m", "2h", "3d".
  const pair = `(?:${NUM_RE}\\s*${UNIT_RE}|(\\d+(?:\\.\\d+)?)\\s?([smhdw]))\\b`;
  const parsePairs = (chunk) => {
    const re = new RegExp(pair, 'gi');
    let m;
    let ok = false;
    while ((m = re.exec(chunk))) {
      const n = numValue(m[1] ?? m[3]);
      const k = unitKind(m[2] ?? m[4]);
      if (!Number.isFinite(n) || !k) continue;
      if ((k === 'd' || k === 'w') && !Number.isInteger(n)) { addDur(n * (k === 'w' ? 7 : 1) * 24, 'h'); ok = true; continue; }
      addDur(n, k);
      ok = true;
    }
    if (/and\s+a\s+half\s*$/i.test(chunk)) {
      const last = [...chunk.matchAll(new RegExp(pair, 'gi'))].pop();
      if (last) {
        const k = unitKind(last[2] ?? last[4]);
        if (k === 'h') addDur(30, 'm');
        else if (k === 'm') addDur(0.5, 'm');
        else if (k === 'd') addDur(12, 'h');
      }
    }
    return ok;
  };
  if (!st.rec) {
    const chain = `(${pair}(?:\\s*(?:,|and)?\\s*${pair})*(?:\\s+and\\s+a\\s+half)?)`;
    take(new RegExp(`\\b(?:in|within|after)\\s+${chain}`, 'i'), (m, chunk) => (parsePairs(chunk) ? undefined : false));
    take(new RegExp(`${chain}\\s+from\\s+now\\b`, 'i'), (m, chunk) => (parsePairs(chunk) ? undefined : false));
  }

  // 4. Relative day words.
  take(/\b(?:the\s+)?day\s+after\s+(?:tomorrow|tmrw)\b/i, () => { st.dayOffset = 2; });
  if (st.dayOffset == null) take(/\b(?:tomorrow|tomorow|tommorow|tommorrow|tmrw|tmr)\b/i, () => { st.dayOffset = 1; });
  if (st.dayOffset == null) take(/\btonight\b/i, () => { st.dayOffset = 0; st.part = st.part || 'night'; st.tonight = true; });
  if (st.dayOffset == null) take(/\btoday\b/i, () => { st.dayOffset = 0; });
  if (st.dayOffset == null) take(/\bnext\s+week\b/i, () => { st.dayOffset = 7; });

  // 5. Part of day.
  if (!st.part) {
    take(/\b(?:(this|in\s+the|at|tomorrow)\s+)?(morning|afternoon|evening|night)\b/i, (m, pre, part) => {
      st.part = part.toLowerCase();
      if (pre && /^this$/i.test(pre) && st.dayOffset == null) st.dayOffset = 0;
    });
  } else {
    take(/\b(?:(?:this|in\s+the|at)\s+)?(?:morning|afternoon|evening|night)\b/i, () => {});
  }

  // 6. Weekday names ("next monday", "on friday", "this fri", bare "friday").
  take(new RegExp(`\\b(?:(next|this|coming|on|by|until)\\s+)?(?:the\\s+)?(?:coming\\s+)?(${DAY_FULL})\\b|\\b(next|this|coming|on|by)\\s+(${DAY_ABBR})\\b\\.?`, 'i'),
    (m, pre1, full, pre2, abbr) => {
      const name = normalizeDay(full || abbr);
      if (!name) return false;
      st.weekday = { idx: DAY_NAMES.indexOf(name), name, next: /^next$/i.test(pre1 || pre2 || '') };
    });

  // 7. Calendar dates: "oct 5", "october 5th, 2027", "5th of october", "10/5".
  const setDate = (y, mo, d, explicitYear) => {
    let year = y;
    if (!explicitYear) {
      year = nowD.getFullYear();
      const cand = new Date(year, mo, d, 23, 59, 59);
      if (cand.getTime() < nowMs) year += 1;
    }
    const dt = new Date(year, mo, d);
    if (dt.getMonth() !== mo || dt.getDate() !== d) return false;
    st.date = { y: year, mo, d };
    return true;
  };
  take(new RegExp(`\\b(?:on\\s+)?${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'i'), (m, mon, d, y) => {
    if (setDate(y ? +y : null, MONTHS[mon.toLowerCase()], +d, !!y) === false) return false;
  });
  if (!st.date) {
    take(new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'i'), (m, d, mon, y) => {
      if (setDate(y ? +y : null, MONTHS[mon.toLowerCase()], +d, !!y) === false) return false;
    });
  }
  if (!st.date) {
    take(/\b(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/, (m, mo, d, y) => {
      const year = y ? (y.length === 2 ? 2000 + +y : +y) : null;
      if (+mo < 1 || +mo > 12) return false;
      if (setDate(year, +mo - 1, +d, !!y) === false) return false;
    });
  }
  if (!st.date) {
    take(/\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/i, (m, d) => {
      let y = nowD.getFullYear();
      let mo = nowD.getMonth();
      if (new Date(y, mo, +d, 23, 59, 59).getTime() < nowMs) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
      if (setDate(y, mo, +d, true) === false) return false;
    });
  }

  // 8. Times of day. `explicit` = meridiem, noon/midnight, 24h hour (>=13 or 0) or a leading zero ("08:00").
  const setTime = (h, mi, explicit) => {
    if (st.time) return false;
    if (h > 23 || mi > 59) return false;
    st.time = { h, m: mi, explicit };
  };
  take(/\b(?:(?:at|by|around|for)\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i, (m, h, mi, mer) => {
    const hh = +h;
    if (hh < 1 || hh > 12) return false;
    return setTime(applyMeridiem(hh, mer), mi ? +mi : 0, true);
  });
  take(/\b(?:(?:at|by|around)\s+)?(noon|midday|midnight)\b/i, (m, w) => setTime(/midnight/i.test(w) ? 0 : 12, 0, true));
  const isExplicit = (hs) => +hs >= 13 || +hs === 0 || (hs.length === 2 && hs[0] === '0');
  take(/\b(?:(?:at|by|around)\s+)?([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*(?:a\.?m|p\.?m))/i, (m, h, mi) =>
    setTime(+h, +mi, isExplicit(h)));
  take(/\b(?:at|around)\s+(\d{1,2})(?:\s*o'?clock)?\b(?!\s*(?:[:.%/]\d|minutes?|mins?|hours?|hrs?|days?|weeks?|percent))/i, (m, h) =>
    setTime(+h, 0, isExplicit(h)));
  take(/\b(\d{1,2})\s*o'?clock\b/i, (m, h) => setTime(+h, 0, isExplicit(h)));

  if (st.time && !st.time.explicit && st.time.h < 12) {
    // AM/PM-less hour: an afternoon/evening/night context means PM; "morning" means AM; else 1–7 → PM.
    if (st.part === 'afternoon' || st.part === 'evening' || st.part === 'night') st.time.h += 12;
    else if (st.part !== 'morning' && st.time.h >= 1 && st.time.h <= 7) st.time.h += 12;
  }

  const found = st.iso || st.rec || st.hasDur || st.dayOffset != null || st.date || st.weekday || st.time || st.part;
  if (!found) return null;

  const tod = () => (st.time ? [st.time.h, st.time.m] : st.part ? PART_DEFAULTS[st.part] : null);
  const at = (y, mo, d, hm) => new Date(y, mo, d, hm[0], hm[1], 0, 0);
  const todayY = nowD.getFullYear();
  const todayM = nowD.getMonth();
  const todayD = nowD.getDate();
  let when = null;
  let recurrence = null;

  if (st.rec) {
    const rec = { ...st.rec };
    if (rec.every === 'week' && !rec.days && st.weekday) rec.days = [st.weekday.name];
    if (rec.every === 'week' && !rec.days) rec.days = [DAY_NAMES[(st.iso || nowD).getDay()]];
    if (rec.every !== 'minute' && rec.every !== 'hour') {
      const hm = tod() || (st.iso ? [st.iso.getHours(), st.iso.getMinutes()] : DEFAULT_TIME);
      rec.at = formatAt({ h: hm[0], m: hm[1] });
    }
    recurrence = normalizeRecurrence(rec);
    // Optional explicit start ("every day at 8 starting tomorrow", ISO start, "every hour from 5pm").
    let start = nowD;
    if (st.iso) start = new Date(st.iso.getTime() - 1);
    else if (st.date) start = new Date(new Date(st.date.y, st.date.mo, st.date.d).getTime() - 1);
    else if (st.dayOffset != null && st.dayOffset > 0) start = new Date(new Date(todayY, todayM, todayD + st.dayOffset).getTime() - 1);
    if (start.getTime() < nowMs) start = nowD;
    if ((recurrence.every === 'minute' || recurrence.every === 'hour') && (st.time || st.iso)) {
      if (st.iso) when = st.iso;
      else {
        when = at(todayY, todayM, todayD, [st.time.h, st.time.m]);
        if (when.getTime() <= nowMs) when = at(todayY, todayM, todayD + 1, [st.time.h, st.time.m]);
      }
    } else {
      when = firstOccurrence(recurrence, start);
    }
  } else if (st.iso) {
    when = st.iso;
  } else if (st.hasDur) {
    when = new Date(nowMs + st.durMs);
    if (st.durDays) {
      when = new Date(when.getFullYear(), when.getMonth(), when.getDate() + st.durDays,
        when.getHours(), when.getMinutes(), when.getSeconds(), 0);
      const hm = tod();
      if (hm) when = at(when.getFullYear(), when.getMonth(), when.getDate(), hm);
    }
    when = new Date(Math.round(when.getTime() / 1000) * 1000);
  } else if (st.date) {
    when = at(st.date.y, st.date.mo, st.date.d, tod() || DEFAULT_TIME);
  } else if (st.weekday) {
    const hm = tod() || DEFAULT_TIME;
    let offset = (st.weekday.idx - nowD.getDay() + 7) % 7;
    if (st.weekday.next && offset === 0) offset = 7;
    if (st.dayOffset === 7 && offset === 0) offset = 7; // "next week friday"
    when = at(todayY, todayM, todayD + offset, hm);
    if (when.getTime() <= nowMs) when = at(todayY, todayM, todayD + offset + 7, hm);
  } else if (st.dayOffset != null) {
    const hm = tod();
    if (hm) {
      when = at(todayY, todayM, todayD + st.dayOffset, hm);
      if (st.dayOffset === 0 && when.getTime() <= nowMs) {
        if (st.tonight && !st.time) when = new Date(Math.ceil((nowMs + HOUR_MS) / MINUTE_MS) * MINUTE_MS);
        else if (!st.time) when = at(todayY, todayM, todayD + 1, hm);
      }
    } else if (st.dayOffset === 0) {
      when = at(todayY, todayM, todayD, PART_DEFAULTS.evening);
      if (when.getTime() <= nowMs) when = new Date(Math.ceil((nowMs + HOUR_MS) / MINUTE_MS) * MINUTE_MS);
    } else {
      when = at(todayY, todayM, todayD + st.dayOffset, DEFAULT_TIME);
    }
  } else {
    const hm = tod();
    when = at(todayY, todayM, todayD, hm);
    if (when.getTime() <= nowMs) when = at(todayY, todayM, todayD + 1, hm);
  }
  if (!when || Number.isNaN(when.getTime())) return null;

  return { when: toLocalISO(when), recurrence, title: cleanTitle(s) };
}

const LEAD_RES = [
  /^(?:hey|hi|ok|okay|yo)\s+cairn\b[,!:.]?\s*/i,
  /^(?:please|pls|plz|kindly)\b[,]?\s*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
  /^(?:set|create|add|make|schedule|put)\s+(?:me\s+|up\s+)?(?:a\s+|an\s+|one\s+)?(?:recurring\s+|daily\s+|weekly\s+)?(?:reminder|alarm|task|timer|notification|job)s?\b\s*(?:for\s+me\b\s*)?/i,
  /^schedule\b\s*/i,
  /^remind\s+me\b\s*/i,
  /^(?:reminder|remember|note)\b\s*[:\-–]?\s*/i,
  /^(?:don'?t|do\s+not)\s+(?:let\s+me\s+)?forget\s+/i,
  /^(?:i\s+(?:need|have|want)\s+to)\s+/i,
  /^(?:to|about|that|of|for)\s+/i,
];

function cleanTitle(raw) {
  let t = raw
    // connectors left dangling next to a removed time phrase
    .replace(new RegExp(`\\b(?:at|on|by|around|starting|beginning|from|this|next|every|each|until)\\s*(?=${SENT})`, 'gi'), '')
    .replace(new RegExp(`${SENT}\\s*(?:,\\s*)?(?:starting|beginning|from)\\b`, 'gi'), SENT)
    .replace(new RegExp(SENT, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
  const strip = () => t.replace(/^[\s,;:.!\-–—]+|[\s,;:\-–—]+$/g, '').trim();
  t = strip();
  for (let guard = 0; guard < 10; guard++) {
    const before = t;
    for (const re of LEAD_RES) t = t.replace(re, '');
    t = t.replace(/\s*\b(?:please|pls|thanks|thank\s+you)\b[.!]*$/i, '');
    t = t.replace(/\s+(?:at|on|by|to|every|starting|from|and)$/i, '');
    t = strip();
    if (t === before) break;
  }
  t = t.replace(/[.!]+$/, '').trim();
  return t;
}
