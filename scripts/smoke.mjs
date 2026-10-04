/**
 * End-to-end smoke test.
 *
 * Boots the server on a throwaway port and drives the real HTTP API:
 * engine detection -> dataset upload -> preview -> run -> live events ->
 * result parsing -> compare -> cleanup.
 *
 *   node scripts/smoke.mjs
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const PORT = Number(process.env.SMOKE_PORT || 4187);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  return false;
}

const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'testbench-smoke-'));
const server = spawn(process.execPath, [path.join(projectRoot, 'server.js')], {
  cwd: projectRoot,
  // 并发限制为 1，让排队行为可被确定性断言
  env: { ...process.env, PORT: String(PORT), TESTBENCH_DATA: dataDir, TESTBENCH_CONCURRENCY: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => {
  serverLog += d;
});
server.stderr.on('data', (d) => {
  serverLog += d;
});

const cleanup = async () => {
  server.kill('SIGTERM');
  await sleep(400);
  if (!server.killed) server.kill('SIGKILL');
  await fsp.rm(dataDir, { recursive: true, force: true }).catch(() => {});
};

try {
  console.log(`\nTestBench 冒烟测试 → ${BASE}\n`);
  if (!(await waitForServer())) {
    console.error('服务器启动失败：\n', serverLog);
    process.exit(1);
  }
  check('服务启动并响应 /api/health', true);

  /* ---------------------------------------------------------------- static */
  const index = await fetch(`${BASE}/`);
  check('首页 HTML 可访问', index.status === 200 && (await index.text()).includes('TestBench'));
  const css = await fetch(`${BASE}/styles.css`);
  check('样式表可访问', css.status === 200);
  const appJs = await fetch(`${BASE}/app.js`);
  check('前端入口 app.js 可访问', appJs.status === 200);

  /* -------------------------------------------------------------- engines */
  const engines = await req('/api/engines');
  check('返回 3 个引擎', engines.data?.engines?.length === 3, JSON.stringify(engines.data?.engines?.map((e) => e.id)));
  check(
    '引擎均带有字段定义与检测结果',
    engines.data.engines.every((e) => Array.isArray(e.fields) && e.fields.length > 0) &&
      engines.data.detection.length === 3,
  );

  const evalscopeDetection = engines.data.detection.find((d) => d.id === 'evalscope');
  check('EvalScope 检测到本机 CLI', evalscopeDetection?.available === true, JSON.stringify(evalscopeDetection));

  /* ------------------------------------------------------------- datasets */
  const csv = 'method,path,weight\nGET,/,3\nGET,/api/items,2\nPOST,/api/orders,1\n';
  const created = await req('/api/datasets', {
    method: 'POST',
    body: JSON.stringify({ name: '冒烟接口集', filename: 'endpoints.csv', content: csv, engine: 'locust' }),
  });
  check('上传 CSV 数据集', created.status === 200 && created.data.dataset?.records === 3, JSON.stringify(created.data).slice(0, 200));
  const dsId = created.data.dataset?.id;
  check('数据集解析出 method/path 行', created.data.dataset?.rows?.[0]?.path === '/');

  const badUpload = await req('/api/datasets', { method: 'POST', body: JSON.stringify({ filename: 'x.csv' }) });
  check('缺少内容时返回 400', badUpload.status === 400);

  const listed = await req('/api/datasets');
  check('数据集列表包含新数据集', listed.data.datasets.some((d) => d.id === dsId));

  /* -------------------------------------------------------------- preview */
  const preview = await req('/api/preview', {
    method: 'POST',
    body: JSON.stringify({
      engine: 'locust',
      config: { host: 'https://example.com', users: 10, spawnRate: 2, duration: 30, paths: 'GET / 1' },
      datasetId: dsId,
    }),
  });
  check('生成执行命令预览', preview.data?.command?.startsWith('locust -f '), preview.data?.command);
  check('预览包含自动生成的 locustfile.py', preview.data?.files?.some((f) => f.name === 'locustfile.py'));
  check(
    'locustfile 使用了数据集中的 3 个接口',
    (preview.data?.files?.[0]?.content ?? '').split('@task').length - 1 === 3,
    `tasks=${(preview.data?.files?.[0]?.content ?? '').split('@task').length - 1}`,
  );

  const jmPreview = await req('/api/preview', {
    method: 'POST',
    body: JSON.stringify({ engine: 'jmeter', config: { host: 'https://example.com', paths: 'GET /a\nPOST /b 2' } }),
  });
  check('JMeter 预览生成 JMX', jmPreview.data?.files?.some((f) => f.name === 'plan.jmx'));

  const evalPreview = await req('/api/preview', {
    method: 'POST',
    body: JSON.stringify({ engine: 'evalscope', config: { model: 'Qwen/Qwen2.5-0.5B-Instruct', datasets: 'gsm8k', evalType: 'mock_llm', apiKey: 'sk-secret-value-123' } }),
  });
  check('EvalScope 预览命令正确', evalPreview.data?.command?.includes('evalscope eval'), evalPreview.data?.command);
  check('预览中 API Key 已被脱敏', !evalPreview.data?.command?.includes('sk-secret-value-123'), evalPreview.data?.command);

  /* ---------------------------------------------------- validation errors */
  const badRun = await req('/api/runs', { method: 'POST', body: JSON.stringify({ engine: 'nope' }) });
  check('未知引擎返回 400', badRun.status === 400);
  const missingField = await req('/api/runs', { method: 'POST', body: JSON.stringify({ engine: 'locust', config: { host: '' } }) });
  check('缺少必填项返回 400', missingField.status === 400);

  /* ------------------------------------------------------------------ run */
  const run = await req('/api/runs', {
    method: 'POST',
    body: JSON.stringify({
      engine: 'locust',
      name: '冒烟压测',
      tags: ['smoke'],
      datasetId: dsId,
      config: { host: 'https://example.com', users: 25, spawnRate: 5, duration: 45, paths: 'GET / 2\nPOST /api/orders 1' },
    }),
  });
  check('创建运行返回 201', run.status === 201, JSON.stringify(run.data).slice(0, 200));
  const runId = run.data.run.id;
  check('初始状态为 queued/running', ['queued', 'running'].includes(run.data.run.status));

  const sseEvents = [];
  const sseRes = await fetch(`${BASE}/api/runs/${runId}/events`);
  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  const readPromise = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const chunk of decoder.decode(value).split('\n\n')) {
          const m = /^event: (\w+)\ndata: (.*)$/m.exec(chunk);
          if (m) sseEvents.push({ event: m[1], data: JSON.parse(m[2]) });
        }
      }
    } catch {
      /* stream closed */
    }
  })();
  check('SSE 日志流可连接', sseRes.status === 200 && sseRes.headers.get('content-type')?.includes('text/event-stream'));

  let final = null;
  for (let i = 0; i < 120; i += 1) {
    await sleep(400);
    const r = await req(`/api/runs/${runId}`);
    if (['succeeded', 'failed', 'canceled'].includes(r.data.run.status)) {
      final = r.data.run;
      break;
    }
  }
  reader.cancel().catch(() => {});
  await readPromise;

  check('运行结束且状态为成功', final?.status === 'succeeded', final?.status);
  check('记录了执行模式', ['real', 'demo'].includes(final?.mode), final?.mode);
  check('记录了解析后的指标', (final?.metrics ?? []).length >= 4, JSON.stringify(final?.metrics));
  check('生成了时序数据', (final?.series ?? []).length > 3, `points=${final?.series?.length}`);
  check('生成了明细表', (final?.table?.rows ?? []).length >= 2, `rows=${final?.table?.rows?.length}`);
  check('使用了数据集中的接口路径', final?.table?.rows?.some((r) => r.name.includes('/api/orders')));
  check('记录了执行命令', typeof final?.command === 'string' && final.command.includes('locust'));
  check('SSE 推送了日志事件', sseEvents.filter((e) => e.event === 'log').length > 3, `events=${sseEvents.length}`);
  check('SSE 推送了完成事件', sseEvents.some((e) => e.event === 'done'));

  const logs = await fetch(`${BASE}/api/runs/${runId}/logs`).then((r) => r.text());
  check('日志文件可下载且非空', logs.length > 100);

  const artifacts = await req(`/api/runs/${runId}/artifacts`);
  check('产物接口可用', Array.isArray(artifacts.data.files));

  /* ------------------------------------------------------- history/compare */
  const second = await req('/api/runs', {
    method: 'POST',
    body: JSON.stringify({ engine: 'jmeter', name: '冒烟压测 B', config: { host: 'https://example.com', threads: 10, duration: 30, paths: 'GET / 1' } }),
  });
  const secondId = second.data.run.id;

  const filtered = await req('/api/runs?engine=jmeter&limit=10');
  check('按引擎筛选历史记录', filtered.data.runs.every((r) => r.engine === 'jmeter') && filtered.data.total >= 1);

  const searched = await req(`/api/runs?q=${encodeURIComponent('冒烟压测')}`);
  check('关键词搜索命中', searched.data.runs.length >= 1);

  const cmp = await req(`/api/compare?ids=${runId},${secondId}`);
  check('对比接口返回两条记录', cmp.data.runs.length === 2);

  const stats = await req('/api/stats');
  check('统计接口返回聚合数据', stats.data.stats.totalRuns >= 2 && stats.data.stats.byDay.length === 14);
  check('统计接口暴露环境信息', typeof stats.data.env.dataDir === 'string');

  /* ------------------------------------------------------------- rerun/del */
  const rerun = await req(`/api/runs/${runId}/rerun`, { method: 'POST' });
  check('重跑生成新任务', rerun.status === 201 && rerun.data.run.id !== runId);
  await req(`/api/runs/${rerun.data.run.id}/cancel`, { method: 'POST' });

  /* ------------------------------------------------------- 并发与排队行为 */
  const batch = await Promise.all(
    [1, 2, 3].map((i) =>
      req('/api/runs', {
        method: 'POST',
        body: JSON.stringify({
          engine: 'locust',
          name: `并发测试 ${i}`,
          config: { host: 'https://example.com', users: 5, spawnRate: 1, duration: 20, paths: 'GET / 1' },
        }),
      }),
    ),
  );
  check('批量提交 3 个任务', batch.every((b) => b.status === 201));

  let sawQueued = false;
  let maxRunning = 0;
  for (let i = 0; i < 25; i += 1) {
    const list = await req(`/api/runs?q=${encodeURIComponent('并发测试')}`);
    const running = list.data.runs.filter((r) => r.status === 'running').length;
    const queuedNow = list.data.runs.filter((r) => r.status === 'queued').length;
    maxRunning = Math.max(maxRunning, running);
    if (queuedNow > 0) sawQueued = true;
    if (!list.data.runs.some((r) => ['queued', 'running'].includes(r.status))) break;
    await sleep(250);
  }
  check('并发上限生效：任务进入排队', sawQueued);
  check('并发上限生效：同时运行不超过 1 个', maxRunning <= 1, `max=${maxRunning}`);
  for (const b of batch) await req(`/api/runs/${b.data.run.id}/cancel`, { method: 'POST' });
  for (const b of batch) await req(`/api/runs/${b.data.run.id}`, { method: 'DELETE' });

  const delRun = await req(`/api/runs/${runId}`, { method: 'DELETE' });
  check('删除运行记录', delRun.status === 200);
  const gone = await req(`/api/runs/${runId}`);
  check('删除后返回 404', gone.status === 404);

  const delDs = await req(`/api/datasets/${dsId}`, { method: 'DELETE' });
  check('删除数据集', delDs.status === 200);

  const notFound = await req('/api/nope');
  check('未知接口返回 404', notFound.status === 404);

  const traversal = await fetch(`${BASE}/../package.json`);
  check('静态目录穿越被拒绝', traversal.status === 403 || traversal.status === 404, `status=${traversal.status}`);

  /* ------------------------------------------- optional: real EvalScope run */
  if (process.argv.includes('--real-eval')) {
    console.log('\n[真实执行] EvalScope 端到端（需要网络下载数据集，离线环境会走失败路径）\n');
    const evalRun = await req('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        engine: 'evalscope',
        name: '冒烟评测',
        config: { model: 'Qwen/Qwen2.5-0.5B-Instruct', datasets: 'gsm8k', evalType: 'mock_llm', limit: 2 },
      }),
    });
    check('创建 EvalScope 运行', evalRun.status === 201, JSON.stringify(evalRun.data).slice(0, 200));
    const evalId = evalRun.data.run.id;

    let evalFinal = null;
    for (let i = 0; i < 300; i += 1) {
      await sleep(500);
      const r = await req(`/api/runs/${evalId}`);
      if (['succeeded', 'failed', 'canceled'].includes(r.data.run.status)) {
        evalFinal = r.data.run;
        break;
      }
    }
    check('EvalScope 运行进入终态', Boolean(evalFinal), '超时未结束');
    check('EvalScope 使用真实执行模式', evalFinal?.mode === 'real', evalFinal?.mode);
    check('EvalScope 命令包含 evalscope eval', evalFinal?.command?.includes('evalscope eval'));

    if (evalFinal?.status === 'succeeded') {
      console.log('  ℹ 真实评测成功，校验解析结果');
      check('解析出得分指标', (evalFinal.metrics ?? []).some((m) => m.key === 'score'));
      check('解析出数据集明细', (evalFinal.table?.rows ?? []).length >= 1);
    } else {
      console.log('  ℹ 真实评测失败（离线环境预期行为），校验错误是否被正确上报');
      check('失败原因被记录到运行记录', typeof evalFinal?.error === 'string' && evalFinal.error.length > 20, String(evalFinal?.error).slice(0, 120));
      check('失败时未伪造任何指标', (evalFinal?.metrics ?? []).length === 0, JSON.stringify(evalFinal?.metrics));
      const evalLogs = await fetch(`${BASE}/api/runs/${evalId}/logs`).then((r) => r.text());
      check('日志包含原始错误信息', /error|Error|failed|无法|Connection/i.test(evalLogs));
    }
    await req(`/api/runs/${evalId}`, { method: 'DELETE' });
  }
} catch (err) {
  failed += 1;
  console.error('\n运行测试时发生异常：', err);
} finally {
  await cleanup();
}

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
