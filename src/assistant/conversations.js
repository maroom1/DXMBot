// Conversation persistence for the Cairn desktop assistant.
// One JSON file per conversation in <dir>/<id>.json, written atomically
// (tmp file + rename). A conversation also remembers the Claude CLI session id
// so follow-up messages continue the same Claude session via --resume.
//
// conv = {id, title, createdAt, updatedAt, sessionId|null, allowAlways:[toolName],
//         messages:[{id, role:'user'|'assistant'|'system', text, ts, events?, costUsd?, ...}]}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ROLES = new Set(['user', 'assistant', 'system']);
const MAX_TITLE = 60;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

// First `max` chars of text on one line (used for conversation and run titles).
export function makeTitle(text, max = MAX_TITLE) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!one) return 'New conversation';
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one;
}

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export class ConversationStore {
  constructor({ dir } = {}) {
    if (!dir) throw new Error('ConversationStore requires {dir}');
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map(); // id -> conv (live object; callers get clones)
    this.loadedAll = false;
  }

  fileFor(id) {
    return path.join(this.dir, `${id}.json`);
  }

  _load(id) {
    if (!isValidId(id)) return null;
    if (this.cache.has(id)) return this.cache.get(id);
    const file = this.fileFor(id);
    if (!fs.existsSync(file)) return null;
    try {
      const conv = normalizeConv(JSON.parse(fs.readFileSync(file, 'utf8')), id);
      this.cache.set(id, conv);
      return conv;
    } catch {
      return null; // corrupt file: treat as missing rather than crash the server
    }
  }

  _loadAll() {
    if (this.loadedAll) return;
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      this._load(name.slice(0, -5));
    }
    this.loadedAll = true;
  }

  _save(conv) {
    writeJsonAtomic(this.fileFor(conv.id), conv);
  }

  create({ title } = {}) {
    const now = new Date().toISOString();
    const conv = {
      id: newId('c'),
      title: makeTitle(title),
      createdAt: now,
      updatedAt: now,
      sessionId: null,
      allowAlways: [],
      messages: [],
    };
    this.cache.set(conv.id, conv);
    this._save(conv);
    return clone(conv);
  }

  get(id) {
    return clone(this._load(id));
  }

  has(id) {
    return Boolean(this._load(id));
  }

  // Newest (most recently updated) first.
  list() {
    this._loadAll();
    return [...this.cache.values()]
      .map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: c.messages.length }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  // Appends a message; assigns id + ts. Returns the stored message, or null if the conversation is gone.
  append(id, msg = {}) {
    const conv = this._load(id);
    if (!conv) return null;
    const m = {
      ...clone(msg),
      id: msg.id || newId('m'),
      role: ROLES.has(msg.role) ? msg.role : 'user',
      text: String(msg.text ?? ''),
      ts: msg.ts || new Date().toISOString(),
    };
    conv.messages.push(m);
    conv.updatedAt = m.ts > conv.updatedAt ? m.ts : new Date().toISOString();
    this._save(conv);
    return clone(m);
  }

  setSession(id, sessionId) {
    const conv = this._load(id);
    if (!conv) return false;
    conv.sessionId = sessionId || null;
    conv.updatedAt = new Date().toISOString();
    this._save(conv);
    return true;
  }

  setTitle(id, title) {
    const conv = this._load(id);
    if (!conv) return false;
    conv.title = makeTitle(title);
    conv.updatedAt = new Date().toISOString();
    this._save(conv);
    return true;
  }

  // "Always allow" a tool for this conversation (added to --allowedTools on later runs).
  addAllowAlways(id, toolName) {
    const conv = this._load(id);
    if (!conv || !toolName) return false;
    const name = String(toolName);
    if (!conv.allowAlways.includes(name)) {
      conv.allowAlways.push(name);
      conv.updatedAt = new Date().toISOString();
      this._save(conv);
    }
    return true;
  }

  removeAllowAlways(id, toolName) {
    const conv = this._load(id);
    if (!conv) return false;
    const before = conv.allowAlways.length;
    conv.allowAlways = conv.allowAlways.filter((t) => t !== toolName);
    if (conv.allowAlways.length !== before) this._save(conv);
    return true;
  }

  remove(id) {
    if (!isValidId(id)) return false;
    const existed = this.cache.has(id) || fs.existsSync(this.fileFor(id));
    this.cache.delete(id);
    try {
      fs.rmSync(this.fileFor(id), { force: true });
    } catch {
      // ignore
    }
    return existed;
  }
}

function normalizeConv(raw, id) {
  const now = new Date().toISOString();
  return {
    id: raw?.id && isValidId(raw.id) ? raw.id : id,
    title: typeof raw?.title === 'string' ? raw.title : 'New conversation',
    createdAt: raw?.createdAt || now,
    updatedAt: raw?.updatedAt || raw?.createdAt || now,
    sessionId: raw?.sessionId || null,
    allowAlways: Array.isArray(raw?.allowAlways) ? raw.allowAlways.map(String) : [],
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    ...Object.fromEntries(Object.entries(raw || {}).filter(([k]) => !['id', 'title', 'createdAt', 'updatedAt', 'sessionId', 'allowAlways', 'messages'].includes(k))),
  };
}
