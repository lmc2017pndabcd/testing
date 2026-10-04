import { api } from '../api.js';
import { copyText, esc, toast } from '../ui.js';

export async function render(view, { state }) {
  const { stats, env } = await api.stats();
  const engines = state.engines;
  const detection = new Map(stats.detection.map((d) => [d.id, d]));

  view.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">环境诊断</h1>
        <p class="page-desc">检测各测试引擎的可用性。未安装的工具会以演示模式运行，避免阻塞流程验证。</p>
      </div>
      <button class="btn" id="btn-detect">↻ 重新检测</button>
    </div>

    <div class="card" style="margin-bottom:14px">
      <div class="card-head"><div class="card-title">引擎可用性</div></div>
      <div class="table-wrap"><table>
        <thead><tr><th>引擎</th><th>状态</th><th>版本 / 路径</th><th>说明</th><th style="width:230px">安装命令</th></tr></thead>
        <tbody>${engines
          .map((e) => {
            const d = detection.get(e.id) ?? {};
            return `<tr>
              <td><strong>${esc(e.name)}</strong><div class="help">${esc(e.tagline)}</div></td>
              <td><span class="pill ${d.available ? 'ok' : 'demo'}">${d.available ? '● 已就绪' : '○ 演示模式'}</span></td>
              <td class="mono" style="font-size:11.5px;color:var(--muted)">${esc(d.version ?? d.binary ?? '-')}</td>
              <td style="color:var(--muted-2);font-size:12.5px">${esc(d.detail ?? '')}</td>
              <td>
                <div class="mono" style="font-size:11.5px;margin-bottom:6px">${esc(e.install?.cmd ?? '-')}</div>
                <button class="btn btn-sm btn-ghost" data-copy="${esc(e.install?.cmd ?? '')}">复制</button>
                <a class="btn btn-sm btn-ghost" href="${esc(e.docs)}" target="_blank" rel="noreferrer">文档</a>
              </td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>
    </div>

    <div class="grid grid-2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><div class="card-title">运行环境</div></div>
        <dl class="kv">
          <dt>Node 版本</dt><dd>${esc(env.node)}</dd>
          <dt>操作系统</dt><dd>${esc(env.platform)}</dd>
          <dt>项目目录</dt><dd class="mono">${esc(env.projectRoot)}</dd>
          <dt>数据目录</dt><dd class="mono">${esc(env.dataDir)}</dd>
          <dt>并发任务上限</dt><dd>${env.concurrency}（环境变量 TESTBENCH_CONCURRENCY）</dd>
        </dl>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">接入真实工具</div></div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div>
            <strong style="font-size:13px">1. 安装缺失的命令行工具</strong>
            <pre class="code" style="margin-top:6px">pip install locust        # Locust 负载测试
brew install jmeter       # Apache JMeter 压测
pip install evalscope     # EvalScope 模型评测（本机已安装）</pre>
          </div>
          <div>
            <strong style="font-size:13px">2. 回到本页点击「重新检测」</strong>
            <div class="help" style="margin-top:4px">检测结果会缓存 30 秒，点击按钮立即刷新。</div>
          </div>
          <div>
            <strong style="font-size:13px">3. 新任务将自动切换为真实执行</strong>
            <div class="help" style="margin-top:4px">已在运行的任务不受影响；页面上会以「真实执行 / 演示模式」标签明确区分。</div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">HTTP API</div>
        <span class="card-sub">可在 CI 或其他系统中直接调用</span></div>
      <pre class="code" id="api-sample">${esc(`# 发起一次 Locust 压测
curl -X POST http://127.0.0.1:4399/api/runs \\
  -H 'Content-Type: application/json' \\
  -d '{
    "engine": "locust",
    "name": "首页压测",
    "config": { "host": "https://example.com", "users": 50, "spawnRate": 5, "duration": 120, "paths": "GET / 3\\nGET /api/items 1" }
  }'

# 查询运行记录
curl http://127.0.0.1:4399/api/runs?engine=locust&limit=10

# 实时日志（SSE）
curl -N http://127.0.0.1:4399/api/runs/<runId>/events`)}</pre>
      <button class="btn btn-sm btn-ghost" style="margin-top:10px" id="btn-copy-api">复制示例</button>
    </div>`;

  view.querySelectorAll('[data-copy]').forEach((btn) =>
    btn.addEventListener('click', () => copyText(btn.getAttribute('data-copy'), '安装命令已复制')),
  );

  view.querySelector('#btn-detect').addEventListener('click', async () => {
    const btn = view.querySelector('#btn-detect');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 检测中…';
    try {
      const { detection: fresh } = await api.detect();
      state.detection = fresh;
      toast('检测完成', 'ok');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ 重新检测';
    }
  });

  view.querySelector('#btn-copy-api').addEventListener('click', () =>
    copyText(view.querySelector('#api-sample').textContent, 'API 示例已复制'),
  );
}
