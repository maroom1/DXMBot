// Web Bot Auth (draft-meunier-web-bot-auth-architecture): every outbound request
// is signed with HTTP Message Signatures (RFC 9421) using an Ed25519 key whose
// public half is published at /.well-known/http-message-signatures-directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PRIVATE_FILE = 'ed25519-private.pem';
const PUBLIC_FILE = 'ed25519-public.pem';
const TAG = 'web-bot-auth';
const LABEL = 'sig1';
const VALIDITY_SEC = 300;
const CLOCK_SKEW_SEC = 60;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// RFC 7638 thumbprint: SHA-256 over the required members in lexicographic order.
export function jwkThumbprint(jwk) {
  if (!jwk || jwk.kty !== 'OKP' || !jwk.crv || !jwk.x) throw new Error('jwkThumbprint expects an OKP JWK with crv and x');
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return b64url(crypto.createHash('sha256').update(canonical).digest());
}

function sfString(value) {
  return `"${String(value).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

// --- Minimal RFC 8941 structured-field dictionary parser --------------------
// Returns [{key, value, params, raw}] where `raw` is the member value exactly as
// serialized (inner list + params), which RFC 9421 uses as @signature-params.
function parseDictionary(input) {
  const s = String(input);
  let i = 0;
  const out = [];
  const fail = (msg) => {
    throw new Error(`invalid structured field at ${i}: ${msg}`);
  };
  const ws = () => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  const key = () => {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
    if (!m) fail('expected key');
    i += m[0].length;
    return m[0];
  };
  const bareItem = () => {
    const c = s[i];
    if (c === '"') {
      let v = '';
      i++;
      while (i < s.length) {
        const ch = s[i++];
        if (ch === '\\') v += s[i++] ?? '';
        else if (ch === '"') return v;
        else v += ch;
      }
      fail('unterminated string');
    }
    if (c === ':') {
      const end = s.indexOf(':', i + 1);
      if (end === -1) fail('unterminated byte sequence');
      const v = Buffer.from(s.slice(i + 1, end), 'base64');
      i = end + 1;
      return v;
    }
    if (c === '?') {
      const v = s[i + 1] === '1';
      i += 2;
      return v;
    }
    let m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    m = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(s.slice(i));
    if (m) {
      i += m[0].length;
      return m[0];
    }
    return fail('expected item');
  };
  const params = () => {
    const p = {};
    while (s[i] === ';') {
      i++;
      ws();
      const k = key();
      let v = true;
      if (s[i] === '=') {
        i++;
        v = bareItem();
      }
      p[k] = v;
    }
    return p;
  };
  ws();
  while (i < s.length) {
    const k = key();
    const start = i + 1;
    let value = true;
    let p = {};
    if (s[i] === '=') {
      i++;
      if (s[i] === '(') {
        i++;
        value = [];
        for (;;) {
          ws();
          if (s[i] === ')') {
            i++;
            break;
          }
          if (i >= s.length) fail('unterminated inner list');
          const v = bareItem();
          value.push({ value: v, params: params() });
          if (s[i] !== ' ' && s[i] !== ')') fail('expected space or )');
        }
      } else {
        value = bareItem();
      }
      p = params();
    } else {
      p = params();
    }
    out.push({ key: k, value, params: p, raw: s.slice(start, i) });
    ws();
    if (i < s.length) {
      if (s[i] !== ',') fail('expected ,');
      i++;
      ws();
    }
  }
  return out;
}

// Parses a Signature-Input header into
// [{label, components:[string], params:{created,expires,keyid,alg,nonce,tag,...}, paramsString}].
export function parseSignatureInput(value) {
  return parseDictionary(value)
    .filter((m) => Array.isArray(m.value))
    .map((m) => ({
      label: m.key,
      components: m.value.map((item) => String(item.value).toLowerCase()),
      params: m.params,
      paramsString: m.raw,
    }));
}

function parseSignatureHeader(value) {
  const out = {};
  for (const m of parseDictionary(value)) if (Buffer.isBuffer(m.value)) out[m.key] = m.value;
  return out;
}

// Signature base for the Web Bot Auth component set ("@authority" "signature-agent").
// `signatureAgent` is the Signature-Agent header value as sent (an sf-string,
// e.g. "\"http://127.0.0.1:8787\""); a bare URL is quoted for convenience.
export function buildSignatureBase({ authority, signatureAgent, paramsString }) {
  const agent = /^https?:\/\//i.test(signatureAgent) ? sfString(signatureAgent) : signatureAgent;
  return [
    `"@authority": ${String(authority).toLowerCase()}`,
    `"signature-agent": ${agent}`,
    `"@signature-params": ${paramsString}`,
  ].join('\n');
}

// Generic RFC 9421 §2.5 signature base for the components a verifier encounters.
function signatureBaseFor(components, paramsString, { method, url, headers }) {
  const u = new URL(url);
  const lines = [];
  for (const name of components) {
    let v;
    switch (name) {
      case '@authority':
        v = u.host.toLowerCase();
        break;
      case '@method':
        v = String(method || 'GET').toUpperCase();
        break;
      case '@scheme':
        v = u.protocol.slice(0, -1);
        break;
      case '@target-uri':
        v = u.href;
        break;
      case '@path':
        v = u.pathname || '/';
        break;
      case '@query':
        v = u.search || '?';
        break;
      default:
        if (name.startsWith('@')) throw new Error(`unsupported derived component ${name}`);
        if (headers[name] === undefined) throw new Error(`missing covered header ${name}`);
        v = String(headers[name]).trim();
    }
    lines.push(`"${name}": ${v}`);
  }
  lines.push(`"@signature-params": ${paramsString}`);
  return lines.join('\n');
}

function unquoteSf(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\([\\"])/g, '$1');
  return v;
}

export function verifyRequest({ method = 'GET', url, headers = {} } = {}, jwks, { now = Date.now() } = {}) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v]));
  if (!h['signature-input'] || !h.signature) return { valid: false, reason: 'missing Signature-Input or Signature header' };
  let inputs;
  let sigs;
  try {
    inputs = parseSignatureInput(h['signature-input']);
    sigs = parseSignatureHeader(h.signature);
  } catch (err) {
    return { valid: false, reason: `malformed signature headers: ${err.message}` };
  }
  const input = inputs.find((x) => x.params.tag === TAG);
  if (!input) return { valid: false, reason: `no signature with tag="${TAG}"` };
  const { label, params, components, paramsString } = input;
  const keyid = typeof params.keyid === 'string' ? params.keyid : undefined;
  const agent = unquoteSf(h['signature-agent']);
  const fail = (reason) => ({ valid: false, keyid, agent, reason });

  if (!components.includes('@authority')) return fail('signature does not cover @authority');
  if (h['signature-agent'] !== undefined && !components.includes('signature-agent')) {
    return fail('signature does not cover signature-agent');
  }
  if (params.alg !== undefined && String(params.alg).toLowerCase() !== 'ed25519') return fail(`unsupported alg ${params.alg}`);
  const nowSec = Math.floor(now / 1000);
  if (typeof params.created !== 'number') return fail('missing created');
  if (params.created > nowSec + CLOCK_SKEW_SEC) return fail('created is in the future');
  if (typeof params.expires === 'number' && nowSec > params.expires) return fail('signature expired');
  if (!keyid) return fail('missing keyid');

  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find((k) => {
    if (k.kid) return k.kid === keyid;
    try {
      return jwkThumbprint(k) === keyid;
    } catch {
      return false;
    }
  });
  if (!jwk) return fail('unknown keyid');

  const signature = sigs[label];
  if (!signature) return fail(`no Signature value for label ${label}`);
  let base;
  try {
    base = signatureBaseFor(components, paramsString, { method, url, headers: h });
  } catch (err) {
    return fail(err.message);
  }
  let ok = false;
  try {
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: jwk.crv, x: jwk.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(base), publicKey, signature);
  } catch (err) {
    return fail(`verification error: ${err.message}`);
  }
  return ok ? { valid: true, keyid, agent, label } : fail('signature mismatch');
}

export class Signer {
  constructor({ keyDir = null, config } = {}) {
    this.keyDir = keyDir;
    this.config = config || {};
    this.privateKey = null;
    this.publicKey = null;
    this._jwk = null;
    this._kid = null;
  }

  async init() {
    this.ensureKeys();
    return this;
  }

  // Loads the persisted key pair or generates (and persists) a new one.
  ensureKeys() {
    if (this.privateKey) return;
    let privateKey = null;
    const privFile = this.keyDir ? path.join(this.keyDir, PRIVATE_FILE) : null;
    const pubFile = this.keyDir ? path.join(this.keyDir, PUBLIC_FILE) : null;
    if (privFile && fs.existsSync(privFile)) {
      privateKey = crypto.createPrivateKey(fs.readFileSync(privFile, 'utf8'));
      if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`${privFile} is not an Ed25519 key`);
    }
    if (!privateKey) {
      privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
      if (privFile) {
        fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
        fs.chmodSync(privFile, 0o600);
      }
    }
    this.privateKey = privateKey;
    this.publicKey = crypto.createPublicKey(privateKey);
    if (pubFile && !fs.existsSync(pubFile)) {
      fs.writeFileSync(pubFile, this.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
    }
    const { kty, crv, x } = this.publicKey.export({ format: 'jwk' });
    this._jwk = { kty, crv, x };
    this._kid = jwkThumbprint(this._jwk);
  }

  get keyId() {
    this.ensureKeys();
    return this._kid;
  }

  jwk() {
    this.ensureKeys();
    return { ...this._jwk };
  }

  jwks() {
    return { keys: [{ ...this.jwk(), kid: this.keyId, use: 'sig', alg: 'EdDSA' }] };
  }

  get enabled() {
    return this.config?.signing?.enabled !== false;
  }

  signRequest({ method = 'GET', url, now = Date.now() } = {}) {
    // `method` is accepted for API symmetry; Web Bot Auth covers only
    // @authority and signature-agent, so it is not part of the signature.
    if (!this.enabled) return {};
    this.ensureKeys();
    const authority = new URL(url).host.toLowerCase();
    const signatureAgent = sfString(this.config.publicBaseUrl);
    const created = Math.floor(now / 1000);
    const nonce = crypto.randomBytes(32).toString('base64');
    const paramsString =
      `("@authority" "signature-agent");created=${created};expires=${created + VALIDITY_SEC}` +
      `;keyid=${sfString(this.keyId)};alg="ed25519";nonce=${sfString(nonce)};tag="${TAG}"`;
    const base = buildSignatureBase({ authority, signatureAgent, paramsString });
    const signature = crypto.sign(null, Buffer.from(base), this.privateKey).toString('base64');
    return {
      'Signature-Agent': signatureAgent,
      'Signature-Input': `${LABEL}=${paramsString}`,
      Signature: `${LABEL}=:${signature}:`,
    };
  }
}
