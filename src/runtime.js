// Wires every component together. This file is the concrete contract for
// constructor signatures — see SPEC.md for each module's interface.
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from './config.js';
import { AuditLog } from './util/audit.js';
import { Signer } from './net/signing.js';
import { HostScheduler } from './net/ratelimit.js';
import { Fetcher } from './net/fetcher.js';
import { SearchIndex } from './index/store.js';
import { JobManager } from './crawl/jobs.js';

export async function createRuntime(overrides = {}) {
  const config = loadConfig(overrides);
  fs.mkdirSync(config.dataDir, { recursive: true });
  const audit = new AuditLog({ file: path.join(config.dataDir, 'audit.ndjson') });
  const signer = new Signer({ keyDir: path.join(config.dataDir, 'keys'), config });
  await signer.init();
  const scheduler = new HostScheduler(config.politeness);
  const fetcher = new Fetcher({ config, scheduler, signer, audit });
  const index = new SearchIndex({ file: path.join(config.dataDir, 'index.json') });
  await index.load();
  const jobs = new JobManager({ config, fetcher, index, audit });
  const startedAt = Date.now();

  return {
    config,
    audit,
    signer,
    scheduler,
    fetcher,
    robots: fetcher.robots,
    index,
    jobs,
    startedAt,
    async close() {
      jobs.cancelAll();
      await index.save();
      await audit.close();
    },
  };
}
