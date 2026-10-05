// Shopping list for the Cairn assistant, persisted to <dataDir>/shopping.json.
// Claude adds items while researching ("shopping_list_add" MCP tool) and the
// bubble UI shows them with links and prices. Cairn never pays for anything:
// this list is where checkout is handed back to the user.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_ITEMS = 500;
const LIMITS = { item: 300, url: 2000, price: 60, store: 120, notes: 2000, currency: 8 };

export class ShoppingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Write JSON via tmp file + rename so a crash never leaves a half-written file.
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function optionalText(value, name, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number') throw new ShoppingError(`${name} must be a string`);
  const s = String(value).trim();
  if (s.length > max) throw new ShoppingError(`${name} is too long (max ${max} characters)`);
  return s;
}

// Only absolute http(s) links are stored (the UI renders them as clickable links).
export function cleanUrl(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ShoppingError('url must be a string');
  const s = value.trim();
  if (s.length > LIMITS.url) throw new ShoppingError(`url is too long (max ${LIMITS.url} characters)`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new ShoppingError('url must be an absolute http(s) URL');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) {
    throw new ShoppingError('url must be an absolute http(s) URL');
  }
  return u.href;
}

// Price may be a number (19.99) or display text ("$19.99", "£12 / month").
function cleanPrice(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new ShoppingError('price must be a non-negative number or text');
    return value;
  }
  return optionalText(value, 'price', LIMITS.price) || null;
}

function cleanQuantity(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new ShoppingError('quantity must be a whole number between 1 and 9999');
  return n;
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.item !== 'string') return null;
  return {
    id: raw.id,
    item: raw.item,
    url: typeof raw.url === 'string' ? raw.url : '',
    price: typeof raw.price === 'number' || typeof raw.price === 'string' ? raw.price : null,
    store: typeof raw.store === 'string' ? raw.store : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    quantity: Number.isInteger(raw.quantity) && raw.quantity > 0 ? raw.quantity : 1,
    done: raw.done === true,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.addedAt || new Date().toISOString(),
    ...(typeof raw.conversationId === 'string' ? { conversationId: raw.conversationId } : {}),
  };
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export class ShoppingList {
  constructor({ file } = {}) {
    if (!file) throw new Error('ShoppingList requires {file}');
    this.file = file;
    const saved = readJsonFile(file, null);
    const list = Array.isArray(saved) ? saved : Array.isArray(saved?.items) ? saved.items : [];
    this.items = list.map(normalizeStored).filter(Boolean);
  }

  _save() {
    writeJsonAtomic(this.file, { version: 1, items: this.items });
  }

  // In the order they were added (a shopping list reads top to bottom).
  list({ includeDone = true } = {}) {
    return clone(includeDone ? this.items : this.items.filter((i) => !i.done));
  }

  get(id) {
    return clone(this.items.find((i) => i.id === id) || null);
  }

  add(input = {}) {
    if (!input || typeof input !== 'object') throw new ShoppingError('Shopping item must be an object');
    const name = optionalText(input.item ?? input.name ?? input.title, 'item', LIMITS.item);
    if (!name) throw new ShoppingError('item is required');
    if (this.items.length >= MAX_ITEMS) throw new ShoppingError(`The shopping list is full (max ${MAX_ITEMS} items)`, 409);
    const now = new Date().toISOString();
    const entry = {
      id: `s-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
      item: name,
      url: cleanUrl(input.url),
      price: cleanPrice(input.price),
      store: optionalText(input.store, 'store', LIMITS.store),
      notes: optionalText(input.notes, 'notes', LIMITS.notes),
      quantity: cleanQuantity(input.quantity),
      done: false,
      addedAt: now,
      updatedAt: now,
    };
    if (typeof input.conversationId === 'string' && /^[\w-]{1,80}$/.test(input.conversationId)) entry.conversationId = input.conversationId;
    this.items.push(entry);
    this._save();
    return clone(entry);
  }

  // Partial update: item, url, price, store, notes, quantity, done.
  update(id, patch = {}) {
    const entry = this.items.find((i) => i.id === id);
    if (!entry) return null;
    if (!patch || typeof patch !== 'object') throw new ShoppingError('Patch must be an object');
    const next = { ...entry };
    if ('item' in patch) {
      next.item = optionalText(patch.item, 'item', LIMITS.item);
      if (!next.item) throw new ShoppingError('item cannot be empty');
    }
    if ('url' in patch) next.url = cleanUrl(patch.url);
    if ('price' in patch) next.price = cleanPrice(patch.price);
    if ('store' in patch) next.store = optionalText(patch.store, 'store', LIMITS.store);
    if ('notes' in patch) next.notes = optionalText(patch.notes, 'notes', LIMITS.notes);
    if ('quantity' in patch) next.quantity = cleanQuantity(patch.quantity);
    if ('done' in patch) {
      if (typeof patch.done !== 'boolean') throw new ShoppingError('done must be a boolean');
      next.done = patch.done;
    }
    next.updatedAt = new Date().toISOString();
    Object.assign(entry, next);
    this._save();
    return clone(entry);
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === id);
    if (i === -1) return false;
    this.items.splice(i, 1);
    this._save();
    return true;
  }

  // Remove every item (or only the ticked-off ones). Returns how many were removed.
  clear({ doneOnly = false } = {}) {
    const before = this.items.length;
    this.items = doneOnly ? this.items.filter((i) => !i.done) : [];
    if (this.items.length !== before) this._save();
    return before - this.items.length;
  }
}
