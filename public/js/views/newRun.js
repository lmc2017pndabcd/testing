import { api } from '../api.js';
import { esc, toast } from '../ui.js';

const DATASET_USAGE = {
  locust: '数据集中的 method / path / weight 列会替换“请求路径”，用于生成 locustfile 的任务权重。',
  jmeter: '数据集中的 method / path 列会替换“请求路径”，用于生成 JMX 采样器。',
  evalscope: '数据集目录会作为 --dataset-dir 传给 EvalScope，可放入 jsonl / HuggingFace 格式数据。',
};

export async function render(view, { state, query, navigate }) {
  const datasets = (await api.datasets()).datasets;
  const engines = state.engines;

  let engineId = engines.some((e) => e.id === query.engine) ? query.engine : engines[0].id;
  let config = { ...engines.find((e) => e.id === engineId).defaults };
  let datasetId = '';
  let previewTimer = null;
  let submitting = false;

  const engineOf = (id = engineId) => engines.find((e) => e.id === id);
  const detectionOf = (id = engineId) => state.detection.find((d) => d.id === id) ?? {};

  function visibleFields(eng) {
    return eng.fields.filter((f) => {
      if (!f.dependsOn) return true;
      const list = f.dependsOn.in ?? [];
      return list.includes(String(config[f.dependsOn.key] ?? ''));
    });
  }

  function groupsOf(eng) {
    const out = new Map();
    for (const f of visibleFields(eng)) {
      const g = f.group ?? '参数';
      if (!out.has(g)) out.set(g, []);
      out.get(g).push(f);
    }
    return out;
  }

  function fieldHtml(f) {
    const value = config[f.key] ?? f.default ?? '';
    const common = `data-key="${f.key}" id="f-${f.key}"`;
    let control;
    if (f.type === 'textarea') {
      control = `<textarea ${common} rows="${f.rows ?? 3}" placeholder="${esc(f.placeholder ?? '')}">${esc(value)}</textarea>`;
    } else if (f.type === 'select') {
      control = `<select ${common}>${(f.options ?? [])
        .map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select>`;
    } else {
      const min = f.min !== undefined ? `min="${f.min}"` : '';
      const max = f.max !== undefined ? `max="${f.max}"` : '';
      const step = f.step !== undefined ? `step="${f.step}"` : '';
      control = `<input class="input" type="${f.type === 'number' ? 'number' : f.type === 'password' ? 'password' : 'text'}"
        ${common} ${min} ${max} ${step} value="${esc(value)}" placeholder="${esc(f.placeholder ?? '')}" ${f.secret ? 'autocomplete="new-password"' : ''} />`;
    }
    return `<div class="field">
      <label for="f-${f.key}">${esc(f.label)} ${f.required ? '<span class="req">*</span>' : ''}</label>
      ${control}
      ${f.help ? `<div class="help">${esc(f.help)}</div>` : ''}
    </div>`;
  }

  function layout() {
    const eng = engineOf();
    const det = detectionOf();
    const groups = groupsOf(eng);
    const compatible = datasets.filter((d) => !d.engine || d.engine === 'any' || d.engine === eng.id);
    const selected = datasets.find((d) => d.id === datasetId);

    return `
      <div class="page-head">
        <div>
          <h1 class="page-title">新建测试</h1>
          <p class="page-desc">选择测试引擎并配置参数，平台会自动生成执行脚本、运行任务并归档结果。</p>
        </div>
      </div>

      <div class="grid grid-3" style="margin-bottom:16px">
        ${engines
          .map((e) => {
            const d = state.detection.find((x) => x.id === e.id) ?? {};
            return `<div class="engine-card ${e.id === engineId ? 'selected' : ''}" data-pick="${e.id}">
              <div class="engine-top">
                <div class="engine-name"><span class="engine-badge" style="background:${e.accent}"></span>${esc(e.name)}</div>
                <span class="pill ${d.available ? 'ok' : 'demo'}">${d.available ? '已就绪' : '演示'}</span>
              </div>
              <div class="engine-tagline">${esc(e.tagline)}</div>
              <div class="engine-meta"><span>${esc(d.binary || d.install?.cmd || '')}</span></div>
            </div>`;
          })
          .join('')}
      </div>

      <div class="split">
        <div style="display:flex;flex-direction:column;gap:14px;min-width:0">
          <div class="card">
            <div class="card-head">
              <div class="card-title">${esc(eng.name)} 参数</div>
              <button class="btn btn-ghost btn-sm" id="btn-reset">重置为默认值</button>
            </div>
            ${[...groups.entries()]
              .map(([g, fields]) => `<div class="group-title">${esc(g)}</div>
                ${fields.length > 2 && fields.every((f) => f.type === 'number')
                  ? `<div class="field-row">${fields.map(fieldHtml).join('')}</div>`
                  : fields.map(fieldHtml).join('')}`)
              .join('')}
          </div>

          <div class="card">
            <div class="card-head">
              <div class="card-title">数据集绑定</div>
              <span class="card-sub">可选</span>
            </div>
            <div class="field">
              <label for="dataset">关联数据集</label>
              <select id="dataset">
                <option value="">不使用数据集</option>
                ${compatible
                  .map((d) => `<option value="${esc(d.id)}" ${d.id === datasetId ? 'selected' : ''}>${esc(d.name)} · ${esc(d.type)} · ${d.records} 条</option>`)
                  .join('')}
              </select>
              <div class="help">${esc(DATASET_USAGE[eng.id] ?? '按引擎语义注入数据集。')}</div>
            </div>
            ${
              selected
                ? `<div class="card" style="background:#0b1120;padding:12px">
                    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:8px">
                      <span>${esc(selected.filename)}</span><span>${selected.records} 条记录</span>
                    </div>
                    <pre class="code" style="max-height:150px">${esc(
                      (selected.preview ?? [])
                        .slice(0, 3)
                        .map((p) => JSON.stringify(p))
                        .join('\n'),
                    )}</pre>
                    <button class="btn btn-ghost btn-sm" style="margin-top:8px" data-go="/datasets">管理数据集</button>
                  </div>`
                : `<div class="help">还没有合适的数据集？<a href="#/datasets" style="color:var(--accent)">前往上传 →</a></div>`
            }
          </div>

          <div class="card">
            <div class="card-head"><div class="card-title">运行信息</div></div>
            <div class="field">
              <label for="run-name">任务名称</label>
              <input class="input" id="run-name" placeholder="留空自动生成，例如「下单接口压测 v2」" />
            </div>
            <div class="field">
              <label for="run-tags">标签</label>
              <input class="input" id="run-tags" placeholder="用逗号分隔，例如：回归, v1.4" />
              <div class="help">标签用于历史记录的检索与归类。</div>
            </div>
          </div>
        </div>

        <div style="position:sticky;top:80px;display:flex;flex-direction:column;gap:14px">
          <div class="card">
            <div class="card-head">
              <div class="card-title">执行预览</div>
              <span class="pill ${det.available ? 'ok' : 'demo'}">${det.available ? '真实执行' : '演示模式'}</span>
            </div>
            ${
              det.available
                ? `<div class="help" style="margin-bottom:10px">已检测到 <b>${esc(det.version || det.binary || eng.name)}</b>，将执行真实测试。</div>`
                : `<div class="help" style="margin-bottom:10px;color:#f2d29a">未检测到 ${esc(eng.name)} CLI，本次将以<b>演示模式</b>运行并生成合成数据（非真实测量）。
                   安装命令：<span class="mono">${esc(eng.install?.cmd ?? '')}</span></div>`
            }
            <div class="help" style="margin-bottom:6px">将执行的命令</div>
            <pre class="code" id="cmd-preview">生成中…</pre>
            <div id="files-preview" style="margin-top:10px"></div>
          </div>

          <div class="card">
            <div class="kv" style="margin-bottom:14px">
              <dt>引擎</dt><dd>${esc(eng.name)}</dd>
              <dt>目标</dt><dd>${esc(config.host || config.model || '-')}</dd>
              <dt>数据集</dt><dd>${esc(datasets.find((d) => d.id === datasetId)?.name ?? '未绑定')}</dd>
            </div>
            <button class="btn btn-primary" id="btn-start" style="width:100%;padding:11px">
              ${det.available ? '▶ 启动测试' : '▶ 启动测试（演示模式）'}
            </button>
          </div>
        </div>
      </div>`;
  }

  function collect() {
    const eng = engineOf();
    for (const f of eng.fields) {
      const el = view.querySelector(`#f-${f.key}`);
      if (!el) continue;
      config[f.key] = el.value;
    }
  }

  async function updatePreview() {
    const box = view.querySelector('#cmd-preview');
    const filesBox = view.querySelector('#files-preview');
    if (!box) return;
    try {
      const res = await api.preview({ engine: engineId, config, datasetId: datasetId || null });
      box.textContent = res.command;
      filesBox.innerHTML = (res.files ?? []).length
        ? (res.files ?? [])
            .map(
              (f) => `<details class="accordion"><summary>生成的 ${esc(f.name)} · ${f.content.split('\n').length} 行</summary>
                <div><pre class="code" style="max-height:260px">${esc(f.content)}</pre></div></details>`,
            )
            .join('')
        : '';
    } catch (err) {
      box.textContent = `预览失败：${err.message}`;
      filesBox.innerHTML = '';
    }
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 350);
  }

  function bind() {
    view.querySelectorAll('[data-pick]').forEach((card) =>
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-pick');
        if (id === engineId) return;
        engineId = id;
        config = { ...engineOf(id).defaults };
        datasetId = '';
        paint();
      }),
    );

    view.querySelectorAll('[data-key]').forEach((el) => {
      el.addEventListener('input', () => {
        config[el.getAttribute('data-key')] = el.value;
        schedulePreview();
      });
      el.addEventListener('change', () => {
        config[el.getAttribute('data-key')] = el.value;
        if (engineOf().fields.some((f) => f.dependsOn?.key === el.getAttribute('data-key'))) {
          paint();
          return;
        }
        schedulePreview();
      });
    });

    view.querySelector('#dataset')?.addEventListener('change', (e) => {
      datasetId = e.target.value;
      paint();
    });

    view.querySelector('#btn-reset')?.addEventListener('click', () => {
      config = { ...engineOf().defaults };
      paint();
      toast('已重置为默认参数');
    });

    view.querySelectorAll('[data-go]').forEach((el) =>
      el.addEventListener('click', () => navigate(el.getAttribute('data-go'))),
    );

    view.querySelector('#btn-start')?.addEventListener('click', submit);
    view.querySelector('#run-name')?.addEventListener('input', (e) => {
      view.dataset.name = e.target.value;
    });
  }

  async function submit() {
    if (submitting) return;
    submitting = true;
    collect();
    const btn = view.querySelector('#btn-start');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 提交中…';
    try {
      const res = await api.createRun({
        name: view.querySelector('#run-name')?.value ?? '',
        engine: engineId,
        config,
        datasetId: datasetId || null,
        tags: (view.querySelector('#run-tags')?.value ?? '').split(',').map((t) => t.trim()).filter(Boolean),
      });
      toast('任务已提交，正在跳转…', 'ok');
      navigate(`/runs/${res.run.id}`);
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
      btn.textContent = '▶ 启动测试';
      submitting = false;
    }
  }

  function paint() {
    const nameValue = view.querySelector('#run-name')?.value ?? '';
    const tagsValue = view.querySelector('#run-tags')?.value ?? '';
    view.innerHTML = layout();
    if (nameValue) view.querySelector('#run-name').value = nameValue;
    if (tagsValue) view.querySelector('#run-tags').value = tagsValue;
    bind();
    updatePreview();
  }

  paint();
}
