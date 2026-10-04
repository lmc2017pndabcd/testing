import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { events } from './events.js';
import { detectAll, getEngine } from './engines/index.js';
import { store } from './store.js';
import { clamp, nowIso, sleep, truncate } from './util.js';

const MAX_CONCURRENT = Number(process.env.TESTBENCH_CONCURRENCY || 2);
const DEMO_TICKS = 10;

function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (s && String(s).length >= 4) out = out.split(String(s)).join('***');
  }
  return out.replace(/(api[-_]?key["'\s:=]+)([A-Za-z0-9_\-.]{8,})/gi, '$1***');
}

function levelFor(line) {
  const s = String(line);
  if (/\b(ERROR|CRITICAL|Traceback|Exception|失败|FATAL)\b/i.test(s)) return 'error';
  if (/\b(WARN|WARNING|警告)\b/i.test(s)) return 'warn';
  if (/\b(SUCCESS|finished|完成)\b/i.test(s)) return 'success';
  return 'info';
}

class Runner {
  constructor() {
    this.queue = [];
    this.children = new Map();
    this.timers = new Map();
    this.exitCodes = new Map();
    this.lastError = new Map();
    this.active = new Set();
    this.pumping = false;
  }

  /** Number of runs currently occupying a worker slot. */
  get activeCount() {
    return this.active.size;
  }

  enqueue(id) {
    if (!this.queue.includes(id) && !this.children.has(id)) this.queue.push(id);
    this.pump();
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.active.size < MAX_CONCURRENT) {
        const id = this.queue.shift();
        const run = await store.getRun(id);
        if (!run || run.status === 'canceled') continue;
        this.active.add(id);
        this.execute(id)
          .catch((err) => {
            this.finish(id, { status: 'failed', error: String(err?.message || err) });
          })
          .finally(() => {
            this.active.delete(id);
            this.pump();
          });
      }
    } finally {
      this.pumping = false;
    }
  }

  async appendLog(id, level, text, secrets = []) {
    const clean = redact(text, secrets);
    const entry = { t: nowIso(), level: levelFor(clean), text: clean };
    if (entry.level === 'error') this.lastError.set(id, truncate(clean, 600));
    events.publish(id, 'log', entry);
    try {
      await fsp.appendFile(store.runLogFile(id), `${entry.t} [${entry.level}] ${clean}\n`, 'utf8');
    } catch {
      /* log file is best-effort */
    }
    return entry;
  }

  async setStatus(id, status, extra = {}) {
    const run = await store.getRun(id);
    if (!run) return null;
    Object.assign(run, { status }, extra);
    await store.saveRun(run);
    events.publish(id, 'status', { status, ...extra });
    return run;
  }

  async publishProgress(id, progress, phase) {
    events.publish(id, 'progress', { progress, phase });
  }

  async execute(id) {
    const run = await store.getRun(id);
    if (!run) return;
    const engine = getEngine(run.engine);
    if (!engine) {
      await this.setStatus(id, 'failed', { error: `未知引擎：${run.engine}`, finishedAt: nowIso() });
      return;
    }

    const startedAt = Date.now();
    const detection = (await detectAll()).find((d) => d.id === engine.id);
    const mode = detection?.available ? 'real' : 'demo';
    const config = { ...engine.defaults, ...(run.config || {}) };
    const dataset = run.datasetId ? await store.getDataset(run.datasetId) : null;

    await this.setStatus(id, 'running', {
      startedAt: nowIso(),
      mode,
      progress: 0,
      phase: mode === 'real' ? '准备中' : '演示模式',
      attempts: (run.attempts || 0) + 1,
    });

    const runDir = path.join(store.runsDir, `${id}.artifacts`);
    await fsp.mkdir(runDir, { recursive: true });
    await fsp.writeFile(store.runLogFile(id), '', 'utf8').catch(() => {});

    let prepared = null;
    try {
      prepared = await engine.prepare({ config, runDir, dataset, store });
    } catch (err) {
      await this.appendLog(id, 'error', `准备阶段失败：${err?.message || err}`);
      await this.finish(id, { status: 'failed', error: String(err?.message || err) });
      return;
    }

    const secrets = prepared.secrets ?? [config.apiKey].filter(Boolean);
    const displayArgs = prepared.displayArgs ?? prepared.args;
    const commandLine = [prepared.command, ...displayArgs].join(' ');
    const run2 = await store.getRun(id);
    await store.saveRun({ ...run2, command: commandLine, preparedHint: prepared.artifacts ?? null });

    await this.appendLog(
      id,
      'info',
      mode === 'real'
        ? `已检测到 ${engine.name}，开始真实执行`
        : `未检测到 ${engine.name} CLI，本次使用演示模式（合成数据，非真实测量）`,
      secrets,
    );
    await this.appendLog(id, 'info', `$ ${redact(commandLine, secrets)}`, secrets);

    let demoResult = null;
    if (mode === 'demo') {
      await this.executeDemo(id, engine, config, prepared, secrets);
      demoResult = await engine.simulate({ config, targets: prepared.targets, runDir });
    } else {
      await this.executeReal(id, engine, prepared, config, secrets, runDir);
    }

    const seconds = (Date.now() - startedAt) / 1000;
    const current = await store.getRun(id);
    if (current?.status === 'canceled') return;

    let parsed = demoResult;
    if (mode === 'real') {
      try {
        parsed = await engine.parse({ runDir, config, prepared, run: current });
      } catch (err) {
        await this.appendLog(id, 'warn', `结果解析异常：${err?.message || err}`);
      }
    }

    const exit = this.exitCodes.get(id) ?? 0;
    const hasResult = Boolean(parsed && parsed.metrics?.length);
    const status = current?.status === 'canceled' ? 'canceled' : exit === 0 || hasResult ? 'succeeded' : 'failed';

    if (!hasResult && exit !== 0) {
      await this.appendLog(id, 'error', `进程退出码 ${exit}，且未解析到结果`);
    }
    // Keep the most useful diagnostic on the record itself, not just in the log file.
    const failure =
      status === 'failed' && !hasResult
        ? this.lastError.get(id) ?? `进程退出码 ${exit}，未产生可用结果`
        : null;

    await this.finish(id, {
      status,
      ...(failure ? { error: failure } : {}),
      progress: 100,
      finishedAt: nowIso(),
      durationSec: Number(seconds.toFixed(1)),
      metrics: parsed?.metrics ?? [],
      series: parsed?.series ?? [],
      seriesKeys: parsed?.seriesKeys ?? [],
      table: parsed?.table ?? null,
      report: parsed?.report ?? {},
      kpi: parsed?.metrics?.length
        ? { label: parsed.metrics[0].label, value: parsed.metrics[0].value, format: parsed.metrics[0].format }
        : null,
    });
  }

  async executeDemo(id, engine, config, prepared, secrets) {
    const durationSec = Number(config.duration) || 45;
    const phases = ['初始化', '预热', '加压中', '稳定运行', '收敛'];
    for (let i = 0; i < DEMO_TICKS; i += 1) {
      const run = await store.getRun(id);
      if (run?.status === 'canceled') return;
      const phase = phases[Math.min(phases.length - 1, Math.floor((i / DEMO_TICKS) * phases.length))];
      await this.appendLog(id, 'info', `[demo] ${phase} … 已运行 ${Math.round((i / DEMO_TICKS) * durationSec)}s/${durationSec}s`, secrets);
      await this.publishProgress(id, Math.round(((i + 1) / DEMO_TICKS) * 95), phase);
      await sleep(450 + Math.random() * 500);
    }
    this.exitCodes.set(id, 0);
    await this.appendLog(id, 'success', '[demo] 运行结束，正在汇总合成结果', secrets);
  }

  async executeReal(id, engine, prepared, config, secrets, runDir) {
    const args = prepared.args ?? [];
    const env = { ...process.env, ...(prepared.env || {}) };
    const child = spawn(prepared.command, args, {
      cwd: prepared.cwd || runDir,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(id, child);
    this.exitCodes.set(id, null);
    await this.setStatus(id, 'running', { pid: child.pid });

    const expectedMs = Number(config.duration) ? Number(config.duration) * 1000 : null;
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      if (!expectedMs) return;
      const p = clamp((Date.now() - startedAt) / expectedMs, 0, 1) * 95;
      this.publishProgress(id, Number(p.toFixed(1)), '执行中');
    }, 1000);
    this.timers.set(id, ticker);

    let pending = '';
    const onChunk = async (chunk, isErr) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        await this.appendLog(id, isErr ? 'warn' : 'info', truncate(line, 2000), secrets);
        const m = /(\d+(?:\.\d+)?)\s*%/.exec(line) || /\[(\d+)\/(\d+)\]/.exec(line);
        if (m) {
          const p = m[2] ? (Number(m[1]) / Number(m[2])) * 100 : Number(m[1]);
          if (Number.isFinite(p)) await this.publishProgress(id, clamp(p, 0, 99), '执行中');
        }
      }
    };

    child.stdout?.on('data', (c) => {
      onChunk(c, false);
    });
    child.stderr?.on('data', (c) => {
      onChunk(c, true);
    });

    const exitCode = await new Promise((resolve) => {
      child.on('error', async (err) => {
        await this.appendLog(id, 'error', `进程启动失败：${err.message}`, secrets);
        resolve(-1);
      });
      child.on('close', (code) => resolve(code ?? -1));
    });

    if (pending.trim()) await this.appendLog(id, 'info', truncate(pending, 2000), secrets);
    clearInterval(ticker);
    this.timers.delete(id);
    this.children.delete(id);
    this.exitCodes.set(id, exitCode);
    await this.appendLog(
      id,
      exitCode === 0 ? 'success' : 'error',
      `进程退出，exit code = ${exitCode}`,
      secrets,
    );
  }

  async finish(id, patch) {
    const run = await store.getRun(id);
    if (!run) return;
    Object.assign(run, patch);
    await store.saveRun(run);
    events.publish(id, 'progress', { progress: patch.progress ?? run.progress, phase: '已完成' });
    events.publish(id, 'status', { status: run.status, finishedAt: run.finishedAt });
    events.publish(id, 'done', { status: run.status, kpi: run.kpi ?? null });
    this.pump();
  }

  async cancel(id) {
    const child = this.children.get(id);
    if (this.queue.includes(id)) this.queue = this.queue.filter((q) => q !== id);
    if (child?.pid) {
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      setTimeout(() => {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }, 5000);
    }
    await this.appendLog(id, 'warn', '收到取消请求，正在终止任务');
    await this.setStatus(id, 'canceled', { finishedAt: nowIso(), progress: 100 });
    events.publish(id, 'done', { status: 'canceled' });
    this.children.delete(id);
    const t = this.timers.get(id);
    if (t) clearInterval(t);
    this.timers.delete(id);
    this.pump();
    return true;
  }

  /** Kill everything on shutdown so no orphaned load generators stay alive. */
  async shutdown() {
    for (const [id] of this.children) await this.cancel(id);
  }
}

export const runner = new Runner();
