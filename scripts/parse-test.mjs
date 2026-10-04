/**
 * Result-parser tests.
 *
 * Feeds realistic artifacts (Locust CSV, JMeter JTL, EvalScope report JSON) to
 * the engine adapters and asserts the normalized output. These formats are the
 * easiest thing to get subtly wrong, so they are pinned by fixtures here.
 *
 *   node scripts/parse-test.mjs
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import evalscope from '../src/engines/evalscope.js';
import jmeter from '../src/engines/jmeter.js';
import locust from '../src/engines/locust.js';

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

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'testbench-parse-'));
const write = async (file, content) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
};

/* --------------------------------------------------------------- Locust CSV */
console.log('\nLocust CSV 解析\n');
{
  const dir = path.join(tmp, 'locust');
  const prefix = path.join(dir, 'locust');
  await write(
    `${prefix}_stats.csv`,
    [
      'Type,Name,Request Count,Failure Count,Median Response Time,Average Response Time,Min Response Time,Max Response Time,Average Content Size,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%,99.9%,99.99%,100%',
      'GET,/api/items,1200,4,85,92,12,640,5321,20.00,0.07,85,95,105,115,140,180,220,260,320,380,640',
      'POST,/api/orders,1200,5,101,118,20,720,4100,20.00,0.08,101,112,124,136,168,210,255,300,360,420,720',
      ',Aggregated,2400,9,88,95,10,720,5100,40.00,0.15,88,98,108,118,145,185,225,265,325,385,720',
      '',
    ].join('\n'),
  );
  await write(
    `${prefix}_stats_history.csv`,
    [
      'Timestamp,User Count,Type,Name,Requests/s,Failures/s,50%,66%,75%,80%,90%,95%,98%,99%,99.9%,99.99%,100%',
      '1696350000,6,,Aggregated,12.50,0.01,80,90,95,100,120,150,180,210,260,300,500',
      '1696350001,9,,Aggregated,21.30,0.02,84,94,99,104,124,154,184,214,264,304,520',
      '1696350002,10,,Aggregated,40.10,0.15,88,98,108,118,145,185,225,265,325,385,720',
      '',
    ].join('\n'),
  );
  await write(
    `${prefix}_failures.csv`,
    [
      'Method,Name,Error,Occurrences,First Occurrence,Last Occurrence',
      'GET,/api/items,"HTTPError(\'500 Server Error\')",4,1696350000,1696350010',
      '',
    ].join('\n'),
  );

  const out = await locust.parse({ runDir: dir, prepared: { artifacts: { prefix } } });
  const metric = (key) => out.metrics.find((m) => m.key === key)?.value;

  check('解析出 6 个汇总指标', out.metrics.length === 6, JSON.stringify(out.metrics.map((m) => m.key)));
  check('总请求数 = 2400', metric('requests') === 2400, String(metric('requests')));
  check('平均 RPS = 40', metric('rps') === 40, String(metric('rps')));
  check('平均响应 = 95ms', metric('avg') === 95, String(metric('avg')));
  check('P95 = 185ms', metric('p95') === 185, String(metric('p95')));
  check('错误率 = 0.38%', metric('errorRate') === 0.38, String(metric('errorRate')));
  check('时序解析出 3 个点', out.series.length === 3, `points=${out.series.length}`);
  check(
    '时序字段正确（t / rps / users）',
    out.series[1].t === 1696350001 && out.series[1].rps === 21.3 && out.series[1].users === 9,
    JSON.stringify(out.series[1]),
  );
  check('接口明细 2 行（不含 Aggregated）', out.table.rows.length === 2, `rows=${out.table.rows.length}`);
  check('明细首行名称正确', out.table.rows[0].name === '/api/items', out.table.rows[0].name);
  check(
    '失败原因解析（含逗号的引号字段）',
    out.report.failures?.[0]?.occurrences === 4 && out.report.failures[0].error.includes('500 Server Error'),
    JSON.stringify(out.report.failures),
  );
}

