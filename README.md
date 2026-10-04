# TestBench · 网页版测试平台

把 **EvalScope（模型评测）**、**Locust（负载测试）**、**Apache JMeter（压测）** 统一收进一个 Web 界面：选引擎 → 填参数 → 自动生成执行脚本 → 实时看日志 → 结果入库 → 历史对比。

零运行时依赖：后端只用 Node 内置模块，前端为原生 SPA，**不需要 `npm install`**，`npm start` 即可运行。

---

## 功能一览

| 模块 | 能力 |
| --- | --- |
| **引擎编排** | EvalScope / Locust / JMeter 统一配置模型、统一结果结构、统一调度队列（可配置并发） |
| **自动生成脚本** | 根据界面参数生成 `locustfile.py` 与 `.jmx` 测试计划，无需手写代码；提交前可实时预览命令与文件内容 |
| **数据集管理** | 上传 jsonl / json / csv / tsv / txt，自动识别类型、统计记录数、解析字段与预览；压测数据集可直接驱动请求路径，评测数据集作为 `--dataset-dir` |
| **历史记录** | 全部运行归档（状态、耗时、关键指标、标签、执行命令、完整日志、产物文件），支持引擎/状态/关键词筛选与多任务横向对比 |
| **实时可观测** | SSE 推送运行日志与进度；结果页展示 KPI、RPS/延迟时序曲线、接口明细表、原始报告 JSON |
| **环境诊断** | 启动即检测三个 CLI 是否可用，一键重新检测，缺失时给出安装命令 |
| **模式透明** | 每个任务都明确标注 `真实执行` 或 `演示模式`，演示模式使用合成数据，**不会伪装成真实测量结果** |

---

## 快速开始

### 方式一：一键安装脚本（推荐，macOS / Linux）

```bash
git clone <本仓库> testbench && cd testbench
./install.sh          # 创建 .venv，安装 Locust + EvalScope + JMeter，并做环境自检
npm start             # 打开 http://127.0.0.1:4399
```

Windows（PowerShell 5+）：

```powershell
.\install.ps1
npm start
```

安装脚本做的事：

1. 校验 Node.js ≥ 18、Python ≥ 3.10、Java（JMeter 依赖）
2. 在项目内创建 `.venv`（不需要 sudo，不污染系统 Python），安装 **Locust** 与 **EvalScope**
3. 安装 **Apache JMeter**：macOS 用 Homebrew、Linux 用 apt/dnf，都不可用时下载便携版到 `./tools/jmeter`
4. 初始化 `data/` 目录并运行 `npm run doctor` 输出环境自检报告

常用参数：

```bash
./install.sh --no-jmeter     # 不安装 JMeter
./install.sh --no-venv       # 不用虚拟环境，装到当前 Python
./install.sh --with-perf     # 额外安装 evalscope[perf]（采集 TTFT/吞吐等性能指标）
./install.sh --check         # 只做环境自检，不做任何安装
./install.sh --strict        # 配合 --check：有工具缺失则退出码非 0（适合 CI）
```

> 服务启动时会**优先查找项目内** `.venv/bin`、`venv/bin`、`tools/jmeter/bin`，再回退到系统 PATH，所以不需要手动 `source .venv/bin/activate`。

### 方式二：Docker（适合部署到服务器）

```bash
docker build -t testbench .
docker run -d --name testbench -p 4399:4399 -v testbench-data:/app/data testbench
```

镜像内已包含 Node、JRE、JMeter、Locust 与 EvalScope，开箱即用。

### 方式三：手动安装

```bash
pip install locust "evalscope[perf]"   # 建议在虚拟环境中
brew install jmeter                     # 或 apt install jmeter
npm run doctor                          # 确认三个引擎均就绪
npm start
```

---

## 界面导航

