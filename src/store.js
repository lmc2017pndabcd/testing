import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  DATA_DIR,
  ensureDir,
  listFiles,
  readJson,
  removeDir,
  safeFileName,
  uid,
  writeJson,
  nowIso,
} from './util.js';

const RUNS_DIR = path.join(DATA_DIR, 'runs');
const DATASETS_DIR = path.join(DATA_DIR, 'datasets');

export class Store {
  constructor() {
    this.runsDir = RUNS_DIR;
    this.datasetsDir = DATASETS_DIR;
  }

  async init() {
    await ensureDir(this.runsDir);
    await ensureDir(this.datasetsDir);
  }

  /* ------------------------------------------------------------------ runs */

  runFile(id) {
    return path.join(this.runsDir, `${id}.json`);
  }

  runLogFile(id) {
    return path.join(this.runsDir, `${id}.log`);
  }

  getRun(id) {
    return readJson(this.runFile(id), null);
  }

  async saveRun(run) {
    await writeJson(this.runFile(run.id), run);
    return run;
  }

  async listRuns() {
    const files = await listFiles(this.runsDir, (f) => f.endsWith('.json') && !f.endsWith('.tmp'));
    const runs = [];
    for (const f of files) {
      const run = await readJson(path.join(this.runsDir, f), null);
      if (run?.id) runs.push(run);
    }
    runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return runs;
  }

  async deleteRun(id) {
    await fsp.rm(this.runFile(id), { force: true });
    await fsp.rm(this.runLogFile(id), { force: true });
    await removeDir(path.join(this.runsDir, `${id}.artifacts`));
  }

  async workDir(id) {
    const dir = path.join(this.runsDir, `${id}.artifacts`);
    await ensureDir(dir);
    return dir;
  }

  /* -------------------------------------------------------------- datasets */

  datasetDir(id) {
    return path.join(this.datasetsDir, id);
  }

  datasetFile(id, name) {
    return path.join(this.datasetDir(id), safeFileName(name, 'data.bin'));
  }

  getDataset(id) {
    return readJson(path.join(this.datasetDir(id), 'meta.json'), null);
  }

  async saveDataset(meta) {
    await ensureDir(this.datasetDir(meta.id));
    await writeJson(path.join(this.datasetDir(meta.id), 'meta.json'), meta);
    return meta;
  }

  async listDatasets() {
    const dirs = await listFiles(this.datasetsDir);
    const out = [];
    for (const d of dirs) {
      const meta = await readJson(path.join(this.datasetsDir, d, 'meta.json'), null);
      if (meta?.id) out.push(meta);
    }
    out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return out;
  }

  async deleteDataset(id) {
    await removeDir(this.datasetDir(id));
  }

  async writeDatasetPayload(id, fileName, content) {
    await ensureDir(this.datasetDir(id));
    const target = this.datasetFile(id, fileName);
    await fsp.writeFile(target, content, 'utf8');
    const stat = await fsp.stat(target);
    return { path: target, size: stat.size };
  }

  async readDatasetPayload(id, fileName) {
    try {
      return await fsp.readFile(this.datasetFile(id, fileName), 'utf8');
    } catch {
      return null;
    }
  }

  makeId(prefix) {
    return uid(prefix);
  }

  static now() {
    return nowIso();
  }
}

export const store = new Store();