/* --------------------------------------------------------------- JMeter JTL */
console.log('\nJMeter JTL 解析\n');
{
  const dir = path.join(tmp, 'jmeter');
  await fsp.mkdir(dir, { recursive: true });
  const rows = [
    'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect',
  ];
  const base = 1696350000000;
  for (let i = 0; i < 40; i += 1) {
    const success = i % 20 !== 0;
    const label = i % 2 === 0 ? 'GET /' : 'POST /api/orders';
    rows.push(
      [
        base + i * 250,
        80 + (i % 12) * 10,
        label,
        success ? 200 : 500,
        success ? 'OK' : 'Server Error',
        `Thread Group 1-${(i % 10) + 1}`,
        'text',
        success ? 'true' : 'false',
        success ? '' : 'boom',
        5120,
        120,
        10,
        10,
        'https://example.com/',
        70 + (i % 5) * 4,
        0,
        5,
      ].join(','),
    );
  }
  await write(path.join(dir, 'results.jtl'), `${rows.join('\n')}\n`);

  const out = await jmeter.parse({ runDir: dir, prepared: { artifacts: { jtl: path.join(dir, 'results.jtl') } } });
  const metric = (key) => out.metrics.find((m) => m.key === key)?.value;
  check('总请求数 = 40', metric('requests') === 40, String(metric('requests')));
  check('错误率 = 5%（每 20 条 1 个失败）', metric('errorRate') === 5, String(metric('errorRate')));
  check('解析出平均响应与 P95', metric('avg') > 0 && metric('p95') > 0, `${metric('avg')} / ${metric('p95')}`);
  check('时序按秒聚合', out.series.length >= 5, `points=${out.series.length}`);
  check('接口明细 2 行', out.table.rows.length === 2, `rows=${out.table.rows.length}`);
  check('明细包含 POST 请求', out.table.rows.some((r) => r.name === 'POST /api/orders'));
  check('报告包含 min/max/p99', out.report.min > 0 && out.report.max > 0 && out.report.p99 > 0, JSON.stringify(out.report));
}

/* ---------------------------------------------------------- JTL 无表头容错 */
console.log('\nJMeter JTL（无表头）容错\n');
{
  const dir = path.join(tmp, 'jmeter-noheader');
  await fsp.mkdir(dir, { recursive: true });
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push(
      [
        1696350000000 + i * 500, 120, 'GET /health', 200, 'OK', 'TG 1-1',
        'text', 'true', '', 100, 50, 2, 2, 'https://x/', 100, 0, 3,
      ].join(','),
    );
  }
  await write(path.join(dir, 'results.jtl'), `${rows.join('\n')}\n`);
  const out = await jmeter.parse({ runDir: dir, prepared: { artifacts: { jtl: path.join(dir, 'results.jtl') } } });
  check(
    '无人表头时仍能解析出 12 条请求',
    out.metrics.find((m) => m.key === 'requests')?.value === 12,
    JSON.stringify(out.metrics),
  );
}

/* ---------------------------------------------------------- EvalScope 报告 */
console.log('\nEvalScope 报告解析\n');
{
  const dir = path.join(tmp, 'evalscope');
  const report = (dataset, score, num, extra = {}) => ({
    name: dataset,
    dataset_name: dataset,
    model_name: 'Qwen/Qwen2.5-0.5B-Instruct',
    score,
    num,
    metrics: [{ name: 'AverageAccuracy', score, categories: [{ name: 'default', subsets: [{ name: 'main', score, num }] }] }],
    analysis: 'N/A',
    ...extra,
  });
  await write(path.join(dir, 'reports', 'gsm8k.json'), JSON.stringify(report('gsm8k', 0.42, 50)));
  await write(
    path.join(dir, 'reports', 'arc.json'),
    JSON.stringify(report('arc', 0.58, 50, {
      perf_metrics: { 'TTFT(ms)': 123.4567, 'OutputThroughput(tokens/s)': 88.2 },
    })),
  );
  await write(path.join(dir, 'predictions', 'gsm8k.jsonl'), '{"a":1}\n');
  await write(path.join(dir, 'configs', 'task_config.yaml'), 'model: x\n');

  const out = await evalscope.parse({ runDir: dir });
  const metric = (key) => out.metrics.find((m) => m.key === key)?.value;
  check('平均得分 = 0.5', metric('score') === 0.5, String(metric('score')));
  check('数据集数 = 2', metric('datasets') === 2, String(metric('datasets')));
  check('样本数 = 100', metric('samples') === 100, String(metric('samples')));
  check('展示被测模型', metric('model') === 'Qwen/Qwen2.5-0.5B-Instruct', String(metric('model')));
  check(
    '解析 perf 指标（TTFT / 吞吐）',
    metric('perf_TTFT(ms)') === 123.46 && metric('perf_OutputThroughput(tokens/s)') === 88.2,
    JSON.stringify(out.metrics.map((m) => [m.key, m.value])),
  );
  check('柱状图数据按数据集排序', out.series.map((s) => s.name).join(',') === 'arc,gsm8k', JSON.stringify(out.series));
  check('明细表包含指标名', out.table.rows.every((r) => r.metric === 'AverageAccuracy'));
  check('原始报告保留 summary', out.report.summary.length === 2);
  check('predictions / configs 中的文件不会被误判为报告', out.table.rows.length === 2);

  const empty = await evalscope.parse({ runDir: path.join(tmp, 'nothing') });
  check('无报告时不产出伪指标', empty.metrics.length === 0);
}

await fsp.rm(tmp, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed ? 1 : 0);
