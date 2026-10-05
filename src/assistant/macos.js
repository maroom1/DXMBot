// macOS integration for the Cairn assistant: notifications, Reminders.app,
// Calendar.app, opening URLs/apps, clipboard and speech.
//
// Safety rules:
// - Never a shell: every command is spawned directly (osascript / open / pbcopy /
//   pbpaste) with an argument array; AppleScript source goes to osascript's stdin.
// - Every user-supplied string embedded in AppleScript goes through
//   escapeAppleScript() (backslash, double quote, line breaks, control chars).
// - Dates are built from numeric components (set year/month/day/hours/...) — never
//   by coercing a locale-dependent date string.
// - CAIRN_MAC_DRYRUN=1 (checked at call time): nothing is executed; functions return
//   {ok:true, dryRun:true, script} so tests can inspect exactly what would run.
//
// Every function resolves to {ok, error?, dryRun?, script?, ...extra}; none throw.
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20_000;
// Reminders/Calendar may show a one-time macOS Automation consent dialog; give the
// user time to click it.
const APP_TIMEOUT_MS = 120_000;
const MAX_TEXT = 4000;
const NOTIFY_SOUND = 'Glass';

export const isDryRun = () => process.env.CAIRN_MAC_DRYRUN === '1';

// ---------- AppleScript helpers ----------

/** Escape a value for use inside an AppleScript double-quoted string literal. */
export function escapeAppleScript(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n')
    .replace(/\t/g, '\\t')
    // Remaining C0 controls / DEL have no business in a reminder title.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** `"escaped"` — an AppleScript string literal. */
export const asString = (value) => `"${escapeAppleScript(value)}"`;

const clip = (value, max = MAX_TEXT) => {
  const s = String(value ?? '');
  return s.length > max ? s.slice(0, max) : s;
};

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * Parse an ISO 8601 date/time. Strings with an offset (or Z) are absolute; strings
 * without one are local wall-clock time; a date-only string means 09:00 local that
 * day (a sensible default for "on Friday" reminders). Returns a Date or null.
 */
export function parseIsoLocal(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, tz] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let date;
  if (hh === undefined) {
    date = new Date(year, month - 1, day, 9, 0, 0, 0);
  } else if (tz) {
    const normalized = s.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2').replace(/([+-]\d{2})$/, '$1:00');
    date = new Date(normalized);
  } else {
    if (Number(hh) > 23 || Number(mi) > 59 || Number(ss || 0) > 59) return null;
    date = new Date(year, month - 1, day, Number(hh), Number(mi), Number(ss || 0), 0);
  }
  if (Number.isNaN(date.getTime())) return null;
  // Reject roll-overs such as 2026-02-31.
  if (hh === undefined || !tz) {
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  }
  return date;
}

