import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root (one level above src/). */
export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = process.env.TESTBENCH_DATA
  ? path.resolve(process.env.TESTBENCH_DATA)
  : path.join(ROOT, 'data');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Short, sortable, filesystem-safe id: prefix_20261004_153012_ab12 */
export function uid(prefix = 'id') {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${prefix}_${stamp}_${crypto.randomBytes(2).toString('hex')}`;
}

export const nowIso = () => new Date().toISOString();

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Write JSON through a temp file so a crash can never leave a half-written record. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return value;
}

export async function listFiles(dir, predicate = () => true) {
  try {
    const names = await fsp.readdir(dir);
    return names.filter(predicate);
  } catch {
    return [];
  }
}

export async function removeDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

export const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[idx];
}

/** Run a command, resolving (never rejecting) with status/stdout/stderr. */
export function execCapture(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      let child;
      try {
        child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        resolve({ ok: false, code: -1, stdout: '', stderr: String(err?.message || err) });
        return;
      }
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, opts.timeoutMs ?? 8000);
      child.stdout?.on('data', (d) => {
        out += d;
      });
      child.stderr?.on('data', (d) => {
        err += d;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, code: -1, stdout: out, stderr: String(e?.message || e) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout: out, stderr: err });
      });
    });
  });
}

/**
 * Resolve a CLI binary.
 *
 * Project-local locations win over the global PATH so that a toolchain
 * installed by `install.sh` (a `.venv` or a locally extracted JMeter) is picked
 * up even when the server itself was started from a plain shell.
 */
export async function which(bin) {
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
  const candidates = [];
  if (process.env.TESTBENCH_BIN_DIR) {
    candidates.push(path.join(process.env.TESTBENCH_BIN_DIR, exe));
  }
  for (const dir of ['.venv', 'venv', 'env']) {
    candidates.push(path.join(ROOT, dir, 'bin', exe));
    candidates.push(path.join(ROOT, dir, 'Scripts', exe));
  }
  candidates.push(path.join(ROOT, 'tools', 'jmeter', 'bin', exe));
  candidates.push(path.join(ROOT, 'tools', 'apache-jmeter', 'bin', exe));

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }

  const r = await execCapture('which', [bin], { timeoutMs: 4000 });
  const found = r.ok && r.stdout.trim();
  return found || null;
}

/**
 * Minimal RFC4180-ish CSV parser (handles quotes, embedded commas/newlines).
 * Returns every row, including the first one, as arrays of raw cells.
 */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = String(text ?? '').replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      // ignore
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Split a CSV payload into a header row and the remaining rows. */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].map((h) => h.trim());
  const body = rows.slice(1).filter((r) => r.length > 1 || (r[0] ?? '') !== '');
  return { columns, rows: body };
}

export function csvToObjects(text) {
  const { columns, rows } = parseCsv(text);
  return { columns, rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) };
}

export function toNumber(v, fallback = 0) {
  const n = Number(String(v ?? '').replace(/[%,\s]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export function safeFileName(name, fallback = 'file') {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

export function truncate(text, max = 200) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
