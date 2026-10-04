import { api } from '../api.js';
import { confirmDialog, esc, fmtBytes, fmtRelative, modal, toast } from '../ui.js';

const TEMPLATES = {
  'REST 接口清单 (CSV)': {
    filename: 'endpoints.csv',
    engine: 'locust',
    content: 'method,path,weight\nGET,/,3\nGET,/api/items,2\nPOST,/api/orders,1\nGET,/api/users/1,1\n',
  },
  'EvalScope 问答样本 (JSONL)': {
    filename: 'qa.jsonl',
    engine: 'evalscope',
    content: [
      '{"question": "1+1 等于几？", "answer": "2"}',
      '{"question": "中国的首都是？", "answer": "北京"}',
      '{"question": "水的化学式是？", "answer": "H2O"}',
      '',
    ].join('\n'),
  },
  '压测路径 (TXT)': {
    filename: 'paths.txt',
    engine: 'any',
    content: 'GET http://127.0.0.1:8080/health\nGET http://127.0.0.1:8080/api/items\n',
  },
};

export async function render(view) {
  let datasets = (await api.datasets()).datasets;
  let pending = null;

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">数据集</h1>
        <p class="page-desc">上传并管理测试数据。压测类数据集用于生成请求路径，评测类数据集作为 EvalScope 的输入目录。</p>
      </div>
      <button class="btn" id="btn-refresh">↻ 刷新</button>
    </div>

    <div class="split" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div class="card-title">上传数据集</div></div>
        <div class="dropzone" id="drop">
          <div style="font-size:22px;margin-bottom:6px">⬆</div>
          <div>拖拽文件到此处，或 <span style="color:var(--accent)">点击选择文件</span></div>
          <div class="help" style="margin-top:6px">支持 .jsonl / .json / .csv / .tsv / .txt，单文件最大 64MB</div>
          <input type="file" id="file" hidden accept=".jsonl,.json,.csv,.tsv,.txt,.ndjson,.md" />
        </div>

        <div id="pending" style="display:none;margin-top:14px">
          <div class="card" style="background:#0b1120">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px">
              <strong id="p-file" style="font-size:13px"></strong>
              <button class="btn btn-sm btn-ghost" id="p-cancel">移除</button>
            </div>
            <div class="field">
              <label>名称</label>
              <input class="input" id="p-name" />
            </div>
            <div class="field">
              <label>适用引擎</label>
              <select id="p-engine">
                <option value="any">通用</option>
                <option value="locust">Locust</option>
                <option value="jmeter">JMeter</option>
                <option value="evalscope">EvalScope</option>
              </select>
            </div>
            <div class="field" style="margin-bottom:0">
              <label>说明</label>
              <input class="input" id="p-desc" placeholder="可选，例如：生产环境热门接口抓取" />
            </div>
            <button class="btn btn-primary" id="p-save" style="width:100%;margin-top:14px">保存数据集</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">快速模板</div></div>
        <div style="display:flex;flex-direction:column;gap:10px">
          ${Object.entries(TEMPLATES)
            .map(
              ([name, t]) => `<button class="btn" data-tpl="${esc(name)}" style="justify-content:space-between">
                <span>${esc(name)}</span><span class="help">${esc(t.filename)}</span>
              </button>`,
            )
            .join('')}
        </div>
        <div class="help" style="margin-top:14px">
          模板会生成一份可直接使用或修改的示例数据，适合快速体验完整流程。
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">数据集列表</div>
        <span class="card-sub" id="count"></span>
      </div>
      <div id="list"></div>
    </div>`;

  const list = view.querySelector('#list');

  function paint() {
    view.querySelector('#count').textContent = `${datasets.length} 个数据集`;
    if (!datasets.length) {
      list.innerHTML = '<div class="empty">还没有数据集，上传文件或使用快速模板创建。</div>';
      return;
    }
    list.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>名称</th><th>类型</th><th class="num">记录数</th><th class="num">大小</th><th>适用引擎</th><th>创建时间</th><th style="width:190px">操作</th></tr></thead>
      <tbody>${datasets
        .map(
          (d) => `<tr data-ds="${d.id}">
            <td><strong>${esc(d.name)}</strong>
              <div class="help mono">${esc(d.filename)}${d.description ? ` · ${esc(d.description)}` : ''}</div></td>
            <td><span class="tag">${esc(d.type)}</span></td>
            <td class="num">${d.records}</td>
            <td class="num">${fmtBytes(d.sizeBytes)}</td>
            <td>${esc(d.engine === 'any' ? '通用' : d.engine)}</td>
            <td style="color:var(--muted-2)">${fmtRelative(d.createdAt)}</td>
            <td>
              <button class="btn btn-sm btn-ghost" data-act="preview">预览</button>
              <button class="btn btn-sm btn-ghost" data-act="download">下载</button>
              <button class="btn btn-sm btn-ghost" data-act="del">删除</button>
            </td>
          </tr>`,
        )
        .join('')}</tbody>
    </table></div>`;

    list.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const id = btn.closest('[data-ds]').getAttribute('data-ds');
        const ds = datasets.find((d) => d.id === id);
        const act = btn.getAttribute('data-act');
        if (act === 'preview') showPreview(ds);
        else if (act === 'download') {
          const text = await fetch(api.datasetContentUrl(id)).then((r) => r.text());
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
          a.download = ds.filename;
          a.click();
        } else if (act === 'del') {
          const yes = await confirmDialog(`确定删除数据集「${ds.name}」吗？引用它的历史记录会保留但不再显示数据集名称。`, { confirmText: '删除' });
          if (!yes) return;
          await api.deleteDataset(id);
          toast('已删除', 'ok');
          await reload();
        }
      }),
    );
  }

  function showPreview(ds) {
    modal({
      title: `预览 · ${ds.name}`,
      width: 880,
      body: `
        <div class="kv" style="margin-bottom:14px">
          <dt>文件</dt><dd class="mono">${esc(ds.filename)}</dd>
          <dt>类型</dt><dd>${esc(ds.type)}</dd>
          <dt>记录数</dt><dd>${ds.records}</dd>
          <dt>字段</dt><dd>${ds.columns?.length ? ds.columns.map((c) => `<span class="tag">${esc(c)}</span>`).join(' ') : '-'}</dd>
        </div>
        <div class="help" style="margin-bottom:6px">前 5 条记录</div>
        <pre class="code" style="max-height:320px">${esc((ds.preview ?? []).map((p) => JSON.stringify(p)).join('\n') || '（空）')}</pre>`,
    });
  }

  function setPending(file) {
    pending = file;
    view.querySelector('#pending').style.display = 'block';
    view.querySelector('#p-file').textContent = `${file.filename} · ${fmtBytes(file.content.length)}`;
    view.querySelector('#p-name').value = file.name;
    view.querySelector('#p-engine').value = file.engine;
  }

  async function readFile(f) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(f);
    });
  }

  const drop = view.querySelector('#drop');
  const fileInput = view.querySelector('#file');

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    setPending({ filename: f.name, name: f.name.replace(/\.[^.]+$/, ''), engine: 'any', content: await readFile(f) });
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    setPending({ filename: f.name, name: f.name.replace(/\.[^.]+$/, ''), engine: 'any', content: await readFile(f) });
    fileInput.value = '';
  });

  view.querySelector('#p-cancel').addEventListener('click', () => {
    pending = null;
    view.querySelector('#pending').style.display = 'none';
  });

  view.querySelector('#p-save').addEventListener('click', async () => {
    if (!pending) return;
    const btn = view.querySelector('#p-save');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 保存中…';
    try {
      await api.createDataset({
        name: view.querySelector('#p-name').value.trim() || pending.filename,
        filename: pending.filename,
        content: pending.content,
        engine: view.querySelector('#p-engine').value,
        description: view.querySelector('#p-desc').value.trim(),
      });
      toast('数据集已保存', 'ok');
      pending = null;
      view.querySelector('#pending').style.display = 'none';
      view.querySelector('#p-desc').value = '';
      await reload();
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '保存数据集';
    }
  });

  view.querySelectorAll('[data-tpl]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const t = TEMPLATES[btn.getAttribute('data-tpl')];
      setPending({ filename: t.filename, name: t.filename.replace(/\.[^.]+$/, ''), engine: t.engine, content: t.content });
      toast('模板已载入，确认后保存', 'ok');
    }),
  );

  async function reload() {
    datasets = (await api.datasets()).datasets;
    paint();
  }

  view.querySelector('#btn-refresh').addEventListener('click', reload);
  paint();
}
