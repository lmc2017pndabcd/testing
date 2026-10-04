import { percentile } from '../util.js';

/**
 * Deterministic-ish synthetic load profiles.
 *
 * The platform always tells you which mode a run used (`real` vs `demo`), so a
 * demo run is never presented as a genuine measurement. It exists so the whole
 * workflow — configure, run, watch logs, inspect charts, compare history — is
 * usable on a machine where the underlying CLI is not installed yet.
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitterLatency(rnd, base) {
  const noise = 1 + (rnd() - 0.5) * 0.35;
  const spike = rnd() > 0.97 ? 1 + rnd() * 2.5 : 1;
  return Math.max(1, base * noise * spike);
}

/**
 * Build a plausible performance-test result: ramp-up, steady state, tail.
 * @returns {{metrics: Array, series: Array, seriesKeys: Array, table: Object, samples: number[]}}
 */
export function simulatePerf({ users = 10, spawnRate = 2, durationSec = 60, targets = [], engine = 'locust' }) {
  const rnd = mulberry32(Math.round(users * 977 + spawnRate * 131 + durationSec * 17 + targets.length));
  const steps = Math.max(12, Math.min(120, Math.round(durationSec)));
  const stepSec = durationSec / steps;
  const baseLatency = engine === 'jmeter' ? 95 : 120;

  const pointTargets = targets.length
    ? targets
    : [
        { method: 'GET', path: '/', weight: 3 },
        { method: 'GET', path: '/api/items', weight: 2 },
        { method: 'POST', path: '/api/orders', weight: 1 },
      ];
  const totalWeight = pointTargets.reduce((s, t) => s + (t.weight || 1), 0);

  const perTarget = pointTargets.map((t, i) => ({
    name: `${t.method || 'GET'} ${t.path || '/'}`,
    weight: (t.weight || 1) / totalWeight,
    latency: baseLatency * (0.8 + (i % 3) * 0.22),
    failRate: 0.004 + (i % 3) * 0.006,
  }));

  const series = [];
  const samples = [];
  let cumulative = 0;

  for (let i = 0; i < steps; i += 1) {
    const t = Math.round(i * stepSec);
    const ramp = Math.min(1, (i + 1) / Math.max(1, spawnRate * 2));
    const activeUsers = Math.max(1, Math.round(users * ramp));
    const secPerRequest = (activeUsers / 2.6) * (1 - 0.15 * Math.sin(i / 3));
    const avgLat = jitterLatency(rnd, baseLatency * (1 + 0.22 * ramp));
    const rps = Math.max(0.1, secPerRequest * (baseLatency / avgLat));
    const p95 = avgLat * (1.9 + rnd() * 0.4);
    const p99 = p95 * (1.15 + rnd() * 0.25);
    const requests = Math.round(rps * stepSec);
    const errors = Math.round(requests * (0.002 + rnd() * 0.012));
    cumulative += requests;
    for (let k = 0; k < Math.min(requests, 400); k += 1) samples.push(avgLat);
    series.push({
      t,
      rps: Number(rps.toFixed(2)),
      avg: Math.round(avgLat),
      p95: Math.round(p95),
      p99: Math.round(p99),
      users: activeUsers,
      errors,
      requests,
    });
  }

  const totalRequests = series.reduce((s, p) => s + p.requests, 0);
  const failures = series.reduce((s, p) => s + p.errors, 0);
  const avgLatency = series.reduce((s, p) => s + p.avg * p.requests, 0) / Math.max(1, totalRequests);
  const sorted = samples.sort((a, b) => a - b);

  const table = {
    title: '接口明细',
    columns: [
      { key: 'name', label: '接口' },
      { key: 'requests', label: '请求数', align: 'right', format: 'int' },
      { key: 'failures', label: '失败', align: 'right', format: 'int' },
      { key: 'avg', label: '平均(ms)', align: 'right', format: 'int' },
      { key: 'p95', label: 'P95(ms)', align: 'right', format: 'int' },
      { key: 'rps', label: 'RPS', align: 'right', format: 'float' },
    ],
    rows: perTarget.map((t) => {
      const reqs = Math.round(totalRequests * t.weight);
      return {
        name: t.name,
        requests: reqs,
        failures: Math.round(reqs * t.failRate),
        avg: Math.round(t.latency * 1.15),
        p95: Math.round(t.latency * 2.1),
        rps: Number((reqs / durationSec).toFixed(2)),
      };
    }),
  };

  const metrics = [
    { key: 'requests', label: '总请求数', value: totalRequests, format: 'int' },
    { key: 'rps', label: '平均 RPS', value: Number((totalRequests / durationSec).toFixed(2)), format: 'float' },
    { key: 'avg', label: '平均响应(ms)', value: Math.round(avgLatency), format: 'int' },
    { key: 'p95', label: 'P95(ms)', value: Math.round(percentile(sorted, 95)), format: 'int' },
    { key: 'errorRate', label: '错误率', value: Number(((failures / Math.max(1, totalRequests)) * 100).toFixed(2)), format: 'percent' },
    { key: 'failures', label: '失败数', value: failures, format: 'int' },
  ];

  return {
    metrics,
    series,
    seriesKeys: [
      { key: 'rps', label: 'RPS', color: '#4f9cf9', axis: 'left' },
      { key: 'avg', label: '平均延迟(ms)', color: '#f7b955', axis: 'right' },
      { key: 'p95', label: 'P95(ms)', color: '#e5679b', axis: 'right' },
    ],
    table,
    report: { engine, synthetic: true, note: '演示模式生成的合成数据，不代表真实性能。' },
  };
}

/** Synthetic evaluation result for EvalScope-style runs. */
export function simulateEval({ datasets = ['gsm8k'], limit = 10, model = 'demo-model' }) {
  const rnd = mulberry32(datasets.length * 613 + limit * 7 + model.length);
  const rows = datasets.map((d) => {
    const score = 0.32 + rnd() * 0.55;
    return {
      dataset: d,
      score: Number(score.toFixed(4)),
      num: limit,
      metrics: { 'AverageAccuracy': Number(score.toFixed(4)) },
    };
  });
  const avgScore = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length);

  return {
    metrics: [
      { key: 'score', label: '平均得分', value: Number(avgScore.toFixed(4)), format: 'score' },
      { key: 'datasets', label: '数据集数', value: rows.length, format: 'int' },
      { key: 'samples', label: '样本数', value: limit * rows.length, format: 'int' },
      { key: 'model', label: '被测模型', value: model, format: 'text' },
    ],
    series: rows.map((r, i) => ({ t: i, name: r.dataset, score: r.score })),
    seriesKeys: [{ key: 'score', label: '得分', color: '#5ad1a8', axis: 'left', kind: 'bars' }],
    table: {
      title: '数据集评测结果',
      columns: [
        { key: 'dataset', label: '数据集' },
        { key: 'score', label: '得分', align: 'right', format: 'score' },
        { key: 'num', label: '样本数', align: 'right', format: 'int' },
      ],
      rows,
    },
    report: { synthetic: true, datasets: rows, note: '演示模式生成的合成数据。' },
  };
}
