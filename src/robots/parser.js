// robots.txt parsing and matching per RFC 9309 (Robots Exclusion Protocol),
// following Google's documented behaviour where the RFC leaves room.
import { Buffer } from 'node:buffer';

// RFC 9309 §2.5: crawlers must parse at least the first 500 KiB.
export const MAX_ROBOTS_BYTES = 500 * 1024;

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;
// Characters RFC 3986 never allows raw in a URI and that WHATWG URL parsing
// percent-encodes in request paths (plus ^ and | for symmetry). Encoding them on
// both sides makes `Disallow: /a<b` match the request path `/a%3Cb`.
const ALWAYS_ENCODE = new Set(['"', '<', '>', '`', '{', '}', '^', '|']);
const HEX = /^[0-9A-Fa-f]{2}$/;

function pctByte(b) {
  return '%' + b.toString(16).toUpperCase().padStart(2, '0');
}

// Canonical percent-encoding used on both sides of a match: %XX of unreserved
// characters is decoded, other %xx escapes get uppercase hex, and raw non-ASCII,
// control/space and URI-unsafe characters (" < > ` { } ^ |) are UTF-8 percent-encoded. `*` and `$` are left
// untouched so pattern metacharacters survive.
export function normalizeEncoding(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === '%' && HEX.test(s.slice(i + 1, i + 3))) {
      const hex = s.slice(i + 1, i + 3);
      const decoded = String.fromCharCode(parseInt(hex, 16));
      out += UNRESERVED.test(decoded) ? decoded : '%' + hex.toUpperCase();
      i += 3;
      continue;
    }
    const cp = s.codePointAt(i);
    if (cp <= 0x20 || cp >= 0x7f || ALWAYS_ENCODE.has(ch)) {
      const chr = String.fromCodePoint(cp);
      for (const b of Buffer.from(chr, 'utf8')) out += pctByte(b);
      i += chr.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Match a normalized path against a normalized pattern. `*` matches any
// sequence, a trailing `$` anchors the end; otherwise it is a prefix match.
// Tracks the set of reachable path positions, so it is O(path × pattern) with
// no regex backtracking.
export function matchPattern(path, pattern) {
  let pat = pattern;
  let anchored = false;
  if (pat.endsWith('$')) {
    anchored = true;
    pat = pat.slice(0, -1);
  }
  if (!pat.includes('*')) return anchored ? path === pat : path.startsWith(pat);

  const n = path.length;
  let positions = [0];
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') {
      while (pat[i + 1] === '*') i++;
      const start = positions[0];
      positions = [];
      for (let p = start; p <= n; p++) positions.push(p);
      continue;
    }
    const next = [];
    for (const p of positions) if (p < n && path[p] === c) next.push(p + 1);
    if (next.length === 0) return false;
    positions = next;
  }
  return anchored ? positions[positions.length - 1] === n : true;
}

// Accepts an absolute URL or a path (optionally with query); returns the
// normalized path+query that rules are matched against. Fragments are dropped.
export function robotsPath(urlOrPath) {
  let s = typeof urlOrPath === 'string' ? urlOrPath : String(urlOrPath ?? '');
  if (!s.startsWith('/')) {
    try {
      const u = new URL(s);
      s = (u.pathname || '/') + u.search;
    } catch {
      s = '/' + s;
    }
  }
  const hash = s.indexOf('#');
  if (hash >= 0) s = s.slice(0, hash);
  return normalizeEncoding(s || '/');
}

function toTokens(tokens) {
  if (tokens == null) return [];
  return (Array.isArray(tokens) ? tokens : [tokens]).map((t) => String(t).trim()).filter(Boolean);
}

// RFC 9309 §2.2.1: a group matches a product token case-insensitively. A UA
// line like "CairnSearch/1.0" is also accepted for token "CairnSearch".
function agentMatches(agent, tokenLower) {
  return agent === tokenLower || agent.startsWith(tokenLower + '/');
}

export class RobotsTxt {
  constructor({ groups = [], sitemaps = [], truncated = false, note = null } = {}) {
    this.groups = groups;
    this.sitemaps = sitemaps;
    this.truncated = truncated;
    // Set for synthetic policies (allowAll/disallowAll) so explanations can say why.
    this.note = note;
    this._norm = new Map();
  }

  static allowAll(note = 'No robots.txt restrictions apply (allow all).') {
    return new RobotsTxt({ note });
  }

  static disallowAll(note = 'robots.txt treated as disallow-all.') {
    return new RobotsTxt({
      groups: [{ userAgents: ['*'], rules: [{ type: 'disallow', path: '/' }], crawlDelay: null }],
      note,
    });
  }

  selectGroup(tokens) {
    const tryAgent = (lower) => {
      const matched = this.groups.filter((g) => g.userAgents.some((a) => agentMatches(a, lower)));
      if (matched.length === 0) return null;
      const crawlDelay = matched.find((g) => g.crawlDelay !== null)?.crawlDelay ?? null;
      return { rules: matched.flatMap((g) => g.rules), crawlDelay };
    };
    for (const token of toTokens(tokens)) {
      if (token === '*') continue;
      const g = tryAgent(token.toLowerCase());
      if (g) return { matchedAgent: token, ...g };
    }
    const star = this.groups.filter((g) => g.userAgents.includes('*'));
    if (star.length === 0) return null;
    return {
      matchedAgent: '*',
      rules: star.flatMap((g) => g.rules),
      crawlDelay: star.find((g) => g.crawlDelay !== null)?.crawlDelay ?? null,
    };
  }

