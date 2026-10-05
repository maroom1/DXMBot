import net from 'node:net';

const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'mc_eid', 'mc_cid', 'msclkid', 'yclid']);

// Canonical form used everywhere a URL is a key (frontier, index, dedupe).
// Returns null for anything that is not an absolute http(s) URL.
export function normalizeUrl(input, base) {
  if (typeof input !== 'string' || !input.trim()) return null;
  let u;
  try {
    u = base ? new URL(input.trim(), base) : new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  const drop = [...u.searchParams.keys()].filter((k) => /^utm_/i.test(k) || TRACKING_PARAMS.has(k.toLowerCase()));
  for (const k of drop) u.searchParams.delete(k);
  return u.toString();
}

export function isHttpUrl(s) {
  return normalizeUrl(s) !== null;
}

export function originOf(url) {
  return new URL(url).origin;
}

// host:port — the unit of politeness / rate limiting.
export function hostOf(url) {
  return new URL(url).host;
}

// Hostname without a leading "www." — the unit of "same site" crawl scoping.
export function siteOf(url) {
  return new URL(url).hostname.replace(/^www\./, '');
}

export function sameSite(a, b) {
  try {
    return siteOf(a) === siteOf(b);
  } catch {
    return false;
  }
}

// The string robots.txt rules are matched against: path + query, never fragment.
export function pathWithQuery(url) {
  const u = new URL(url);
  return (u.pathname || '/') + u.search;
}

export function robotsUrlFor(url) {
  return `${originOf(url)}/robots.txt`;
}

function privateV4(h) {
  const [a, b] = h.split('.').map(Number);
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && h.split('.')[2] === '0') || // IETF protocol assignments 192.0.0/24
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    a >= 224 // multicast, reserved, broadcast
  );
}

// Expands an IPv6 literal (optionally ending in a dotted quad) to 8 numbers.
function ipv6Groups(h) {
  let s = h;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    s = s.slice(0, -dotted[1].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((g) => parseInt(g || '0', 16));
}

export function isPrivateHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (net.isIPv4(h)) return privateV4(h);
  if (net.isIPv6(h)) {
    const g = ipv6Groups(h.replace(/%.*$/, ''));
    const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
    const zeros = (n) => g.slice(0, n).every((x) => x === 0);
    if (zeros(8)) return true; // ::
    if (zeros(7) && g[7] === 1) return true; // ::1
    if (zeros(5) && g[5] === 0xffff) return privateV4(v4); // IPv4-mapped ::ffff:a.b.c.d
    if (zeros(6)) return privateV4(v4); // deprecated IPv4-compatible ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateV4(v4); // NAT64
    const first = g[0];
    return (
      (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
      (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
      (first & 0xffc0) === 0xfec0 || // site-local fec0::/10
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return false;
}
