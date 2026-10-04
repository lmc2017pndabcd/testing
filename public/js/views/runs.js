import { api } from '../api.js';
import { confirmDialog, esc, fmtDuration, fmtRelative, fmtValue, modal, statusPill, toast } from '../ui.js';

export async function render(view, { state, navigate }) {
  const filters = { engine: '', status: '', q: '' };
  const selected = new Set();
  let rows = [];

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">历史记录</h1>
        <p class="page-desc">所有测试任务的执行记录、关键指标与日志，可按引擎、状态与关键词检索，并支持横向对比。</p>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn" id="btn-reload">↻ 刷新</button>
        <button class="btn btn-primary" data-go="/new">＋ 新建测试</button>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">
        <div class="field" style="margin:0">
          <label>引擎</label>
          <select id="f-engine">
            <option value="">全部引擎</option>
            ${state.engines.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin:0">
          <label>状态</label>
          <select id="f-status">
            <option value="">全部状态</option>
            <option value="succeeded">成功</option>
            <option value="running">运行中</option>
            <option value="queued">排队中</option>
            <option value="failed">失败</option>
            <option value="canceled">已取消</option>
          </select>
        </div>
        <div class="field" style="margin:0">
          <label>关键词</label>
          <input class="input" id="f-q" placeholder="名称 / ID / 目标 / 数据集" />
        </div>
      </div>
      <div id="selbar" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border-soft);display:none;align-items:center;gap:10px;flex-wrap:wrap">
        <span id="selcount" style="color:var(--muted);font-size:12.5px"></span>
        <button class="btn btn-sm btn-primary" id="btn-compare">对比选中</button>
        <button class="btn btn-sm btn-ghost" id="btn-clear">清空选择</button>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">运行列表</div>
        <span class="card-sub" id="count">-</span>
      </div>
      <div id="list"><div class="skeleton" style="height:120px"></div></div>
    </div>`;

  const list = view.querySelector('#list');
  const selbar = view.querySelector('#selbar');

  function updateSelbar() {
    view.querySelector('#selcount').textContent = `已选择 ${selected.size} 个任务（最多对比 4 个）`;
    selbar.style.display = selected.size ? 'flex' : 'none';
    view.querySelector('#btn-compare').disabled = selected.size < 2;
  }

  function paint() {
    view.querySelector('#count').textContent = `${rows.length} 条记录`;
    if (!rows.length) {
      list.innerHTML = '<div class="empty">没有符合条件的运行记录。</div>';
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table>
      <thead><tr>
        <th style="width:34px"></th><th>状态</th><th>名称</th><th>引擎</th><th>目标 / 模型</th>
        <th class="num">关键指标</th><th>数据集</th><th>模式</th><th class="num">耗时</th><th>时间</th><th style="width:150px">操作</th>
      </tr></thead>
      <tbody>${rows
        .map(
          (r) => `<tr data-run="${r.id}">
            <td><input type="checkbox" data-check="${r.id}" ${selected.has(r.id) ? 'checked' : ''} /></td>
            <td>${statusPill(r.status)}</td>
            <td><a href="#/runs/${r.id}" style="font-weight:550">${esc(r.name)}</a>
              ${r.tags?.length ? `<div style="margin-top:3px">${r.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</div>` : ''}</td>
            <td>${esc(r.engineName)}</td>
            <td class="mono" style="color:var(--muted)">${esc(r.target || '-')}</td>
            <td class="num">${r.kpi ? `${fmtValue(r.kpi.value, r.kpi.format)} <span style="color:var(--muted-2);font-size:11px">${esc(r.kpi.label)}</span>` : '-'}</td>
            <td style="color:var(--muted-2)">${esc(r.datasetName ?? '-')}</td>
            <td>${r.mode === 'real' ? '<span class="tag tag-good">真实</span>' : r.mode === 'demo' ? '<span class="tag tag-warn">演示</span>' : '<span class="tag">-</span>'}</td>
            <td class="num">${r.durationSec ? fmtDuration(r.durationSec) : '-'}</td>
            <td style="color:var(--muted-2)" title="${esc(r.createdAt)}">${fmtRelative(r.createdAt)}</td>
            <td>
              <button class="btn btn-sm btn-ghost" data-act="view">查看</button>
              <button class="btn btn-sm btn-ghost" data-act="rerun">重跑</button>
              <button class="btn btn-sm btn-ghost" data-act="del">删除</button>
            </td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>`;

    list.querySelectorAll('[data-check]').forEach((cb) =>
      cb.addEventListener('change', () => {
        const id = cb.getAttribute('data-check');
        if (cb.checked) {
          if (selected.size >= 4) {
            cb.checked = false;
            toast('最多同时对比 4 个任务', 'err');
            return;
          }
          selected.add(id);
        } else selected.delete(id);
        updateSelbar();
      }),
    );

    list.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.closest('[data-run]').getAttribute('data-run');
        const run = rows.find((r) => r.id === id);
        const act = btn.getAttribute('data-act');
        if (act === 'view') navigate(`/runs/${id}`);
        else if (act === 'rerun') {
          try {
            const res = await api.rerun(id);
            toast('已重新提交任务', 'ok');
            navigate(`/runs/${res.run.id}`);
          } catch (err) {
            toast(err.message, 'err');
          }
        } else if (act === 'del') {
          const yes = await confirmDialog(`确定删除「${run?.name ?? id}」及其日志与产物吗？该操作不可恢复。`, { confirmText: '删除' });
          if (!yes) return;
          try {
            await api.deleteRun(id);
            toast('已删除', 'ok');
            load();
          } catch (err) {
            toast(err.message, 'err');
          }
        }
      }),
    );
  }

  async function load() {
    list.innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      const data = await api.runs({ ...filters, limit: 200 });
      rows = data.runs;
      paint();
    } catch (err) {
      list.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
    }
  }

  async function showCompare() {
    const ids = [...selected];
    const { runs: picked } = await api.compare(ids);
    if (picked.length < 2) return toast('至少选择两个任务', 'err');

    const metricRows = [];
    const seen = new Set();
    for (const run of picked) {
      for (const m of run.metrics ?? []) {
        const key = `${m.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        metricRows.push(m.label);
      }
    }

    const cell = (run, label) => {
      const m = (run.metrics ?? []).find((x) => x.label === label);
      return m ? fmtValue(m.value, m.format) : '—';
    };

    modal({
      title: `任务对比（${picked.length} 个）`,
      width: 1000,
      body: `<div class="table-wrap"><table>
        <thead><tr><th>指标</th>${picked.map((r) => `<th class="num">${esc(r.name)}<div style="color:var(--muted-2);font-weight:400">${esc(r.engine)} · ${esc(r.mode ?? '-')}</div></th>`).join('')}</tr></thead>
        <tbody>
          <tr><td>状态</td>${picked.map((r) => `<td class="num">${statusPill(r.status)}</td>`).join('')}</tr>
          <tr><td>目标 / 模型</td>${picked.map((r) => `<td class="num mono">${esc(r.config?.host || r.config?.model || '-')}</td>`).join('')}</tr>
          <tr><td>耗时</td>${picked.map((r) => `<td class="num">${r.durationSec ? fmtDuration(r.durationSec) : '-'}</td>`).join('')}</tr>
          ${metricRows.map((label) => `<tr><td>${esc(label)}</td>${picked.map((r) => `<td class="num">${cell(r, label)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table></div>
      ${
        picked.some((r) => r.mode === 'demo')
          ? '<p class="help" style="margin-top:12px;color:#f2d29a">注意：参与对比的任务中包含演示模式数据，不可与真实测量结果直接比较。</p>'
          : ''
      }`,
    });
  }

  view.querySelector('#f-engine').addEventListener('change', (e) => { filters.engine = e.target.value; load(); });
  view.querySelector('#f-status').addEventListener('change', (e) => { filters.status = e.target.value; load(); });
  let qTimer;
  view.querySelector('#f-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { filters.q = e.target.value; load(); }, 300);
  });
  view.querySelector('#btn-reload').addEventListener('click', load);
  view.querySelector('#btn-compare').addEventListener('click', showCompare);
  view.querySelector('#btn-clear').addEventListener('click', () => {
    selected.clear();
    updateSelbar();
    paint();
  });
  view.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => navigate(b.getAttribute('data-go'))));

  updateSelbar();
  await load();
}
