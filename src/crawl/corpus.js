// Corpus collection output for the `corpus` role (CairnCorpus, like GPTBot):
// one JSONL file per crawl job at <dataDir>/corpus/<jobId>.jsonl. The corpus
// is deliberately separate from the search index — opting out of one never
// affects the other.
import fs from 'node:fs';
import path from 'node:path';

export function corpusDir(dataDir) {
  return path.join(dataDir, 'corpus');
}

// Job ids become file names, so restrict them to a safe character set.
function safeName(jobId) {
  const name = String(jobId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_');
  if (!name) throw new Error('Corpus writer needs a job id');
  return name;
}

export function corpusFile(dataDir, jobId) {
  return path.join(corpusDir(dataDir), `${safeName(jobId)}.jsonl`);
}

export class CorpusWriter {
  #chain = Promise.resolve();
  #dirReady = false;

  constructor({ dataDir, jobId }) {
    if (!dataDir) throw new Error('Corpus writer needs a dataDir');
    this.jobId = jobId;
    this.file = corpusFile(dataDir, jobId);
    this.count = 0;
  }

  // Appends are serialized so lines are written in call order; the file (and
  // corpus directory) is created lazily on the first record.
  append({ url, title = null, text = '', fetchedAt = new Date().toISOString(), contentHash = null }) {
    const line = JSON.stringify({ url, title, text, fetchedAt, contentHash }) + '\n';
    const write = this.#chain.then(async () => {
      if (!this.#dirReady) {
        await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
        this.#dirReady = true;
      }
      await fs.promises.appendFile(this.file, line, 'utf8');
      this.count++;
    });
    // A failed write must not wedge every later append.
    this.#chain = write.catch(() => {});
    return write;
  }

  // Resolves once every append issued so far has settled.
  flush() {
    return this.#chain;
  }
}

export async function readCorpus(file) {
  let raw;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a partially written trailing line.
    }
  }
  return records;
}

export function listCorpora(dataDir) {
  const dir = corpusDir(dataDir);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      return { jobId: n.slice(0, -'.jsonl'.length), file, bytes: st.size, modifiedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
}