/** Local ISO 8601 with numeric offset, e.g. 2026-10-01T09:00:00-07:00. */
export function localIso(date = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/**
 * AppleScript lines that build `varName` as a date from local components. The day is
 * set to 1 first so changing the month can never overflow (e.g. Jan 31 → Feb).
 */
export function appleScriptDateLines(varName, date) {
  return [
    `set ${varName} to current date`,
    `set day of ${varName} to 1`,
    `set year of ${varName} to ${date.getFullYear()}`,
    `set month of ${varName} to ${date.getMonth() + 1}`,
    `set day of ${varName} to ${date.getDate()}`,
    `set hours of ${varName} to ${date.getHours()}`,
    `set minutes of ${varName} to ${date.getMinutes()}`,
    `set seconds of ${varName} to ${date.getSeconds()}`,
  ];
}

// ---------- process runner ----------

function friendlyError(stderr, code, bin) {
  const text = String(stderr || '').trim();
  if (/-1743|not authori[sz]ed to send apple events/i.test(text)) {
    return 'macOS blocked the automation request. Allow it in System Settings → Privacy & Security → Automation (enable the target app for the program running Cairn), then try again.';
  }
  if (/-1728|can.t get list|can.t get calendar/i.test(text)) return `The requested list/calendar was not found (${text}).`;
  if (/-128|user canceled/i.test(text)) return 'The request was cancelled on screen.';
  return text || `${bin} exited with code ${code}`;
}

/** Spawn a binary with args (no shell), optionally feeding stdin. Never throws. */
export function run(bin, args = [], { input, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve({ ok: false, error: `${bin} could not be started: ${e.message}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, error: `${bin} timed out after ${Math.round(timeoutMs / 1000)} s (a macOS permission dialog may be waiting for you)` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish({ ok: false, error: `${bin} could not be started: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, output: stdout.replace(/\n$/, '') });
      else finish({ ok: false, error: friendlyError(stderr, code, bin), output: stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input === undefined ? undefined : String(input));
  });
}

const notMac = () => (process.platform !== 'darwin' && !isDryRun() ? { ok: false, error: 'This feature requires macOS.' } : null);

/** Run AppleScript source (fed via stdin to `osascript -`). */
export async function runAppleScript(script, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (isDryRun()) return { ok: true, dryRun: true, script };
  const bad = notMac();
  if (bad) return bad;
  const res = await run('osascript', ['-'], { input: script, timeoutMs });
  return { ...res };
}

async function runCommand(bin, args, opts = {}) {
  const script = [bin, ...args].map((a) => (/^[\w./:@%+=,-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  if (isDryRun()) return { ok: true, dryRun: true, script, command: [bin, ...args] };
  const bad = notMac();
  if (bad) return bad;
  return run(bin, args, opts);
}

// ---------- public API ----------

export async function notify({ title = 'Cairn', message = '', subtitle, sound = true } = {}) {
  const t = clip(title || 'Cairn', 200);
  const m = clip(message, 1000);
  let line = `display notification ${asString(m)} with title ${asString(t)}`;
  if (subtitle) line += ` subtitle ${asString(clip(subtitle, 200))}`;
  if (sound) line += ` sound name ${asString(NOTIFY_SOUND)}`;
  return runAppleScript(line);
}

export async function addReminder({ title, due, list, notes } = {}) {
  const name = String(title ?? '').trim();
  if (!name) return { ok: false, error: 'A reminder title is required.' };
  let dueDate = null;
  if (due !== undefined && due !== null && due !== '') {
    dueDate = parseIsoLocal(due);
    if (!dueDate) return { ok: false, error: `Invalid due date "${due}" — use ISO 8601, e.g. 2026-10-01T09:00:00` };
  }
  const lines = [];
  if (dueDate) lines.push(...appleScriptDateLines('dueDate', dueDate));
  lines.push('tell application "Reminders"');
  if (list) {
    lines.push(
      `  if exists list ${asString(clip(list, 200))} then`,
      `    set targetList to list ${asString(clip(list, 200))}`,
      '  else',
      '    set targetList to default list',
      '  end if',
    );
  } else {
    lines.push('  set targetList to default list');
  }
  let props = `name:${asString(clip(name, 500))}`;
  if (notes) props += `, body:${asString(clip(notes))}`;
  if (dueDate) props += ', due date:dueDate, remind me date:dueDate';
  lines.push(`  make new reminder at end of targetList with properties {${props}}`, '  return name of targetList', 'end tell');
  const res = await runAppleScript(lines.join('\n'), { timeoutMs: APP_TIMEOUT_MS });
  if (res.ok && !res.dryRun) res.list = res.output;
  if (dueDate) res.due = localIso(dueDate);
  return res;
}

export async function addCalendarEvent({ title, start, end, calendar, location, notes } = {}) {
  const name = String(title ?? '').trim();
  if (!name) return { ok: false, error: 'An event title is required.' };
  const startDate = parseIsoLocal(start);
  if (!startDate) return { ok: false, error: `Invalid start "${start}" — use ISO 8601, e.g. 2026-10-01T14:00:00` };
  let endDate;
  if (end !== undefined && end !== null && end !== '') {
    endDate = parseIsoLocal(end);
    if (!endDate) return { ok: false, error: `Invalid end "${end}" — use ISO 8601` };
    if (endDate <= startDate) return { ok: false, error: 'The event end must be after its start.' };
  } else {
    endDate = new Date(startDate.getTime() + 60 * 60 * 1000);
  }
  const lines = [...appleScriptDateLines('startDate', startDate), ...appleScriptDateLines('endDate', endDate)];
  lines.push('tell application "Calendar"', '  set targetCal to missing value');
  if (calendar) {
    lines.push(`  if exists calendar ${asString(clip(calendar, 200))} then set targetCal to calendar ${asString(clip(calendar, 200))}`);
  }
  lines.push(
    '  if targetCal is missing value then',
    '    repeat with c in calendars',
    '      if writable of c then',
    '        set targetCal to contents of c',
    '        exit repeat',
    '      end if',
    '    end repeat',
    '  end if',
    '  if targetCal is missing value then error "No writable calendar found"',
  );
  let props = `summary:${asString(clip(name, 500))}, start date:startDate, end date:endDate`;
  if (location) props += `, location:${asString(clip(location, 500))}`;
  if (notes) props += `, description:${asString(clip(notes))}`;
  lines.push(`  tell targetCal to make new event at end with properties {${props}}`, '  return name of targetCal', 'end tell');
  const res = await runAppleScript(lines.join('\n'), { timeoutMs: APP_TIMEOUT_MS });
  if (res.ok && !res.dryRun) res.calendar = res.output;
  res.start = localIso(startDate);
  res.end = localIso(endDate);
  return res;
}

/** Validate a URL for openUrl: absolute http(s) only. Returns href or null. */
export function safeHttpUrl(url) {
  if (typeof url !== 'string' || !url.trim() || /[\u0000-\u001f\s]/.test(url.trim())) return null;
  let u;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u.href;
}

export async function openUrl(url) {
  const href = safeHttpUrl(url);
  if (!href) return { ok: false, error: 'Only absolute http:// or https:// URLs can be opened.' };
  const res = await runCommand('open', [href]);
  return { ...res, url: href };
}

export async function openApp(name) {
  const app = String(name ?? '').trim();
  if (!app || app.length > 120 || app.startsWith('-') || /[\u0000-\u001f\u007f]/.test(app)) {
    return { ok: false, error: 'A plain application name is required (e.g. "Safari", "Notes").' };
  }
  return runCommand('open', ['-a', app]);
}

export async function clipboardRead() {
  const res = await runCommand('pbpaste', []);
  if (res.dryRun) return { ...res, text: '' };
  if (!res.ok) return res;
  return { ok: true, text: res.output ?? '' };
}

export async function clipboardWrite(text) {
  const value = String(text ?? '');
  if (value.length > 1_000_000) return { ok: false, error: 'Text is too large for the clipboard (max 1 MB).' };
  if (isDryRun()) return { ok: true, dryRun: true, script: 'pbcopy', command: ['pbcopy'], chars: value.length };
  const bad = notMac();
  if (bad) return bad;
  const res = await run('pbcopy', [], { input: value });
  return res.ok ? { ok: true, chars: value.length } : res;
}

export async function say(text) {
  const value = clip(String(text ?? '').trim(), 2000);
  if (!value) return { ok: false, error: 'Nothing to say.' };
  return runAppleScript(`say ${asString(value)}`, { timeoutMs: 120_000 });
}

export default { notify, addReminder, addCalendarEvent, openUrl, openApp, clipboardRead, clipboardWrite, say, runAppleScript, escapeAppleScript, parseIsoLocal, localIso, isDryRun };