  _normalizedPattern(p) {
    let n = this._norm.get(p);
    if (n === undefined) {
      n = normalizeEncoding(p);
      this._norm.set(p, n);
    }
    return n;
  }

  // Full decision detail (used by isAllowed and explainDecision).
  evaluate(tokens, urlOrPath) {
    const path = robotsPath(urlOrPath);
    const pathOnly = path.split('?')[0];
    if (pathOnly === '/robots.txt') {
      return { allowed: true, rule: null, matchedAgent: null, path, reason: 'robots-txt', group: null, matches: [] };
    }
    const group = this.selectGroup(tokens);
    if (!group) {
      return { allowed: true, rule: null, matchedAgent: null, path, reason: 'no-group', group: null, matches: [] };
    }
    const matches = [];
    let best = null;
    let bestLen = -1;
    for (const rule of group.rules) {
      if (!rule.path) continue;
      const pattern = this._normalizedPattern(rule.path);
      if (!matchPattern(path, pattern)) continue;
      // Pattern length in octets; the normalized form is pure ASCII.
      const len = pattern.length;
      matches.push({ rule, length: len });
      if (len > bestLen || (len === bestLen && rule.type === 'allow' && best.type !== 'allow')) {
        best = rule;
        bestLen = len;
      }
    }
    return {
      allowed: best ? best.type === 'allow' : true,
      rule: best ? { type: best.type, path: best.path } : null,
      matchedAgent: group.matchedAgent,
      path,
      reason: best ? 'rule' : 'no-rule',
      group,
      matches,
    };
  }

  isAllowed(tokens, urlOrPath) {
    const { allowed, rule, matchedAgent } = this.evaluate(tokens, urlOrPath);
    return { allowed, rule, matchedAgent };
  }

  crawlDelay(tokens) {
    return this.selectGroup(tokens)?.crawlDelay ?? null;
  }
}

export function parseRobots(input) {
  let text = input == null ? '' : Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > MAX_ROBOTS_BYTES) {
    text = Buffer.from(text, 'utf8').subarray(0, MAX_ROBOTS_BYTES).toString('utf8');
    // Drop the (possibly cut) last line rather than acting on half a rule.
    const lastBreak = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'));
    text = lastBreak >= 0 ? text.slice(0, lastBreak) : '';
    truncated = true;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const groups = [];
  const sitemaps = [];
  let current = null;
  let currentHasMembers = false;

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf('#');
    const line = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    switch (key) {
      case 'user-agent': {
        if (!value) break;
        // Consecutive user-agent lines share a group; one after rules starts a new group.
        if (!current || currentHasMembers) {
          current = { userAgents: [], rules: [], crawlDelay: null };
          groups.push(current);
          currentHasMembers = false;
        }
        current.userAgents.push(value.toLowerCase());
        break;
      }
      case 'allow':
      case 'disallow': {
        if (!current) break; // rules before any user-agent are ignored
        currentHasMembers = true;
        if (value) current.rules.push({ type: key, path: value }); // empty value = no rule
        break;
      }
      case 'crawl-delay': {
        if (!current) break;
        currentHasMembers = true;
        const n = Number(value);
        if (value && Number.isFinite(n) && n >= 0 && current.crawlDelay === null) current.crawlDelay = n;
        break;
      }
      case 'sitemap': {
        if (value && !sitemaps.includes(value)) sitemaps.push(value);
        break;
      }
      default:
        break; // unknown directives are ignored and do not end a group
    }
  }
  return new RobotsTxt({ groups, sitemaps, truncated });
}

function fmtRule(rule) {
  return `${rule.type === 'allow' ? 'Allow' : 'Disallow'}: ${rule.path}`;
}

// Human-readable explanation of a decision, for the CLI and Robots tester UI.
export function explainDecision(robotsTxt, tokens, url) {
  const robots = robotsTxt instanceof RobotsTxt ? robotsTxt : parseRobots(robotsTxt);
  const list = toTokens(tokens);
  const who = list[0] || '*';
  const tried = [...list.filter((t) => t !== '*'), '*'].join(' → ');
  const d = robots.evaluate(list, url);
  const lines = [`${d.allowed ? 'ALLOWED' : 'DISALLOWED'}: ${d.path} for ${who}`];
  if (robots.note) lines.push(`Note: ${robots.note}`);

  switch (d.reason) {
    case 'robots-txt':
      lines.push('/robots.txt itself is always allowed.');
      break;
    case 'no-group':
      lines.push(`No group matches any of: ${tried}. With no applicable group everything is allowed.`);
      break;
    default: {
      const groupDesc =
        d.matchedAgent === '*' ? 'the "*" (all robots) group' : `the group for "${d.matchedAgent}"`;
      lines.push(`Applied ${groupDesc} (tokens tried in order: ${tried}); it has ${d.group.rules.length} rule(s).`);
      if (d.reason === 'no-rule') {
        lines.push('No rule in that group matches this path, so it is allowed.');
      } else {
        const winner = d.matches.find((m) => m.rule.path === d.rule.path && m.rule.type === d.rule.type);
        lines.push(`Deciding rule: "${fmtRule(d.rule)}" (${winner.length} octets; longest match wins, ties go to Allow).`);
        const others = d.matches.filter((m) => m !== winner);
        if (others.length) {
          lines.push(`Also matched: ${others.map((m) => `"${fmtRule(m.rule)}" (${m.length} octets)`).join(', ')}.`);
        }
      }
      if (d.group.crawlDelay !== null) lines.push(`Crawl-delay: ${d.group.crawlDelay} s.`);
    }
  }
  return lines.join('\n');
}
