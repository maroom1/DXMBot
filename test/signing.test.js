import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Signer,
  verifyRequest,
  jwkThumbprint,
  parseSignatureInput,
  buildSignatureBase,
} from '../src/net/signing.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cairn-signing-'));
}

function makeSigner(overrides = {}) {
  const config = { publicBaseUrl: 'http://127.0.0.1:8787', signing: { enabled: true }, ...overrides };
  return new Signer({ keyDir: path.join(tmpDir(), 'keys'), config });
}

const lower = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

test('jwkThumbprint matches RFC 8037 Appendix A.3', () => {
  const jwk = { crv: 'Ed25519', kty: 'OKP', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
  assert.equal(jwkThumbprint(jwk), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  // Member order and extra members must not matter.
  assert.equal(jwkThumbprint({ x: jwk.x, kty: 'OKP', crv: 'Ed25519', kid: 'ignored', use: 'sig' }), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
});

test('signRequest produces Web Bot Auth headers that verify', async () => {
  const signer = await makeSigner().init();
  const url = 'https://Example.COM:8443/some/path?q=1';
  const headers = signer.signRequest({ url });
  assert.equal(headers['Signature-Agent'], '"http://127.0.0.1:8787"');
  assert.match(
    headers['Signature-Input'],
    /^sig1=\("@authority" "signature-agent"\);created=\d+;expires=\d+;keyid="[A-Za-z0-9_-]{43}";alg="ed25519";nonce="[A-Za-z0-9+/=]+";tag="web-bot-auth"$/,
  );
  assert.match(headers.Signature, /^sig1=:[A-Za-z0-9+/]+=*:$/);

  const [input] = parseSignatureInput(headers['Signature-Input']);
  assert.equal(input.label, 'sig1');
  assert.deepEqual(input.components, ['@authority', 'signature-agent']);
  assert.equal(input.params.expires - input.params.created, 300);
  assert.equal(input.params.keyid, signer.keyId);
  assert.equal(input.params.tag, 'web-bot-auth');

  const res = verifyRequest({ method: 'GET', url, headers: lower(headers) }, signer.jwks());
  assert.equal(res.valid, true, res.reason);
  assert.equal(res.keyid, signer.keyId);
  assert.equal(res.agent, 'http://127.0.0.1:8787');
});

test('buildSignatureBase follows RFC 9421 §2.5 layout', () => {
  const base = buildSignatureBase({
    authority: 'Example.com:8080',
    signatureAgent: '"http://agent.test"',
    paramsString: '("@authority" "signature-agent");created=1;keyid="k"',
  });
  assert.equal(
    base,
    '"@authority": example.com:8080\n"signature-agent": "http://agent.test"\n"@signature-params": ("@authority" "signature-agent");created=1;keyid="k"',
  );
  // A bare URL is quoted as an sf-string.
  assert.equal(
    buildSignatureBase({ authority: 'a', signatureAgent: 'http://agent.test', paramsString: '()' }).split('\n')[1],
    '"signature-agent": "http://agent.test"',
  );
});

test('the signature covers @authority and signature-agent', async () => {
  const signer = await makeSigner().init();
  const url = 'https://site.test/page';
  const headers = lower(signer.signRequest({ url }));
  const jwks = signer.jwks();

  const wrongHost = verifyRequest({ url: 'https://other.test/page', headers }, jwks);
  assert.equal(wrongHost.valid, false);
  assert.match(wrongHost.reason, /mismatch/);

  const wrongAgent = verifyRequest({ url, headers: { ...headers, 'signature-agent': '"https://evil.test"' } }, jwks);
  assert.equal(wrongAgent.valid, false);

  // Path is not covered by Web Bot Auth, so a different path on the same authority verifies.
  assert.equal(verifyRequest({ url: 'https://site.test/elsewhere', headers }, jwks).valid, true);
});

test('expired, future, unknown keyid, wrong tag and missing headers fail', async () => {
  const signer = await makeSigner().init();
  const url = 'https://site.test/';
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const headers = lower(signer.signRequest({ url, now: t0 }));
  const jwks = signer.jwks();

  assert.equal(verifyRequest({ url, headers }, jwks, { now: t0 + 60_000 }).valid, true);
  const expired = verifyRequest({ url, headers }, jwks, { now: t0 + 301_000 });
  assert.equal(expired.valid, false);
  assert.match(expired.reason, /expired/);
  const future = verifyRequest({ url, headers }, jwks, { now: t0 - 3600_000 });
  assert.equal(future.valid, false);
  assert.match(future.reason, /future/);

  const other = await makeSigner().init();
  const unknown = verifyRequest({ url, headers }, other.jwks(), { now: t0 });
  assert.equal(unknown.valid, false);
  assert.match(unknown.reason, /unknown keyid/);

  const retagged = { ...headers, 'signature-input': headers['signature-input'].replace('web-bot-auth', 'other') };
  assert.equal(verifyRequest({ url, headers: retagged }, jwks, { now: t0 }).valid, false);

  const missing = verifyRequest({ url, headers: {} }, jwks);
  assert.equal(missing.valid, false);
  assert.match(missing.reason, /missing/i);

  const garbage = verifyRequest({ url, headers: { ...headers, 'signature-input': 'sig1=(((' } }, jwks, { now: t0 });
  assert.equal(garbage.valid, false);
});

test('a tampered signature fails', async () => {
  const signer = await makeSigner().init();
  const url = 'https://site.test/';
  const headers = lower(signer.signRequest({ url }));
  const bytes = Buffer.from(headers.signature.slice(5, -1), 'base64');
  bytes[0] ^= 0xff;
  const bad = { ...headers, signature: `sig1=:${bytes.toString('base64')}:` };
  assert.equal(verifyRequest({ url, headers: bad }, signer.jwks()).valid, false);
});

test('signing disabled returns no headers', async () => {
  const signer = await makeSigner({ signing: { enabled: false } }).init();
  assert.deepEqual(signer.signRequest({ url: 'https://site.test/' }), {});
});

test('signing reads config at use time (publicBaseUrl and enabled)', async () => {
  const config = { publicBaseUrl: 'http://127.0.0.1:8787', signing: { enabled: true } };
  const signer = await new Signer({ keyDir: null, config }).init();
  config.publicBaseUrl = 'http://127.0.0.1:9999';
  assert.equal(signer.signRequest({ url: 'https://site.test/' })['Signature-Agent'], '"http://127.0.0.1:9999"');
  config.signing.enabled = false;
  assert.deepEqual(signer.signRequest({ url: 'https://site.test/' }), {});
});

test('key pair is persisted with 0600 private key and reloaded', async () => {
  const keyDir = path.join(tmpDir(), 'keys');
  const config = { publicBaseUrl: 'http://127.0.0.1:8787', signing: { enabled: true } };
  const a = await new Signer({ keyDir, config }).init();
  const privFile = path.join(keyDir, 'ed25519-private.pem');
  const pubFile = path.join(keyDir, 'ed25519-public.pem');
  assert.ok(fs.existsSync(privFile));
  assert.ok(fs.existsSync(pubFile));
  assert.equal(fs.statSync(privFile).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(privFile, 'utf8'), /BEGIN PRIVATE KEY/);
  assert.match(fs.readFileSync(pubFile, 'utf8'), /BEGIN PUBLIC KEY/);

  const b = await new Signer({ keyDir, config }).init();
  assert.equal(b.keyId, a.keyId);
  assert.deepEqual(b.jwk(), a.jwk());

  // Headers signed by one instance verify with the other's JWKS.
  const url = 'http://127.0.0.1:1234/x';
  assert.equal(verifyRequest({ url, headers: lower(a.signRequest({ url })) }, b.jwks()).valid, true);
});

test('jwks exposes the public key with kid = thumbprint', async () => {
  const signer = await makeSigner().init();
  const { keys } = signer.jwks();
  assert.equal(keys.length, 1);
  const [k] = keys;
  assert.equal(k.kty, 'OKP');
  assert.equal(k.crv, 'Ed25519');
  assert.equal(k.use, 'sig');
  assert.equal(k.alg, 'EdDSA');
  assert.equal(k.kid, jwkThumbprint(k));
  assert.equal(k.d, undefined, 'private component never exposed');
  assert.equal(signer.jwk().d, undefined);
});

test('verifyRequest accepts JWKS keys without kid via thumbprint', async () => {
  const signer = await makeSigner().init();
  const url = 'https://site.test/';
  const headers = lower(signer.signRequest({ url }));
  assert.equal(verifyRequest({ url, headers }, { keys: [signer.jwk()] }).valid, true);
});
