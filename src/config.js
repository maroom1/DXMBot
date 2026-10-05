// Central configuration. Every component receives the same mutable `config`
// object and must read values at use time (e.g. config.publicBaseUrl is
// rewritten by the server after it binds to an ephemeral port).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function defaultConfig() {
  const port = Number(process.env.CAIRN_PORT || 8787);
  return {
    host: process.env.CAIRN_HOST || '127.0.0.1',
    port,
    publicBaseUrl: process.env.CAIRN_PUBLIC_URL || `http://127.0.0.1:${port}`,
    publicBaseUrlExplicit: Boolean(process.env.CAIRN_PUBLIC_URL),
    contact: process.env.CAIRN_CONTACT || 'cairn-operator@localhost',
    dataDir: process.env.CAIRN_HOME || path.join(PROJECT_ROOT, 'data'),
    identity: {
      // Published egress ranges (served at /bot/*.json). Local installs egress from loopback.
      ipv4Prefixes: ['127.0.0.1/32'],
      ipv6Prefixes: ['::1/128'],
    },
    fetch: {
      timeoutMs: 15000,
      maxBytes: 5 * 1024 * 1024,
      maxRedirects: 5,
      retries: 2,
      blockPrivateNetworks: false,
    },
    politeness: {
      minDelayMs: 1000,
      maxConcurrencyPerHost: 1,
      globalConcurrency: 8,
      backoffBaseMs: 2000,
      maxBackoffMs: 60000,
    },
    robots: {
      cacheTtlMs: 24 * 60 * 60 * 1000,
      respectForUserFetch: true,
    },
    crawl: {
      maxPages: 50,
      maxDepth: 2,
      sameSiteOnly: true,
      useSitemaps: true,
      concurrency: 4,
    },
    agent: {
      claudeBin: process.env.CAIRN_CLAUDE_BIN || 'claude',
      model: process.env.CAIRN_MODEL || 'sonnet',
      timeoutMs: 240000,
      maxBudgetUsd: 1.5,
      maxPassages: 8,
    },
    signing: {
      enabled: true,
    },
  };
}

// Keys a user may change at runtime via POST /api/config (persisted to <dataDir>/config.json).
export const EDITABLE_KEYS = ['politeness', 'robots', 'crawl', 'agent', 'signing', 'fetch', 'contact'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Keys that would reach Object.prototype (JSON.parse creates an own "__proto__").
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source || {})) {
    if (v === undefined || UNSAFE_KEYS.has(k)) continue;
    if (isPlainObject(v) && Object.hasOwn(target, k) && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

export function loadConfig(overrides = {}) {
  const config = defaultConfig();
  if (overrides.dataDir) config.dataDir = overrides.dataDir;
  const file = path.join(config.dataDir, 'config.json');
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const allowed = Object.fromEntries(Object.entries(saved).filter(([k]) => EDITABLE_KEYS.includes(k)));
      deepMerge(config, allowed);
    } catch {
      // A corrupt config file must never prevent startup.
    }
  }
  deepMerge(config, overrides);
  if (overrides.port !== undefined && !overrides.publicBaseUrl && !config.publicBaseUrlExplicit) {
    config.publicBaseUrl = `http://127.0.0.1:${overrides.port}`;
  }
  if (overrides.publicBaseUrl) config.publicBaseUrlExplicit = true;
  return config;
}

export function saveConfig(config, partial = {}) {
  const allowed = Object.fromEntries(Object.entries(partial).filter(([k]) => EDITABLE_KEYS.includes(k)));
  deepMerge(config, allowed);
  const file = path.join(config.dataDir, 'config.json');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const snapshot = Object.fromEntries(EDITABLE_KEYS.map((k) => [k, config[k]]));
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return config;
}
