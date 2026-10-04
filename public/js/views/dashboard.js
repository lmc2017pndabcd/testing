import { api } from '../api.js';
import { miniBars } from '../charts.js';
import { esc, fmtDuration, fmtInt, fmtRelative, kpiCard, statusPill } from '../ui.js';

export async function render(view, { state, navigate }) {
  const { stats, recent } = await api.stats();
  const engines = state.engines;
  const detection = new Map(stats.detection.map((d) => [d.id, d]));

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">测试概览</h1>
        <p class="page-desc">统一编排 EvalScope 模型评测、Locust 与 JMeter 性能压测，集中管理数据集与历史记录。</p>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn" data-go="/datasets">数据集管理</button>
        <button class="btn btn-primary" data-go="/new">＋ 新建测试</button>
      </div>
    </div>

    <div class="grid grid-4" style="margin-bottom:16px">
      ${kpiCard({ label: '累计运行', value: stats.totalRuns, hint: `运行中 ${stats.running} 个` })}
      ${kpiCard({ label: '成功率', value: stats.successRate, format: 'percent', hint: `失败 ${stats.failed} 次`, accent: stats.successRate >= 90 ? 'var(--success)' : undefined })}
      ${kpiCard({ label: '压测总请求', value: stats.totalRequests, hint: '性能类任务累计' })}
      ${kpiCard({ label: '数据集', value: stats.datasetCount, hint: '已上传可用数据' })}
    </div>

    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card">
        <div class="card-head">
          <div class="card-title">支持的测试引擎</div>
          <span class="card-sub">点击卡片直接发起测试</span>
        </div>
        <div class="grid" style="gap:10px">
          ${engines
            .map((e) => {
              const d = detection.get(e.id) ?? {};
              const runsCount = stats.byEngine.find((b) => b.engine === e.id)?.runs ?? 0;
              return `<div class="engine-card" data-engine="${e.id}" style="cursor:pointer">
                <div class="engine-top">
                  <div class="engine-name"><span class="engine-badge" style="background:${e.accent}"></span>${esc(e.name)}</div>
                  <span class="pill ${d.available ? 'ok' : 'demo'}">${d.available ? '已就绪' : '演示模式'}</span>
                </div>
                <div class="engine-tagline">${esc(e.tagline)}</div>
                <div class="engine-meta">
                  <span>${esc(d.version || d.detail || '')}</span>
                  <span>历史运行 ${fmtInt(runsCount)} 次 · ${esc(e.install?.cmd ?? '')}</span>
                </div>
              </div>`;
            })
            .join('')}
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <div class="card-head">
            <div class="card-title">近 14 天运行趋势</div>
            <span class="card-sub">共 ${fmtInt(stats.byDay.reduce((s, d) => s + d.count, 0))} 次</span>
          </div>
          <div id="trend"></div>
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">引擎分布</div></div>
          <div style="display:flex;flex-direction:column;gap:12px">
            ${stats.byEngine
              .map((b) => {
                const eng = engines.find((e) => e.id === b.engine);
                const pct = stats.totalRuns ? Math.round((b.runs / stats.totalRuns) * 100) : 0;
                return `<div>
                  <div class="bar-row"><span>${esc(eng?.name ?? b.engine)}</span><span style="color:var(--muted-2)">${b.runs} 次 · ${pct}%</span></div>
                  <div class="bar-track"><i style="width:${pct}%;background:${eng?.accent ?? 'var(--accent)'}"></i></div>
                </div>`;
              })
              .join('')}
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">最近运行</div>
        <button class="btn btn-ghost btn-sm" data-go="/runs">查看全部 →</button>
      </div>
      ${
        recent.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>状态</th><th>名称</th><th>引擎</th><th>目标 / 模型</th><th class="num">关键指标</th><th>模式</th><th class="num">耗时</th><th>时间</th></tr></thead>
              <tbody>${recent
                .map(
                  (r) => `<tr class="clickable" data-run="${r.id}">
                    <td>${statusPill(r.status)}</td>
                    <td>${esc(r.name)}</td>
                    <td>${esc(r.engineName)}</td>
                    <td class="mono" style="color:var(--muted)">${esc(r.target || '-')}</td>
                    <td class="num">${r.kpi ? `${fmtInt(r.kpi.value)} <span style="color:var(--muted-2)">${esc(r.kpi.label)}</span>` : '-'}</td>
                    <td>${r.mode === 'real' ? '<span class="tag tag-good">真实</span>' : r.mode === 'demo' ? '<span class="tag tag-warn">演示</span>' : '<span class="tag">-</span>'}</td>
                    <td class="num">${r.durationSec ? fmtDuration(r.durationSec) : '-'}</td>
                    <td style="color:var(--muted-2)">${fmtRelative(r.createdAt)}</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<div class="empty">还没有运行记录，点击「新建测试」发起第一次测试。</div>'
      }
    </div>`;

  miniBars(view.querySelector('#trend'), { points: stats.byDay, key: 'count', height: 96 });

  view.querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => navigate(b.getAttribute('data-go'))),
  );
  view.querySelectorAll('[data-engine]').forEach((card) =>
    card.addEventListener('click', () => navigate(`/new?engine=${card.getAttribute('data-engine')}`)),
  );
  view.querySelectorAll('[data-run]').forEach((row) =>
    row.addEventListener('click', () => navigate(`/runs/${row.getAttribute('data-run')}`)),
  );
}
