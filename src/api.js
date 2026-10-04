import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { events } from './events.js';
import { detectAll, engineSummaries, getEngine, invalidateDetection } from './engines/index.js';
import { runner } from './runner.js';
import { store } from './store.js';
import { DATA_DIR, csvToObjects, nowIso, safeFileName, truncate, uid, ROOT } from './util.js';

const MAX_BODY = Number(process.env.TESTBENCH_MAX_UPLOAD || 64 * 1024 * 1024);

/* ------------------------------------------------------------------ helpers */

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const ok = (res, payload = {}) => json(res, 200, { ok: true, ...payload });
const bad = (res, message, code = 400) => json(res, code, { ok: false, error: message });

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error(`请求体超过限制（${Math.round(limit / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error(`请求体不是合法 JSON：${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

/* --------------------------------------------------------- dataset analysis */

function detectType(filename, content) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.jsonl' || ext === '.ndjson') return 'jsonl';
  if (ext === '.json') return 'json';
  if (ext === '.csv') return 'csv';
  if (ext === '.tsv') return 'tsv';
  if (['.txt', '.md'].includes(ext)) return 'text';
  if (/^\s*[[{]/.test(content)) return 'json';
  if (/^\s*\S+,\S+/.test(content)) return 'csv';
  return 'text';
}

function analyzeContent(type, content) {
  const result = { records: 0, columns: [], preview: [], rows: [], labelField: null };
  const lines = content.split(/\r?\n/).filter((l) => l.trim());

  if (type === 'jsonl') {
    const items = [];
    for (const line of lines.slice(0, 2000)) {
      try {
        items.push(JSON.parse(line));
      } catch {
        /* skip invalid line */
      }
    }
    result.records = lines.length;
    result.preview = items.slice(0, 5);
    if (items[0] && typeof items[0] === 'object') result.columns = Object.keys(items[0]);
    return result;
  }

  if (type === 'json') {
    try {
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.data)
          ? parsed.data
          : Array.isArray(parsed?.samples)
            ? parsed.samples
            : [parsed];
      result.records = arr.length;
      result.preview = arr.slice(0, 5);
      if (arr[0] && typeof arr[0] === 'object') result.columns = Object.keys(arr[0]);
    } catch (err) {
      result.records = 0;
      result.error = `JSON 解析失败：${err.message}`;
    }
    return result;
  }

  if (type === 'csv' || type === 'tsv') {
    const text = type === 'tsv' ? content.replace(/\t/g, ',') : content;
    const { columns, rows } = csvToObjects(text);
    result.columns = columns;
    result.records = rows.length;
    result.preview = rows.slice(0, 5);
    result.rows = rows.slice(0, 5000).map((r) => {
      const lower = Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().trim(), v]));
      return {
        method: (lower.method || 'GET').toUpperCase(),
        path: lower.path || lower.url || lower.endpoint || lower.route || '/',
        weight: Number(lower.weight || 1) || 1,
      };
    });
    return result;
  }

  result.records = lines.length;
  result.preview = lines.slice(0, 5).map((l) => ({ line: truncate(l, 200) }));
  return result;
}

/* ---------------------------------------------------------------- run views */

function summarizeRun(run) {
  return {
    id: run.id,
    name: run.name,
    engine: run.engine,
    engineName: getEngine(run.engine)?.name ?? run.engine,
    status: run.status,
    mode: run.mode,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationSec: run.durationSec,
    progress: run.progress,
    phase: run.phase,
    datasetName: run.datasetName,
    tags: run.tags ?? [],
    kpi: run.kpi ?? null,
    error: run.error ?? null,
    target: run.config?.host || run.config?.model || '',
  };
}

function filterRuns(runs, { engine, status, q, datasetId, limit }) {
  let out = runs;
  if (engine) out = out.filter((r) => r.engine === engine);
  if (status) out = out.filter((r) => r.status === status);
  if (datasetId) out = out.filter((r) => r.datasetId === datasetId);
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((r) =>
      [r.name, r.id, r.config?.host, r.config?.model, r.datasetName]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle)));
  }
  const total = out.length;
  if (limit) out = out.slice(0, Number(limit));
  return { total, runs: out };
}

/* -------------------------------------------------------------------- routes */

