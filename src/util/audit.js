// Append-only audit trail of every network action Cairn takes. Kept in memory
// (ring buffer) for the dashboard and appended to <dataDir>/audit.ndjson.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export class AuditLog extends EventEmitter {
  constructor({ file = null, maxMemory = 2000 } = {}) {
    super();
    this.setMaxListeners(100);
    this.file = file;
    this.maxMemory = maxMemory;
    this.seq = 0;
    this.entries = [];
    this.counters = { total: 0, byKind: {}, byRole: {}, byStatus: {}, blocked: 0, errors: 0 };
    this.stream = null;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    }
  }

  // entry: { kind: 'fetch'|'robots'|'crawl'|'agent'|'system', ...fields }
  record(entry) {
    const e = { id: ++this.seq, ts: new Date().toISOString(), kind: 'system', ...entry };
    this.entries.push(e);
    if (this.entries.length > this.maxMemory) this.entries.splice(0, this.entries.length - this.maxMemory);
    const c = this.counters;
    c.total++;
    c.byKind[e.kind] = (c.byKind[e.kind] || 0) + 1;
    if (e.role) c.byRole[e.role] = (c.byRole[e.role] || 0) + 1;
    if (e.status !== undefined && e.status !== null) c.byStatus[e.status] = (c.byStatus[e.status] || 0) + 1;
    if (e.blocked) c.blocked++;
    if (e.error) c.errors++;
    if (this.stream) this.stream.write(JSON.stringify(e) + '\n');
    this.emit('entry', e);
    return e;
  }

  // Newest first.
  recent({ limit = 100, role, host, kind, sinceId } = {}) {
    const out = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (sinceId !== undefined && e.id <= sinceId) break;
      if (role && e.role !== role) continue;
      if (kind && e.kind !== kind) continue;
      if (host) {
        try {
          if (!e.url || new URL(e.url).host !== host) continue;
        } catch {
          continue;
        }
      }
      out.push(e);
    }
    return out;
  }

  stats() {
    return JSON.parse(JSON.stringify(this.counters));
  }

  subscribe(fn) {
    this.on('entry', fn);
    return () => this.off('entry', fn);
  }

  close() {
    return new Promise((resolve) => {
      if (!this.stream) return resolve();
      const s = this.stream;
      this.stream = null;
      s.end(resolve);
    });
  }
}
