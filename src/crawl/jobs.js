// Registry of crawl jobs. Jobs start as soon as they are created and the
// newest MAX_JOBS are retained (running jobs are never evicted).
import { CrawlJob, TERMINAL_STATES, newJobId } from './crawler.js';

const MAX_JOBS = 50;

export class JobManager {
  #deps;
  #jobs = new Map(); // id → CrawlJob, insertion order = creation order

  constructor({ config, fetcher, index = null, audit = null } = {}) {
    this.#deps = { config, fetcher, index, audit };
  }

  create(opts = {}) {
    let id = opts.id ? String(opts.id) : newJobId();
    if (this.#jobs.has(id)) throw new Error(`Crawl job "${id}" already exists`);
    const job = new CrawlJob({ ...opts, id }, this.#deps);
    id = job.id;
    this.#jobs.set(id, job);
    this.#prune();
    job.run().catch(() => {}); // run() records failures in the job status
    return job;
  }

  // Newest first.
  list() {
    return [...this.#jobs.values()].reverse().map((job) => job.status());
  }

  get(id) {
    return this.#jobs.get(String(id)) ?? null;
  }

  cancel(id) {
    const job = this.get(id);
    return job ? job.cancel() : null;
  }

  cancelAll() {
    for (const job of this.#jobs.values()) job.cancel();
  }

  // Resolves with the job's final status, or its current status on timeout.
  async waitFor(id, timeoutMs = 60000) {
    const job = this.get(id);
    if (!job) throw new Error(`Unknown crawl job "${id}"`);
    if (TERMINAL_STATES.has(job.state)) return job.status();
    return new Promise((resolve) => {
      let timer = null;
      const onDone = (status) => {
        if (timer) clearTimeout(timer);
        resolve(status);
      };
      job.once('done', onDone);
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        timer = setTimeout(() => {
          job.off('done', onDone);
          resolve(job.status());
        }, timeoutMs);
      }
    });
  }

  #prune() {
    if (this.#jobs.size <= MAX_JOBS) return;
    for (const [id, job] of this.#jobs) {
      if (this.#jobs.size <= MAX_JOBS) break;
      if (TERMINAL_STATES.has(job.state)) this.#jobs.delete(id);
    }
  }
}
