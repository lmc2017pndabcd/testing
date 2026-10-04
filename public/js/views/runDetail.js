import { api } from '../api.js';
import { barChart, lineChart } from '../charts.js';
import {
  confirmDialog,
  copyText,
  dataTable,
  downloadText,
  esc,
  fmtDuration,
  fmtTime,
  metricCards,
  modal,
  modeTag,
  statusPill,
  toast,
} from '../ui.js';

let activeStream = null;

export async function render(view, { params, state, navigate }) {
  if (activeStream) {
    activeStream.close();
    activeStream = null;
  }

  let run = null;
  try {
    run = (await api.run(params.id)).run;
  } catch (err) {
    view.innerHTML = `<div class="card empty">运行记录不存在或已删除：${esc(err.message)}
      <div style="margin-top:12px"><a href="#/runs" style="color:var(--accent)">返回历史记录</a></div></div>`;
    return;
  }

  const engine = state.engines.find((e) => e.id === run.engine);
  const terminal = ['succeeded', 'failed', 'canceled'].includes(run.status);

  view.innerHTML = `
    <div class="page-head">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
          <h1 class="page-title" style="margin:0">${esc(run.name)}</h1>
          <span id="status-pill">${statusPill(run.status)}</span>
          ${modeTag(run.mode)}
        </div>
        <p class="page-desc mono">${esc(run.id)} · ${esc(engine?.name ?? run.engine)} · 创建于 ${fmtTime(run.createdAt)}</p>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" data-go="/runs">← 返回</button>
        <button class="btn btn-ghost btn-sm" id="btn-export">导出 JSON</button>
        <button class="btn btn-ghost btn-sm" id="btn-logfile">下载日志</button>
        <button class="btn btn-sm" id="btn-rerun">重跑</button>
        ${terminal ? '' : '<button class="btn btn-danger btn-sm" id="btn-cancel">取消运行</button>'}
      </div>
    </div>

    ${run.error ? `<div class="card" style="border-color:rgba(239,107,107,.35);margin-bottom:14px">
      <div class="card-title" style="color:#ffb1b1">执行失败</div>
      <pre class="code" style="margin-top:8px">${esc(run.error)}</pre></div>` : ''}

    <div class="card" id="progress-card" style="margin-bottom:14px;${terminal ? 'display:none' : ''}">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <span id="phase" style="font-size:13px">${esc(run.phase ?? '准备中')}</span>
        <span id="pct" style="color:var(--muted);font-variant-numeric:tabular-nums">${Math.round(run.progress ?? 0)}%</span>
      </div>
      <div class="progress"><i id="bar" style="width:${Math.min(100, run.progress ?? 0)}%"></i></div>
    </div>

    <div class="grid grid-4" id="kpis" style="margin-bottom:14px">
      ${run.metrics?.length ? metricCards(run.metrics) : '<div class="card empty" style="grid-column:1/-1">暂无指标数据</div>'}
    </div>

    <div class="split" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head">
          <div class="card-title">${run.seriesKeys?.some((k) => k.kind === 'bars') ? '各数据集得分' : '性能趋势'}</div>
          <div class="legend">
            ${(run.seriesKeys ?? []).map((k) => `<span><i style="background:${k.color}"></i>${esc(k.label)}</span>`).join('')}
          </div>
        </div>
        <div id="chart"></div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">任务信息</div></div>
        <dl class="kv">
          <dt>引擎</dt><dd>${esc(engine?.name ?? run.engine)}</dd>
          <dt>执行模式</dt><dd>${run.mode === 'real' ? '真实执行' : run.mode === 'demo' ? '演示模式（合成数据）' : '待运行'}</dd>
          <dt>开始时间</dt><dd>${fmtTime(run.startedAt)}</dd>
          <dt>结束时间</dt><dd>${fmtTime(run.finishedAt)}</dd>
          <dt>耗时</dt><dd>${run.durationSec ? fmtDuration(run.durationSec) : '-'}</dd>
          <dt>数据集</dt><dd>${esc(run.datasetName ?? '未绑定')}</dd>
          <dt>标签</dt><dd>${run.tags?.length ? run.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ') : '-'}</dd>
        </dl>
        <div style="margin-top:14px">
          <div class="help" style="margin-bottom:6px">执行命令</div>
          <pre class="code" style="max-height:120px">${esc(run.command ?? '（待生成）')}</pre>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px" id="btn-copy-cmd">复制命令</button>
          <button class="btn btn-ghost btn-sm" style="margin-top:8px" id="btn-cfg">查看完整配置</button>
        </div>
      </div>
    </div>

    ${
      run.table
        ? `<div class="card" style="margin-bottom:14px">
            <div class="card-head"><div class="card-title">${esc(run.table.title ?? '明细')}</div>
              <span class="card-sub">${run.table.rows.length} 行</span></div>
            ${dataTable(run.table)}
          </div>`
        : ''
    }

    <div class="split">
      <div class="card">
        <div class="card-head">
          <div class="card-title">执行日志 <span class="dot ${terminal ? 'dot-ok' : 'dot-run'}"></span></div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm btn-ghost" data-level="">全部</button>
            <button class="btn btn-sm btn-ghost" data-level="warn">警告</button>
            <button class="btn btn-sm btn-ghost" data-level="error">错误</button>
            <button class="btn btn-sm btn-ghost" id="btn-copy-log">复制</button>
          </div>
        </div>
        <div class="console" id="console"></div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <div class="card-head"><div class="card-title">产物文件</div></div>
          <div id="artifacts" class="help">加载中…</div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">原始报告</div>
            <button class="btn btn-sm btn-ghost" id="btn-copy-report">复制 JSON</button></div>
          <pre class="code" id="report" style="max-height:280px">${esc(JSON.stringify(run.report ?? {}, null, 2))}</pre>
        </div>
      </div>
    </div>`;

  /* --------------------------------------------------------------- charts */
  const chartBox = view.querySelector('#chart');
  if (run.series?.length && run.seriesKeys?.length) {
    if (run.seriesKeys.some((k) => k.kind === 'bars')) {
      barChart(chartBox, {
        rows: run.series.map((p) => ({ label: p.name, score: p.score })),
        valueKey: 'score',
        labelKey: 'label',
        color: run.seriesKeys[0].color,
        height: 260,
      });
    } else {
      lineChart(chartBox, { points: run.series, keys: run.seriesKeys, height: 280 });
    }
  } else {
    chartBox.innerHTML = '<div class="empty">暂无时序数据</div>';
  }

  /* ----------------------------------------------------------------- logs */
  const consoleEl = view.querySelector('#console');
  const allLines = [];
  let levelFilter = '';
  let pinned = true;

  const lineHtml = (l) =>
    `<div class="log-line log-${esc(l.level ?? 'info')}" data-level="${esc(l.level ?? 'info')}">
      <span class="lt">${esc(String(l.t ?? '').slice(11, 19))}</span>
      <span class="lv">${esc((l.level ?? 'info').toUpperCase())}</span>
      <span>${esc(l.text)}</span>
    </div>`;

  function paintLogs() {
    const shown = levelFilter
      ? allLines.filter((l) => (levelFilter === 'warn' ? ['warn', 'error'].includes(l.level) : l.level === levelFilter))
      : allLines;
    consoleEl.innerHTML = shown.length ? shown.map(lineHtml).join('') : '<div class="help">暂无日志</div>';
    if (pinned) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  consoleEl.addEventListener('scroll', () => {
    pinned = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 30;
  });

  function push(entry) {
    allLines.push(entry);
    if (allLines.length > 5000) allLines.splice(0, allLines.length - 5000);
    if (levelFilter && !(levelFilter === 'warn' ? ['warn', 'error'].includes(entry.level) : entry.level === levelFilter)) return;
    consoleEl.insertAdjacentHTML('beforeend', lineHtml(entry));
    if (pinned) consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  view.querySelectorAll('[data-level]').forEach((btn) =>
    btn.addEventListener('click', () => {
      levelFilter = btn.getAttribute('data-level');
      view.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('btn-primary', b === btn && !!levelFilter));
      paintLogs();
    }),
  );

  /* ------------------------------------------------------------ artifacts */
  api
    .runArtifacts(run.id)
    .then(({ files }) => {
      view.querySelector('#artifacts').innerHTML = files.length
        ? `<div class="table-wrap"><table><tbody>${files
            .map((f) => `<tr><td class="mono" style="font-size:11.5px">${esc(f.name)}</td><td class="num">${(f.size / 1024).toFixed(1)} KB</td></tr>`)
            .join('')}</tbody></table></div>`
        : '<div class="help">暂无产物文件</div>';
    })
    .catch(() => {
      view.querySelector('#artifacts').innerHTML = '<div class="help">读取失败</div>';
    });

  /* ------------------------------------------------------------- actions */
  const refresh = () => render(view, { params, state, navigate });
  view.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.getAttribute('data-go'))));
  view.querySelector('#btn-export').addEventListener('click', () =>
    downloadText(`${run.id}.json`, JSON.stringify(run, null, 2)),
  );
  view.querySelector('#btn-logfile').addEventListener('click', async () => {
    downloadText(`${run.id}.log`, await api.runLogs(run.id), 'text/plain');
  });
  view.querySelector('#btn-copy-cmd').addEventListener('click', () => copyText(run.command ?? '', '命令已复制'));
  view.querySelector('#btn-copy-report').addEventListener('click', () =>
    copyText(JSON.stringify(run.report ?? {}, null, 2), '报告 JSON 已复制'),
  );
  view.querySelector('#btn-copy-log').addEventListener('click', () => copyText(allLines.map((l) => l.text).join('\n'), '日志已复制'));
  view.querySelector('#btn-cfg').addEventListener('click', () => {
    modal({
      title: '完整配置',
      body: `<pre class="code" style="max-height:60vh">${esc(JSON.stringify(run.config ?? {}, null, 2))}</pre>`,
    });
  });
  view.querySelector('#btn-rerun').addEventListener('click', async () => {
    try {
      const res = await api.rerun(run.id);
      toast('已重新提交任务', 'ok');
      navigate(`/runs/${res.run.id}`);
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  view.querySelector('#btn-cancel')?.addEventListener('click', async () => {
    const yes = await confirmDialog('确定取消该任务吗？正在运行的进程会被终止。', { confirmText: '取消任务' });
    if (!yes) return;
    await api.cancelRun(run.id);
    toast('已发送取消请求');
  });

  /* ------------------------------------------------------- live streaming */
  if (terminal) {
    const text = await api.runLogs(run.id);
    for (const line of text.split('\n').filter(Boolean)) {
      const m = /^(\S+) \[(\w+)\] ([\s\S]*)$/.exec(line);
      allLines.push(m ? { t: m[1], level: m[2], text: m[3] } : { t: '', level: 'info', text: line });
    }
    paintLogs();
    return;
  }

  const es = new EventSource(api.logStreamUrl(run.id));
  activeStream = es;
  es.addEventListener('log', (e) => push(JSON.parse(e.data)));
  es.addEventListener('progress', (e) => {
    const { progress, phase } = JSON.parse(e.data);
    if (progress != null) view.querySelector('#bar').style.width = `${Math.min(100, progress)}%`;
    if (progress != null) view.querySelector('#pct').textContent = `${Math.round(progress)}%`;
    if (phase) view.querySelector('#phase').textContent = phase;
  });
  es.addEventListener('status', (e) => {
    const data = JSON.parse(e.data);
    const box = view.querySelector('#status-pill');
    if (data.status && box) box.innerHTML = statusPill(data.status);
  });
  es.addEventListener('done', () => {
    es.close();
    activeStream = null;
    toast('任务已结束，正在刷新结果…', 'ok');
    setTimeout(refresh, 400);
  });
  es.onerror = () => {
    /* the browser retries automatically */
  };
}
