/**
 * Minimal canvas charting: multi-axis line chart and a categorical bar chart.
 * No dependencies, DPR-aware, with hover tooltips.
 */

const PAD = { t: 16, r: 56, b: 28, l: 52 };

/** Rounded-rect path with a fallback for engines lacking ctx.roundRect. */
function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, radius);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function setup(container, height) {
  container.classList.add('chart-box');
  container.innerHTML = '<canvas></canvas><div class="chart-tip"></div>';
  const canvas = container.querySelector('canvas');
  const tip = container.querySelector('.chart-tip');
  const ctx = canvas.getContext('2d');
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(240, container.clientWidth);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return w;
  };
  return { canvas, ctx, tip, resize };
}

function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(v));
  const norm = v / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function lineChart(container, { points = [], keys = [], height = 250, yUnit = '' } = {}) {
  if (!points.length || !keys.length) {
    container.innerHTML = '<div class="empty">暂无时序数据</div>';
    return;
  }
  const { canvas, ctx, tip, resize } = setup(container, height);
  const leftKeys = keys.filter((k) => k.axis !== 'right');
  const rightKeys = keys.filter((k) => k.axis === 'right');
  const hasRight = rightKeys.length > 0;
  const pad = { ...PAD, r: hasRight ? PAD.r : 20 };
  let hover = -1;

  const maxOf = (list) => niceMax(Math.max(...points.map((p) => Math.max(...list.map((k) => Number(p[k.key]) || 0))), 0));
  const leftMax = maxOf(leftKeys.length ? leftKeys : rightKeys);
  const rightMax = hasRight ? maxOf(rightKeys) : leftMax;

  function geom(w) {
    const n = points.length;
    const x = (i) => pad.l + (n === 1 ? (w - pad.l - pad.r) / 2 : (i / (n - 1)) * (w - pad.l - pad.r));
    const yL = (v) => height - pad.b - ((Number(v) || 0) / leftMax) * (height - pad.t - pad.b);
    const yR = (v) => height - pad.b - ((Number(v) || 0) / rightMax) * (height - pad.t - pad.b);
    return { x, yL, yR };
  }

  function draw() {
    const w = resize();
    const { x, yL, yR } = geom(w);
    ctx.clearRect(0, 0, w, height);

    // grid + axis labels
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 4; g += 1) {
      const y = pad.t + ((height - pad.t - pad.b) * g) / 4;
      ctx.strokeStyle = 'rgba(30,42,64,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad.l, y + 0.5);
      ctx.lineTo(w - pad.r, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#62708c';
      ctx.textAlign = 'right';
      const lv = leftMax * (1 - g / 4);
      ctx.fillText(lv >= 1000 ? `${(lv / 1000).toFixed(1)}k` : lv.toFixed(lv < 10 ? 1 : 0), pad.l - 8, y);
      if (hasRight) {
        ctx.textAlign = 'left';
        const rv = rightMax * (1 - g / 4);
        ctx.fillText(rv >= 1000 ? `${(rv / 1000).toFixed(1)}k` : rv.toFixed(rv < 10 ? 1 : 0), w - pad.r + 8, y);
      }
    }

    // x labels
    ctx.fillStyle = '#62708c';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.ceil(points.length / 8));
    points.forEach((p, i) => {
      if (i % step === 0 || i === points.length - 1) ctx.fillText(String(p.t), x(i), height - pad.b + 14);
    });

    // series
    for (const k of keys) {
      const y = k.axis === 'right' ? yR : yL;
      if (k.kind === 'bars') continue;
      ctx.strokeStyle = k.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      points.forEach((p, i) => {
        const px = x(i);
        const py = y(p[k.key]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();

      ctx.fillStyle = `${k.color}18`;
      ctx.beginPath();
      ctx.moveTo(x(0), height - pad.b);
      points.forEach((p, i) => ctx.lineTo(x(i), y(p[k.key])));
      ctx.lineTo(x(points.length - 1), height - pad.b);
      ctx.closePath();
      ctx.fill();
    }

    if (hover >= 0 && hover < points.length) {
      const hx = x(hover);
      ctx.strokeStyle = 'rgba(140,170,220,0.4)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.t);
      ctx.lineTo(hx, height - pad.b);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const k of keys) {
        const y = k.axis === 'right' ? yR : yL;
        ctx.fillStyle = k.color;
        ctx.beginPath();
        ctx.arc(hx, y(points[hover][k.key]), 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      const p = points[hover];
      tip.innerHTML = `<b>t = ${escHtml(p.t)}s${yUnit}</b>${keys
        .map((k) => `<div><span style="color:${k.color}">${escHtml(k.label)}</span><span>${fmtNum(p[k.key])}</span></div>`)
        .join('')}`;
      tip.style.left = `${Math.min(Math.max(hx, 90), w - 90)}px`;
      tip.style.top = `${pad.t + 6}px`;
      tip.classList.add('on');
    } else {
      tip.classList.remove('on');
    }
  }

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const { x } = geom(w);
    const mx = e.clientX - rect.left;
    let best = -1;
    let bestD = Infinity;
    points.forEach((_, i) => {
      const d = Math.abs(x(i) - mx);
      if (d < bestD) { bestD = d; best = i; }
    });
    hover = bestD < 40 ? best : -1;
    draw();
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', () => { hover = -1; draw(); });

  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(container);
}

export function barChart(container, { rows = [], valueKey = 'value', labelKey = 'label', height = 230, color = '#4f9cf9' } = {}) {
  if (!rows.length) {
    container.innerHTML = '<div class="empty">暂无数据</div>';
    return;
  }
  const { canvas, ctx, tip, resize } = setup(container, height);
  const pad = { t: 26, r: 16, b: 46, l: 16 };
  const max = niceMax(Math.max(...rows.map((r) => Number(r[valueKey]) || 0)));
  let hover = -1;

  function draw() {
    const w = resize();
    ctx.clearRect(0, 0, w, height);
    const n = rows.length;
    const slot = (w - pad.l - pad.r) / n;
    const bw = Math.min(56, slot * 0.6);

    ctx.font = '11px -apple-system, system-ui, sans-serif';
    rows.forEach((r, i) => {
      const v = Number(r[valueKey]) || 0;
      const h = ((height - pad.t - pad.b) * v) / max;
      const x = pad.l + slot * i + (slot - bw) / 2;
      const y = height - pad.b - h;
      const grd = ctx.createLinearGradient(0, y, 0, height - pad.b);
      grd.addColorStop(0, hover === i ? color : `${color}cc`);
      grd.addColorStop(1, `${color}33`);
      ctx.fillStyle = grd;
      roundedRect(ctx, x, y, bw, Math.max(2, h), 5);
      ctx.fill();

      ctx.fillStyle = '#c9d6ea';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(fmtNum(v), x + bw / 2, y - 6);

      ctx.fillStyle = '#62708c';
      ctx.textBaseline = 'top';
      const label = String(r[labelKey] ?? '');
      ctx.fillText(label.length > 14 ? `${label.slice(0, 13)}…` : label, x + bw / 2, height - pad.b + 10);
    });
  }

  const onMove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const slot = (w - pad.l - pad.r) / rows.length;
    const idx = Math.floor((e.clientX - rect.left - pad.l) / slot);
    const next = idx >= 0 && idx < rows.length ? idx : -1;
    if (next !== hover) {
      hover = next;
      draw();
    }
    if (hover >= 0) {
      const r = rows[hover];
      tip.innerHTML = `<b>${escHtml(String(r[labelKey]))}</b>${Object.entries(r)
        .filter(([k]) => k !== labelKey)
        .map(([k, v]) => `<div><span>${escHtml(k)}</span><span>${fmtNum(v)}</span></div>`)
        .join('')}`;
      const slotW = (w - pad.l - pad.r) / rows.length;
      tip.style.left = `${Math.min(Math.max(pad.l + slotW * hover + slotW / 2, 100), w - 100)}px`;
      tip.style.top = '12px';
      tip.classList.add('on');
    } else tip.classList.remove('on');
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', () => { hover = -1; draw(); tip.classList.remove('on'); });

  draw();
  new ResizeObserver(() => draw()).observe(container);
}

export function miniBars(container, { points = [], key = 'count', height = 70, color = '#4f9cf9' } = {}) {
  if (!points.length) { container.innerHTML = ''; return; }
  const { ctx, resize } = setup(container, height);
  container.querySelector('.chart-tip')?.remove();
  const max = Math.max(...points.map((p) => Number(p[key]) || 0), 1);
  const w = resize();
  const bw = (w - 4) / points.length;
  ctx.clearRect(0, 0, w, height);
  points.forEach((p, i) => {
    const v = Number(p[key]) || 0;
    const h = Math.max(v > 0 ? 3 : 1, (v / max) * (height - 14));
    ctx.fillStyle = v > 0 ? color : '#1b2437';
    roundedRect(ctx, i * bw + 1, height - 12 - h, Math.max(2, bw - 3), h, 3);
    ctx.fill();
  });
}

function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '-');
  if (Math.abs(n) >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return String(Number(n.toFixed(n < 10 ? 2 : 1)));
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