- **概览**：累计运行、成功率、压测总请求、数据集数量，引擎就绪状态、近 14 天趋势、最近运行列表
- **新建测试**：选择引擎 → 填写参数（按“目标 / 负载 / 高级”分组）→ 绑定数据集 → 右侧实时预览命令与生成的脚本 → 启动
- **历史记录**：多条件筛选、勾选 2~4 个任务对比关键指标、一键重跑或删除
- **数据集**：拖拽上传、快速模板、字段与记录预览、下载、删除
- **环境诊断**：引擎可用性与版本、安装命令、运行环境信息、HTTP API 示例

---

## 引擎说明

### EvalScope（LLM 评测）

界面参数会转换为 `evalscope eval` 命令，例如：

```bash
evalscope eval --model Qwen/Qwen2.5-0.5B-Instruct --datasets gsm8k arc \
  --eval-type openai_api --api-url https://api.example.com/v1 --api-key *** \
  --limit 50 --work-dir <runDir>/evalscope --no-timestamp
```

- 支持 `openai_api` / `litellm` / `llm_ckpt` / `mock_llm` 等评测方式；`mock_llm` 可在无 API 的环境下自测链路
- 运行结束后自动递归解析 `reports/*.json`，抽取 `Score / Num / Dataset / Metric` 生成得分卡片与柱状图；若开启了 `--collect-perf`，延迟与吞吐指标也会展示
- **API Key 会在命令展示与日志中自动脱敏**
- 评测数据集需从 ModelScope/HuggingFace 下载，**离线机器会失败**（属预期），此时任务会标记为失败并保留原始错误，不会产出伪造指标

### Locust（负载测试）

根据「请求路径」自动生成 locustfile（支持 `GET /api/items 3` 形式的方法与权重），以 headless 模式执行：

```bash
locust -f locustfile.py --headless -u 50 -r 5 -t 120s --host https://example.com \
  --csv <runDir>/locust --only-summary --loglevel INFO
```

结果解析 `*_stats.csv` / `*_stats_history.csv` / `*_failures.csv`，得到汇总指标、时序曲线、接口明细与失败原因。

### Apache JMeter（压测）

根据参数生成完整的 `.jmx` 测试计划（线程组 + HTTP 采样器 + 随机控制器按权重分流），以非 GUI 模式执行：

```bash
jmeter -n -t plan.jmx -l results.jtl -j jmeter.log
```

结果按秒聚合 JTL，产出 RPS / 平均延迟 / P95 / P99 / 错误率，以及每个请求的明细。

---

## 数据集如何被使用

| 引擎 | 注入方式 |
| --- | --- |
| Locust | 读取 `method` / `path` / `weight` 列，替换「请求路径」并生成对应任务权重 |
| JMeter | 读取 `method` / `path` 列，替换「请求路径」生成采样器 |
| EvalScope | 数据集目录作为 `--dataset-dir` 传入，支持 jsonl 等本地格式 |

CSV 示例：

```csv
method,path,weight
GET,/,3
GET,/api/items,2
POST,/api/orders,1
```

---

## 关于「演示模式」

若某台机器没有安装对应 CLI，任务仍可提交，但会以**演示模式**运行：平台生成合成时序与指标，并在任务详情、日志首行、历史列表与对比弹窗中明确标注“演示模式 / 合成数据”。

这样做的目的：在没有工具链的机器上也能完整验证配置、流程与报表；一旦装好工具并点击「重新检测」，后续任务自动切换为真实执行。两种结果不会被混为一谈。