export async function handleApi(req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = req.method ?? 'GET';
  const [head, id, sub] = seg;

  try {
    /* ---------------------------------------------------------- health/meta */
    if (head === 'health' && method === 'GET') {
      return ok(res, { time: nowIso(), active: runner.activeCount, queued: runner.queue.length });
    }

    if (head === 'engines' && method === 'GET') {
      const detection = await detectAll();
      return ok(res, { engines: engineSummaries(), detection });
    }

    if (head === 'engines' && method === 'POST' && seg[1] === 'detect') {
      invalidateDetection();
      const detection = await detectAll({ force: true });
      return ok(res, { detection });
    }

    if (head === 'stats' && method === 'GET') {
      const runs = await store.listRuns();
      const datasets = await store.listDatasets();
      const detection = await detectAll();
      const done = runs.filter((r) => ['succeeded', 'failed', 'canceled'].includes(r.status));
      const succeeded = runs.filter((r) => r.status === 'succeeded').length;
      const byDay = new Map();
      for (const r of runs) {
        const day = String(r.createdAt).slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      const days = [...Array(14)].map((_, i) => {
        const d = new Date(Date.now() - (13 - i) * 86400000).toISOString().slice(0, 10);
        return { day: d, count: byDay.get(d) ?? 0 };
      });
      return ok(res, {
        env: {
          dataDir: DATA_DIR,
          projectRoot: ROOT,
          concurrency: Number(process.env.TESTBENCH_CONCURRENCY || 2),
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
        },
        stats: {
          totalRuns: runs.length,
          succeeded,
          failed: runs.filter((r) => r.status === 'failed').length,
          running: runs.filter((r) => ['running', 'queued'].includes(r.status)).length,
          successRate: done.length ? Number(((succeeded / done.length) * 100).toFixed(1)) : 0,
          datasetCount: datasets.length,
          totalRequests: runs.reduce(
            (s, r) => s + (r.metrics ?? []).filter((m) => m.key === 'requests').reduce((x, m) => x + Number(m.value || 0), 0),
            0,
          ),
          byDay: days,
          byEngine: ['evalscope', 'locust', 'jmeter'].map((e) => ({
            engine: e,
            runs: runs.filter((r) => r.engine === e).length,
          })),
          detection,
        },
        recent: runs.slice(0, 8).map(summarizeRun),
      });
    }

    /* --------------------------------------------------------------- preview */
    if (head === 'preview' && method === 'POST') {
      const body = await readBody(req);
      const engine = getEngine(body.engine);
      if (!engine) return bad(res, `不支持的引擎：${body.engine ?? '(空)'}`);
      const config = { ...engine.defaults, ...(body.config || {}) };
      const dataset = body.datasetId ? await store.getDataset(body.datasetId) : null;
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'testbench-preview-'));
      try {
        const prepared = await engine.prepare({ config, runDir: tmp, dataset, store });
        const files = [];
        for (const value of Object.values(prepared.artifacts ?? {})) {
          if (typeof value !== 'string') continue;
          if (!/\.(py|jmx|json|yaml|yml)$/.test(value)) continue;
          const content = await fsp.readFile(value, 'utf8').catch(() => null);
          if (content !== null) files.push({ name: path.basename(value), content });
        }
        return ok(res, {
          command: [prepared.command, ...(prepared.displayArgs ?? prepared.args ?? [])].join(' '),
          targets: prepared.targets ?? [],
          files,
        });
      } catch (err) {
        return bad(res, `预览生成失败：${err?.message || err}`);
      } finally {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
      }
    }

    /* -------------------------------------------------------------- datasets */
    if (head === 'datasets') {
      if (method === 'GET' && !id) {
        return ok(res, { datasets: await store.listDatasets() });
      }
      if (method === 'POST' && !id) {
        const body = await readBody(req);
        const { name, description = '', filename, content, engine = 'any', tags = [] } = body;
        if (!content || typeof content !== 'string') return bad(res, '缺少文件内容 content');
        const safeName = safeFileName(filename || `${name || 'dataset'}.txt`);
        const type = body.type || detectType(safeName, content);
        const analysis = analyzeContent(type, content);
        const dsId = uid('ds');
        const write = await store.writeDatasetPayload(dsId, safeName, content);
        const meta = {
          id: dsId,
          name: name || safeName,
          description,
          filename: safeName,
          type,
          engine,
          tags: Array.isArray(tags) ? tags : String(tags).split(',').map((t) => t.trim()).filter(Boolean),
          sizeBytes: write.size,
          records: analysis.records,
          columns: analysis.columns ?? [],
          preview: analysis.preview ?? [],
          rows: analysis.rows ?? [],
          error: analysis.error,
          createdAt: nowIso(),
        };
        await store.saveDataset(meta);
        return ok(res, { dataset: meta });
      }
      if (id && method === 'GET' && sub === 'content') {
        const meta = await store.getDataset(id);
        if (!meta) return bad(res, '数据集不存在', 404);
        const text = await store.readDatasetPayload(id, meta.filename);
        if (text === null) return bad(res, '数据集文件缺失', 404);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }
      if (id && method === 'GET') {
        const meta = await store.getDataset(id);
        if (!meta) return bad(res, '数据集不存在', 404);
        return ok(res, { dataset: meta });
      }
      if (id && method === 'DELETE') {
        await store.deleteDataset(id);
        return ok(res, { deleted: id });
      }
    }

    /* ------------------------------------------------------------------ runs */
    if (head === 'runs') {
      if (method === 'GET' && !id) {
        const runs = await store.listRuns();
        const filtered = filterRuns(runs, {
          engine: url.searchParams.get('engine'),
          status: url.searchParams.get('status'),
          q: url.searchParams.get('q'),
          datasetId: url.searchParams.get('datasetId'),
          limit: url.searchParams.get('limit'),
        });
        return ok(res, { total: filtered.total, runs: filtered.runs.map(summarizeRun) });
      }

      if (method === 'POST' && !id) {
        const body = await readBody(req);
        const engine = getEngine(body.engine);
        if (!engine) return bad(res, `不支持的引擎：${body.engine ?? '(空)'}`);
        const config = { ...engine.defaults, ...(body.config || {}) };
        const missing = engine.fields
          .filter((f) => f.required && !String(config[f.key] ?? '').trim())
          .map((f) => f.label);
        if (missing.length) return bad(res, `缺少必填项：${missing.join('、')}`);

        let datasetName = null;
        if (body.datasetId) {
          const ds = await store.getDataset(body.datasetId);
          if (!ds) return bad(res, '数据集不存在');
          datasetName = ds.name;
        }

        const runId = uid('run');
        const run = {
          id: runId,
          name: (body.name || '').trim() || `${engine.name} · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
          engine: engine.id,
          status: 'queued',
          mode: null,
          createdAt: nowIso(),
          config,
          datasetId: body.datasetId ?? null,
          datasetName,
          tags: Array.isArray(body.tags) ? body.tags : [],
          progress: 0,
          phase: '排队中',
          metrics: [],
          series: [],
          seriesKeys: [],
          table: null,
          report: {},
          kpi: null,
        };
        await store.saveRun(run);
        runner.enqueue(runId);
        return json(res, 201, { ok: true, run: summarizeRun(run) });
      }

      if (id && method === 'GET' && sub === 'events') {
        const run = await store.getRun(id);
        if (!run) return bad(res, '运行记录不存在', 404);
        const logText = await fsp.readFile(store.runLogFile(id), 'utf8').catch(() => '');
        const tail = logText
          .split('\n')
          .filter(Boolean)
          .slice(-200)
          .map((line) => {
            const m = /^(\S+) \[(\w+)\] ([\s\S]*)$/.exec(line);
            return m ? { t: m[1], level: m[2], text: m[3] } : { t: nowIso(), level: 'info', text: line };
          });
        return events.subscribe(id, res, {
          replay: [
            { event: 'status', data: { status: run.status, mode: run.mode, progress: run.progress, phase: run.phase } },
            ...tail.map((l) => ({ event: 'log', data: l })),
          ],
        });
      }

      if (id && method === 'GET' && sub === 'logs') {
        const text = await fsp.readFile(store.runLogFile(id), 'utf8').catch(() => '');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(text);
      }

      if (id && method === 'GET' && sub === 'artifacts') {
        const dir = path.join(store.runsDir, `${id}.artifacts`);
        const out = [];
        const walk = async (d, depth = 0) => {
          if (depth > 3) return;
          const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
          for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) await walk(full, depth + 1);
            else {
              const st = await fsp.stat(full).catch(() => null);
              out.push({ name: path.relative(dir, full), size: st?.size ?? 0 });
            }
          }
        };
        await walk(dir);
        return ok(res, { files: out });
      }

      if (id && method === 'POST' && sub === 'cancel') {
        const run = await store.getRun(id);
        if (!run) return bad(res, '运行记录不存在', 404);
        await runner.cancel(id);
        return ok(res, { canceled: id });
      }

      if (id && method === 'POST' && sub === 'rerun') {
        const prev = await store.getRun(id);
        if (!prev) return bad(res, '运行记录不存在', 404);
        const newId = uid('run');
        const run = {
          ...prev,
          id: newId,
          status: 'queued',
          mode: null,
          createdAt: nowIso(),
          startedAt: null,
          finishedAt: null,
          durationSec: null,
          progress: 0,
          phase: '排队中',
          metrics: [],
          series: [],
          seriesKeys: [],
          table: null,
          report: {},
          kpi: null,
          error: null,
          command: null,
          name: `${prev.name} (重跑)`,
        };
        await store.saveRun(run);
        runner.enqueue(newId);
        return json(res, 201, { ok: true, run: summarizeRun(run) });
      }

      if (id && method === 'GET') {
        const run = await store.getRun(id);
        if (!run) return bad(res, '运行记录不存在', 404);
        return ok(res, { run });
      }

      if (id && method === 'DELETE') {
        await runner.cancel(id);
        await store.deleteRun(id);
        return ok(res, { deleted: id });
      }
    }

    if (head === 'compare' && method === 'GET') {
      const ids = String(url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      const runs = [];
      for (const rid of ids) {
        const run = await store.getRun(rid);
        if (run) runs.push(run);
      }
      return ok(res, { runs });
    }

    return bad(res, `未知接口：${method} ${url.pathname}`, 404);
  } catch (err) {
    return bad(res, String(err?.message || err), 500);
  }
}
