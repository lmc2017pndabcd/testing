import { api } from './js/api.js';
import { toast } from './js/ui.js';
import * as dashboard from './js/views/dashboard.js';
import * as datasets from './js/views/datasets.js';
import * as newRun from './js/views/newRun.js';
import * as runDetail from './js/views/runDetail.js';
import * as runs from './js/views/runs.js';
import * as settings from './js/views/settings.js';

export const state = {
  engines: [],
  detection: [],
  metaLoaded: false,
};

const routes = [
  { path: '/dashboard', title: '概览', view: dashboard },
  { path: '/new', title: '新建测试', view: newRun },
  { path: '/runs', title: '历史记录', view: runs },
  { path: '/runs/:id', title: '运行详情', view: runDetail },
  { path: '/datasets', title: '数据集', view: datasets },
  { path: '/settings', title: '环境诊断', view: settings },
];

function matchRoute(path) {
  const ap = path.split('/').filter(Boolean);
  for (const route of routes) {
    const rp = route.path.split('/').filter(Boolean);
    if (rp.length !== ap.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i += 1) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (rp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { route, params };
  }
  return null;
}

export async function loadMeta({ force = false } = {}) {
  if (state.metaLoaded && !force) return state;
  const { engines, detection } = await api.engines();
  state.engines = engines;
  state.detection = detection;
  state.metaLoaded = true;
  renderEnvChrome();
  return state;
}

export function detectionFor(engineId) {
  return state.detection.find((d) => d.id === engineId) ?? null;
}

function renderEnvChrome() {
  const pills = document.getElementById('engine-pills');
  pills.innerHTML = state.detection
    .map((d) => {
      const cls = d.available ? 'ok' : 'demo';
      return `<span class="pill ${cls}" title="${d.detail ?? ''}">${d.available ? '●' : '○'} <b>${d.name}</b> ${d.available ? '就绪' : '演示'}</span>`;
    })
    .join('');

  const mini = document.getElementById('env-mini');
  const ready = state.detection.filter((d) => d.available).length;
  mini.innerHTML = `<span class="dot ${ready ? 'dot-ok' : 'dot-demo'}"></span><span>${ready}/${state.detection.length} 引擎就绪</span>`;
}

export function navigate(path) {
  if (location.hash === `#${path}`) render();
  else location.hash = `#${path}`;
}

async function render() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [path, queryStr] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryStr ?? ''));
  const matched = matchRoute(path);
  const view = document.getElementById('view');
  const crumb = document.getElementById('crumb');

  if (!matched) {
    crumb.textContent = '未找到页面';
    view.innerHTML = '<div class="card empty">页面不存在，<a href="#/dashboard" style="color:var(--accent)">返回概览</a></div>';
    return;
  }

  document.querySelectorAll('.nav-item').forEach((n) => {
    const target = n.getAttribute('data-route');
    n.classList.toggle('active', path === target || (target !== '/dashboard' && path.startsWith(target)));
  });

  crumb.textContent = matched.route.title;
  view.innerHTML = '<div class="skeleton" style="height:120px"></div>';

  try {
    await loadMeta();
    view.innerHTML = '';
    await matched.route.view.render(view, { params: matched.params, query, state, navigate });
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="card-title" style="color:var(--danger)">加载失败</div>
      <p style="color:var(--muted)">${String(err.message ?? err)}</p></div>`;
  }
}

document.getElementById('btn-new-run').addEventListener('click', () => navigate('/new'));
document.getElementById('btn-refresh').addEventListener('click', () => {
  state.metaLoaded = false;
  render();
});
window.addEventListener('hashchange', render);

render();
