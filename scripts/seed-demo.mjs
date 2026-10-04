/**
 * 生成演示数据：上传示例数据集并提交若干任务，便于首次打开界面时查看完整效果。
 *
 *   node scripts/seed-demo.mjs                 # 默认 http://127.0.0.1:4399
 *   node scripts/seed-demo.mjs --base http://host:4399 --clean
 *
 * 所有任务都会以「演示模式」标记（未安装的引擎）或真实执行（已安装的引擎），
 * 平台不会把合成数据伪装成真实测量。
 */
const args = process.argv.slice(2);
const baseArg = args.indexOf('--base');
const BASE = baseArg >= 0 ? args[baseArg + 1] : process.env.TESTBENCH_BASE || 'http://127.0.0.1:4399';
const clean = args.includes('--clean');

async function api(pathname, options = {}) {
  const res = await fetch(`${BASE}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

const health = await api('/api/health').catch(() => null);
if (!health) {
  console.error(`无法连接 ${BASE}，请先运行 npm start`);
  process.exit(1);
}
console.log(`已连接 ${BASE}\n`);

if (clean) {
  const { runs } = await api('/api/runs');
  const { datasets } = await api('/api/datasets');
  for (const r of runs) await api(`/api/runs/${r.id}`, { method: 'DELETE' });
  for (const d of datasets) await api(`/api/datasets/${d.id}`, { method: 'DELETE' });
  console.log(`已清空 ${runs.length} 条运行记录与 ${datasets.length} 个数据集\n`);
}

const datasets = [
  {
    name: '示例 · 电商接口清单',
    filename: 'shop-endpoints.csv',
    engine: 'any',
    description: '演示用：热门接口 + 权重',
    content: 'method,path,weight\nGET,/,3\nGET,/api/items,2\nGET,/api/items/1,2\nPOST,/api/orders,1\nGET,/api/users/1,1\n',
  },
  {
    name: '示例 · 模型问答样本',
    filename: 'qa-samples.jsonl',
    engine: 'evalscope',
    description: '演示用：本地评测样本',
    content:
      '{"question": "水的化学式是什么？", "answer": "H2O"}\n' +
      '{"question": "1+1 等于几？", "answer": "2"}\n' +
      '{"question": "中国的首都是哪座城市？", "answer": "北京"}\n',
  },
];

const created = [];
for (const ds of datasets) {
  const res = await api('/api/datasets', { method: 'POST', body: JSON.stringify(ds) });
  created.push(res.dataset);
  console.log(`✓ 数据集「${res.dataset.name}」 · ${res.dataset.records} 条 · ${res.dataset.type}`);
}

const endpointDataset = created[0];
const jobs = [
  {
    engine: 'locust',
    name: '示例 · 商城首页混合负载',
    tags: ['演示', '基线'],
    datasetId: endpointDataset.id,
    config: { host: 'https://httpbin.org', users: 50, spawnRate: 5, duration: 120, paths: 'GET / 3\nGET /get 2' },
  },
  {
    engine: 'jmeter',
    name: '示例 · 下单链路压测',
    tags: ['演示'],
    datasetId: endpointDataset.id,
    config: { host: 'https://httpbin.org', threads: 30, rampTime: 10, duration: 90, loopCount: 1, paths: 'GET / 1\nPOST /post 1' },
  },
  {
    engine: 'locust',
    name: '示例 · 高并发冒烟（小规模）',
    tags: ['演示', '冒烟'],
    config: { host: 'https://httpbin.org', users: 10, spawnRate: 2, duration: 30, paths: 'GET / 1' },
  },
];

console.log('');
for (const job of jobs) {
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify(job) });
  console.log(`✓ 已提交任务「${res.run.name}」 → ${BASE}/#/runs/${res.run.id}`);
}

// 等待任务结束，便于直接查看结果
const deadline = Date.now() + 90_000;
out: while (Date.now() < deadline) {
  const { runs } = await api('/api/runs?limit=10');
  const pending = runs.filter((r) => ['queued', 'running'].includes(r.status));
  if (!pending.length) break;
  console.log(`  … 仍有 ${pending.length} 个任务在执行`);
  await new Promise((r) => setTimeout(r, 3000));
  if (pending.length === 0) break out;
}

const { runs } = await api('/api/runs?limit=10');
console.log('\n最近运行：');
for (const r of runs.slice(0, 6)) {
  const kpi = r.kpi ? ` · ${r.kpi.value} ${r.kpi.label}` : '';
  console.log(`  [${r.status}] ${r.name} (${r.mode ?? '-'})${kpi}`);
}
console.log(`\n打开界面：${BASE}/\n`);