---

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/engines` | 引擎定义 + 可用性检测 |
| POST | `/api/engines/detect` | 强制重新检测 |
| GET | `/api/stats` | 概览统计与环境信息 |
| POST | `/api/preview` | 生成命令与脚本预览（不执行） |
| GET | `/api/datasets` | 数据集列表 |
| POST | `/api/datasets` | 上传数据集（JSON body，含 `content` 文本） |
| GET | `/api/datasets/:id/content` | 下载原始文件 |
| DELETE | `/api/datasets/:id` | 删除数据集 |
| GET | `/api/runs` | 历史记录（`engine` / `status` / `q` / `limit`） |
| POST | `/api/runs` | 创建并提交任务 |
| GET | `/api/runs/:id` | 任务详情（含指标、曲线、明细、报告） |
| GET | `/api/runs/:id/events` | SSE 实时日志与进度 |
| GET | `/api/runs/:id/logs` | 纯文本日志下载 |
| GET | `/api/runs/:id/artifacts` | 产物文件清单 |
| POST | `/api/runs/:id/cancel` | 取消任务 |
| POST | `/api/runs/:id/rerun` | 以相同配置重跑 |
| DELETE | `/api/runs/:id` | 删除任务及产物 |
| GET | `/api/compare?ids=a,b` | 多任务对比原始数据 |

示例：

```bash
curl -X POST http://127.0.0.1:4399/api/runs \
  -H 'Content-Type: application/json' \
  -d '{
    "engine": "locust",
    "name": "首页压测",
    "config": { "host": "https://example.com", "users": 50, "spawnRate": 5,
                "duration": 120, "paths": "GET / 3\nGET /api/items 1" }
  }'
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址，局域网/容器部署用 `0.0.0.0` |
| `PORT` | `4399` | 监听端口 |
| `TESTBENCH_DATA` | `./data` | 数据目录（运行记录与数据集） |
| `TESTBENCH_CONCURRENCY` | `2` | 同时执行的任务数上限 |
| `TESTBENCH_MAX_UPLOAD` | `67108864` | 上传体积上限（字节） |
| `TESTBENCH_BIN_DIR` | — | 额外优先查找可执行文件的目录 |
| `JMETER_VERSION` | `5.6.3` | 安装脚本下载的 JMeter 版本 |

---

## 目录结构

```
.
├── server.js              # HTTP 服务：静态资源 + API + SSE
├── src/
│   ├── api.js             # 路由与数据集解析
│   ├── runner.js          # 任务队列、进程管理、日志流、结果落库
│   ├── store.js           # 运行记录与数据集的持久化（JSON 文件）
│   ├── events.js          # SSE 事件中心
│   ├── util.js            # 工具函数与二进制解析（含 .venv 优先）
│   └── engines/           # 引擎适配器：evalscope / locust / jmeter
├── public/                # 前端 SPA（原生 JS + Canvas 图表）
├── scripts/
│   ├── doctor.mjs         # 环境自检
│   └── smoke.mjs          # 端到端测试
├── install.sh / install.ps1
├── Dockerfile
└── data/                  # 运行产物（运行记录、日志、数据集）
```

---

## 测试

```bash
npm run doctor        # 环境自检
npm run test:parsers  # 结果解析器测试：29 项断言（Locust CSV / JMeter JTL / EvalScope 报告）
npm run smoke         # 端到端测试：47 项断言（启动服务、上传数据集、创建任务、SSE、排队、解析结果、对比、删除）
npm run smoke:full    # 追加真实 EvalScope 执行路径验证（需要网络下载数据集）
```

`smoke` 会在临时端口启动服务、使用独立临时数据目录，结束后自动清理，不会污染 `data/`。

---

## 常见问题

**Q：提交任务后显示“演示模式”？**
对应引擎的 CLI 未被检测到。运行 `./install.sh` 或手动安装后，在「环境诊断」点击「重新检测」即可。检测结果缓存 30 秒。

**Q：EvalScope 任务失败，日志里是网络错误？**
评测数据集需要联网下载。离线环境可改用 `mock_llm` 验证链路，或通过 `--dataset-dir`（界面中的“本地数据集目录”）指定已下载的数据。

**Q：JMeter 报找不到 Java？**
安装 JDK 8+（推荐 17）。`npm run doctor` 会显示 Java 检测结果。

**Q：任务能并发跑几个？**
默认 2 个，超出的排队。可用 `TESTBENCH_CONCURRENCY` 调整；压测类任务建议逐个执行以免互相干扰。

**Q：数据存在哪里？**
`data/runs/`（运行记录 JSON + 日志 + 产物）与 `data/datasets/`。删除任务会同时清理对应产物目录。
