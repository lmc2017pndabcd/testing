import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, execCapture, toNumber, which } from '../util.js';
import { simulateEval } from './simulate.js';

const DEFAULTS = {
  model: 'Qwen/Qwen2.5-0.5B-Instruct',
  evalType: 'mock_llm',
  datasets: 'gsm8k',
  limit: 10,
  evalBackend: 'Native',
  apiUrl: '',
  apiKey: '',
  datasetDir: '',
  generationConfig: '',
};

/** Recursively collect report JSON files written by EvalScope. */
async function findReports(root, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (['predictions', 'reviews', 'logs', 'configs', 'assets'].includes(e.name)) continue;
      found.push(...(await findReports(full, depth + 1)));
    } else if (e.name.endsWith('.json') && e.name !== 'collection_info.json') {
      found.push(full);
    }
  }
  return found;
}

function scoreOf(report) {
  if (typeof report?.score === 'number') return report.score;
  const first = report?.metrics?.[0];
  if (typeof first?.score === 'number') return first.score;
  if (typeof report?.['Score'] === 'number') return report['Score'];
  return null;
}

function numOf(report) {
  if (typeof report?.num === 'number') return report.num;
  const first = report?.metrics?.[0];
  if (first?.categories) {
    return first.categories.reduce(
      (s, c) => s + (c.subsets ?? []).reduce((x, sub) => x + (sub.is_aggregate ? 0 : toNumber(sub.num)), 0),
      0,
    );
  }
  return toNumber(report?.['Num']);
}

