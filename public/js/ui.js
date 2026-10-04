const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);

export const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('zh-CN') : '-');

export function fmtValue(value, format) {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  switch (format) {
    case 'int': return fmtInt(value);
    case 'float': return Number.isFinite(n) ? (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2)) : String(value);
    case 'percent': return `${Number.isFinite(n) ? n.toFixed(2) : value}%`;
    case 'score': return Number.isFinite(n) ? n.toFixed(4) : String(value);
    case 'ms': return `${fmtInt(value)}<small> ms</small>`;
    case 'bytes': return fmtBytes(n);
    default: return esc(value);
  }
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}

export function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '-';
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtRelative(iso) {
  if (!iso) return '-';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(diff)) return '-';
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return fmtTime(iso);
}

const STATUS_TEXT = {
  queued: ['排队中', 'status-queued'],
  running: ['运行中', 'status-running'],
  succeeded: ['成功', 'status-succeeded'],
  failed: ['失败', 'status-failed'],
  canceled: ['已取消', 'status-canceled'],
};

export function statusPill(status) {
  const [text, cls] = STATUS_TEXT[status] ?? [status, 'status-queued'];
  const dot = status === 'running' ? '<span class="dot dot-run"></span>' : '';
  return `<span class="status ${cls}">${dot}${esc(text)}</span>`;
}

export function modeTag(mode) {
  if (mode === 'real') return '<span class="tag tag-good">真实执行</span>';
  if (mode === 'demo') return '<span class="tag tag-warn">演示模式</span>';
  return '<span class="tag">待运行</span>';
}

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  root.append(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, kind === 'err' ? 5200 : 3000);
}

export function modal({ title, body, footer = '', width }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-close>
      <div class="modal" ${width ? `style="max-width:${width}px"` : ''}>
        <div class="modal-head">
          <strong>${esc(title)}</strong>
          <button class="btn btn-ghost btn-sm" data-close>关闭</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-body" style="border-top:1px solid var(--border-soft);padding-top:14px">${footer}</div>` : ''}
      </div>
    </div>`;
  root.querySelectorAll('[data-close]').forEach((n) =>
    n.addEventListener('click', (e) => {
      if (e.target === n) root.innerHTML = '';
    }),
  );
  const esc_ = (e) => {
    if (e.key === 'Escape') {
      root.innerHTML = '';
      document.removeEventListener('keydown', esc_);
    }
  };
  document.addEventListener('keydown', esc_);
  return root;
}

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

export function confirmDialog(message, { danger = true, confirmText = '确认' } = {}) {
  return new Promise((resolve) => {
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onEsc);
        resolve(false);
      }
    };
    document.addEventListener('keydown', onEsc);
    const root = modal({
      title: '请确认',
      body: `<p style="margin:0;color:var(--muted);line-height:1.7">${esc(message)}</p>`,
      footer: `<div style="display:flex;gap:10px;justify-content:flex-end">
        <button class="btn" data-cancel>取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>
      </div>`,
    });
    root.querySelector('[data-cancel]').onclick = () => { document.removeEventListener('keydown', onEsc); closeModal(); resolve(false); };
    root.querySelector('[data-ok]').onclick = () => { document.removeEventListener('keydown', onEsc); closeModal(); resolve(true); };
    root.querySelector('.modal-head [data-close]')?.addEventListener('click', () => {
      document.removeEventListener('keydown', onEsc);
      resolve(false);
    });
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) {
        document.removeEventListener('keydown', onEsc);
        resolve(false);
      }
    });
  });
}

export function kpiCard({ label, value, format = 'int', hint = '', accent }) {
  return `<div class="card kpi">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value" ${accent ? `style="color:${accent}"` : ''}>${fmtValue(value, format)}</div>
    ${hint ? `<div class="kpi-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

export function metricCards(metrics = []) {
  return metrics
    .map((m) => `<div class="card kpi">
      <div class="kpi-label">${esc(m.label)}</div>
      <div class="kpi-value">${fmtValue(m.value, m.format)}</div>
    </div>`)
    .join('');
}

export function dataTable(table, { empty = '暂无数据' } = {}) {
  if (!table || !table.rows?.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<div class="table-wrap"><table>
    <thead><tr>${table.columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${table.rows
      .map((r) => `<tr>${table.columns
        .map((c) => `<td class="${c.align === 'right' ? 'num' : ''} ${c.mono ? 'mono' : ''}">${fmtValue(r[c.key], c.format)}</td>`)
        .join('')}</tr>`)
      .join('')}</tbody>
  </table></div>`;
}

export function copyText(text, label = '已复制到剪贴板') {
  navigator.clipboard?.writeText(text).then(
    () => toast(label, 'ok'),
    () => toast('复制失败，请手动选择文本', 'err'),
  );
}

export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