export default {
  id: 'evalscope',
  name: 'EvalScope',
  tagline: 'LLM 能力评测框架，支持 100+ 公开数据集',
  category: 'evaluation',
  accent: '#a78bfa',
  docs: 'https://evalscope.readthedocs.io',
  install: { cmd: 'pip install evalscope', hint: '本地已安装可直接使用真实评测' },
  binary: 'evalscope',
  defaults: DEFAULTS,

  fields: [
    { key: 'model', label: '模型 ID / 本地路径', type: 'text', required: true, default: DEFAULTS.model, group: '模型',
      help: 'ModelScope 模型 ID、OpenAI 兼容服务名或本地模型目录' },
    { key: 'evalType', label: '评测方式', type: 'select', default: DEFAULTS.evalType, group: '模型',
      options: [
        { value: 'mock_llm', label: 'mock_llm（离线自测，无需 API）' },
        { value: 'openai_api', label: 'openai_api（OpenAI 兼容接口）' },
        { value: 'openai_responses_api', label: 'openai_responses_api' },
        { value: 'anthropic_api', label: 'anthropic_api' },
        { value: 'litellm', label: 'litellm（多厂商聚合）' },
        { value: 'llm_ckpt', label: 'llm_ckpt（本地权重）' },
        { value: 'custom', label: 'custom（自定义）' },
      ] },
    { key: 'apiUrl', label: 'API 地址', type: 'text', default: '', group: '模型', placeholder: 'https://api.openai.com/v1', dependsOn: { key: 'evalType', in: ['openai_api', 'openai_responses_api', 'anthropic_api', 'litellm', 'custom'] } },
    { key: 'apiKey', label: 'API Key', type: 'password', default: '', group: '模型', secret: true, dependsOn: { key: 'evalType', in: ['openai_api', 'openai_responses_api', 'anthropic_api', 'litellm', 'custom'] } },
    { key: 'datasets', label: '数据集', type: 'text', required: true, default: DEFAULTS.datasets, group: '评测',
      help: '多个数据集用空格或逗号分隔，例如 gsm8k arc mmlu', placeholder: 'gsm8k' },
    { key: 'limit', label: '样本数上限', type: 'number', min: 1, max: 100000, default: DEFAULTS.limit, group: '评测',
      help: '每个数据集抽样的题目数量，调试时建议 10~50' },
    { key: 'evalBackend', label: '评测后端', type: 'select', default: DEFAULTS.evalBackend, group: '高级',
      options: [
        { value: 'Native', label: 'Native（原生）' },
        { value: 'OpenCompass', label: 'OpenCompass' },
        { value: 'VLMEvalKit', label: 'VLMEvalKit' },
        { value: 'RAGEval', label: 'RAGEval' },
      ] },
    { key: 'datasetDir', label: '本地数据集目录', type: 'text', default: '', group: '高级', placeholder: '/path/to/datasets' },
    { key: 'generationConfig', label: '生成参数(JSON)', type: 'textarea', rows: 3, default: '', group: '高级', placeholder: '{"temperature": 0.6, "max_tokens": 512}' },
    { key: 'extraArgs', label: '附加 CLI 参数', type: 'text', default: '', group: '高级', placeholder: '--repeats 2' },
  ],

  async detect() {
    const bin = await which('evalscope');
    if (!bin) {
      return {
        available: false, mode: 'demo', binary: null,
        detail: '未检测到 evalscope 命令，运行将使用演示模式',
        install: 'pip install evalscope',
      };
    }
    const r = await execCapture(bin, ['--version'], { timeoutMs: 30000 });
    return {
      available: true, mode: 'real', binary: bin,
      version: `${(r.stdout + r.stderr).trim().split('\n').pop() || 'unknown'}`,
      detail: '已检测到 EvalScope，可执行真实模型评测',
    };
  },

  async prepare({ config, runDir, dataset, store }) {
    const cfg = { ...DEFAULTS, ...config };
    const datasets = String(cfg.datasets || '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!datasets.length) throw new Error('至少需要配置一个数据集');

    const workDir = path.join(runDir, 'evalscope');
    await ensureDir(workDir);

    const args = ['eval', '--model', String(cfg.model)];
    args.push('--datasets', ...datasets);
    args.push('--eval-type', String(cfg.evalType));
    if (cfg.apiUrl) args.push('--api-url', String(cfg.apiUrl));
    if (cfg.apiKey) args.push('--api-key', String(cfg.apiKey));
    args.push('--limit', String(cfg.limit));
    if (cfg.evalBackend && cfg.evalBackend !== 'Native') args.push('--eval-backend', String(cfg.evalBackend));

    // An attached EvalScope-style dataset directory becomes --dataset-dir.
    let datasetDir = cfg.datasetDir;
    if (!datasetDir && dataset && store) datasetDir = store.datasetDir(dataset.id);
    if (datasetDir) args.push('--dataset-dir', String(datasetDir));

    if (cfg.generationConfig) args.push('--generation-config', String(cfg.generationConfig));
    args.push('--work-dir', workDir, '--no-timestamp');
    if (cfg.extraArgs) args.push(...String(cfg.extraArgs).split(/\s+/).filter(Boolean));

    const displayArgs = args.map((a, i) => (args[i - 1] === '--api-key' ? '***' : a));

    return {
      command: 'evalscope',
      args,
      displayArgs,
      cwd: runDir,
      env: { EVALSCOPE_CACHE: path.join(runDir, '.cache') },
      artifacts: { workDir },
      targets: datasets.map((d) => ({ name: d })),
      secrets: [cfg.apiKey].filter(Boolean),
    };
  },

  async simulate({ config }) {
    const datasets = String(config.datasets || 'gsm8k')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return simulateEval({
      datasets: datasets.length ? datasets : ['gsm8k'],
      limit: Number(config.limit) || 10,
      model: String(config.model || 'demo-model'),
    });
  },

  async parse({ runDir }) {
    const out = { metrics: [], series: [], seriesKeys: [], table: null, report: {} };
    const files = await findReports(runDir);
    const reports = [];

    for (const f of files) {
      if (!f.includes(`${path.sep}reports${path.sep}`) && !f.endsWith('collection_detailed_report.json')) continue;
      try {
        const parsed = JSON.parse(await fsp.readFile(f, 'utf8'));
        if (scoreOf(parsed) === null) continue;
        reports.push({ ...parsed, __file: f });
      } catch {
        /* skip malformed */
      }
    }

    if (!reports.length) return out;

    const rows = reports.map((r) => ({
      dataset: r.dataset_name ?? r.name ?? path.basename(r.__file, '.json'),
      score: Number((scoreOf(r) ?? 0).toFixed(4)),
      num: numOf(r),
      metric: r.metrics?.[0]?.name ?? r.metrics?.[0]?.metric_name ?? 'Score',
    }));
    rows.sort((a, b) => a.dataset.localeCompare(b.dataset));

    const totalNum = rows.reduce((s, r) => s + toNumber(r.num), 0);
    const avgScore = rows.reduce((s, r) => s + r.score, 0) / Math.max(1, rows.length);

    out.metrics = [
      { key: 'score', label: '平均得分', value: Number(avgScore.toFixed(4)), format: 'score' },
      { key: 'datasets', label: '数据集数', value: rows.length, format: 'int' },
      { key: 'samples', label: '评测样本数', value: totalNum, format: 'int' },
      { key: 'model', label: '被测模型', value: reports[0].model_name ?? '-', format: 'text' },
    ];

    const perf = reports.find((r) => r.perf_metrics)?.perf_metrics;
    if (perf && typeof perf === 'object') {
      for (const [k, v] of Object.entries(perf)) {
        if (typeof v === 'number') {
          out.metrics.push({
            key: `perf_${k}`,
            label: k,
            value: Number(v.toFixed(v < 10 ? 3 : 2)),
            format: 'float',
          });
        }
      }
    }

    out.series = rows.map((r, i) => ({ t: i, name: r.dataset, score: r.score }));
    out.seriesKeys = [{ key: 'score', label: '得分', color: '#a78bfa', axis: 'left', kind: 'bars' }];
    out.table = {
      title: '数据集评测结果',
      columns: [
        { key: 'dataset', label: '数据集' },
        { key: 'metric', label: '指标' },
        { key: 'score', label: '得分', align: 'right', format: 'score' },
        { key: 'num', label: '样本数', align: 'right', format: 'int' },
      ],
      rows,
    };
    out.report = {
      model: reports[0].model_name,
      datasets: rows,
      summary: reports.map((r) => ({
        dataset: r.dataset_name,
        score: scoreOf(r),
        num: numOf(r),
        analysis: r.analysis && r.analysis !== 'N/A' ? String(r.analysis).slice(0, 4000) : undefined,
        metrics: r.metrics?.map((m) => ({ name: m.name ?? m.metric_name, score: m.score })),
      })),
      perfMetrics: perf ?? null,
    };
    return out;
  },
};
