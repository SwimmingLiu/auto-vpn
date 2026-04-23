# SQLite Run Checkpoints Design

## Outcome

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation` 为真实 pipeline 增加**运行中 SQLite 持久化**，让 `extract`、`speedtest`、`availability`、`postprocess` 的中间结果在阶段执行过程中就落盘；同时把 source 抓取请求改成**统一走上游代理**，并把当前 profile 的 `max_iterations` 暂时统一降到 `5000`，避免单次真实 run 拉得过长。

## Goals

- 每次 run 在 artifact 目录下创建一个可读的 SQLite 数据库
- `extract` 在发现新节点时立即持久化，而不是等阶段结束后再写 `vpn_node_raw.txt`
- `speedtest` / `availability` / `postprocess` 的逐条结果在运行中可见
- 监控脚本优先读取 SQLite，展示当前阶段、每个 source 进度和各阶段节点计数
- source 抓取请求在配置了 `VPN_AUTOMATION_UPSTREAM_PROXY` 时统一使用代理，不再“先直连、失败再切代理”
- 默认 profile 和运行时 profile 的 `max_iterations` 暂时统一为 `5000`
- 保持现有 artifact 文本文件输出，避免破坏现有使用方式

## Root Cause

### 中间数据丢失

当前实现把 `extract` 的 `links` / `seen` 保存在内存中；只有整个 `extract` 阶段结束后，`PipelineController` 才把原始节点写入 `vpn_node_raw.txt`。如果阶段中途异常，已抓到但尚未导出的节点会全部丢失。

### 代理行为不一致

当前 `fetch_source_links()` 统一采用“先直连、失败后才回退代理”的策略。代码没有按 source 名称区分代理行为，因此“只有某个渠道走代理”的观感来自运行时网络差异，而不是显式配置。要让所有渠道行为一致，必须把抓取请求切换为统一代理模式。

## Architecture

### 1. SQLite checkpoint store

每次 run 在 artifact 目录创建：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/<run>/run.db`

新增一个专门的持久化层，负责：

- 初始化数据库 schema
- 记录阶段状态变更
- 记录每个 source 的运行进度
- 逐条写入原始节点 / 测速结果 / 可用性结果 / 最终节点
- 输出阶段汇总计数

建议新文件：

- `src/vpn_automation/pipeline/run_store.py`

### 2. Schema

最小 schema：

- `runs`
  - `run_id`
  - `artifact_dir`
  - `started_at`
  - `finished_at`
  - `status`
- `stage_events`
  - `stage_name`
  - `status`
  - `recorded_at`
- `source_progress`
  - `source_name`
  - `iteration`
  - `max_iterations`
  - `new_links`
  - `raw_links`
  - `successful_iterations`
  - `failed_iterations`
  - `recorded_at`
- `raw_links`
  - `source_name`
  - `link`
  - `first_seen_at`
  - unique(`source_name`, `link`)
- `speedtest_results`
  - `link`
  - `reachable`
  - `latency_ms`
  - `average_download_mb_s`
  - `error`
  - `recorded_at`
- `availability_results`
  - `link`
  - `provider`
  - `passed`
  - `reason`
  - `recorded_at`
- `final_links`
  - `stage_name`
  - `link`
  - `country_code`
  - `recorded_at`

### 3. Pipeline integration

`PipelineController` 在 run 开始时创建 `run.db`，随后：

- `set_stage()` 时同步写入 `stage_events`
- `extract` 过程中每次进度更新时同步写入 `source_progress`
- `extract` 发现新节点时逐条写入 `raw_links`
- `extract` 完成后从 SQLite 导出 `vpn_node_raw.txt`
- `speedtest` 每个结果完成时写 `speedtest_results`
- `availability` 每个 provider 结果完成时写 `availability_results`
- `postprocess` 产出最终节点时写 `final_links`
- `pipeline_report.json` 继续保留，但改为从内存汇总和 SQLite 中间态共同驱动

这次不做自动恢复执行；SQLite 的目标是**保住中间数据并支撑监控**，不是直接实现 resume。

### 4. Extract proxy behavior

`fetch_source_links()` 调整为：

- 解析一次 `VPN_AUTOMATION_UPSTREAM_PROXY`
- 如果配置为空 / off / none，则保持无代理
- 如果配置有效，则本次 source 抓取的所有请求统一使用：
  - `{"http": proxy, "https": proxy}`

不再先尝试 `proxies=None` 再回退代理。

### 5. Iteration cap

本次把 profile 中各 source 的 `max_iterations` 默认值和当前本地运行时主配置都调整为 `5000`：

- 默认 profile 生成值改为 `5000`
- Electron runtime 默认 profile 改为 `5000`
- 如果本机存在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`，将其同步改为 `5000`

本次不额外引入“硬编码 clamp”；值直接写入配置，保持可读、可改。

## Data Flow

1. backend `run` 加载 `profile.toml`
2. `PipelineController` 创建 `artifact_dir` 和 `run.db`
3. `extract` 每次请求返回后：
   - 去重
   - 写 `source_progress`
   - 对新增节点写 `raw_links`
4. 阶段切换时写 `stage_events`
5. `speedtest` / `availability` / `postprocess` 逐条写 SQLite
6. 监控脚本读取最新 artifact 下的 `run.db`
7. 文本产物从运行中数据导出，保留给人工查看

## Monitoring

新增 `scripts/monitor_run.sh`：

- 优先读取最新 artifact 下的 `run.db`
- 没有 SQLite 时再回退旧的日志解析逻辑
- 展示：
  - 当前阶段状态
  - 每个 source 最新迭代 / 当前 raw 数
  - `raw` / `deduped` / `speedtest` / `availability` / `postprocess` / `final` 阶段计数
  - 最近一条增长的 source 进度

## Error Handling

- 如果 SQLite 初始化失败：run 直接失败，不 silently downgrade
- 如果写入单条 checkpoint 失败：记录错误并终止当前 run，避免“监控看着正常但库不完整”
- 如果某个 source 失败：保留已经写入 SQLite 的该 source 中间结果，并继续其他 source
- 如果后续阶段失败：之前阶段已写入的 SQLite 数据和文本导出文件保留

## Verification

- Python 单测：
  - SQLite schema 初始化
  - `extract` 逐条写入 raw link / progress
  - 代理配置开启时，所有 source 请求统一携带代理
  - `monitor_run.sh --once` 优先读取 SQLite
- e2e：
  - fake services 跑完后生成 `run.db`
  - `run.db` 与导出的 artifact 文件计数一致
- 真实验证：
  - 启动一次 backend `run`
  - `monitor_run.sh` 在运行中看到 source 进度和节点增长
  - 人工确认当前 profile 中各 source `max_iterations = 5000`

## Out of Scope

- 不做自动断点续跑
- 不改动 speedtest / availability 的业务判定阈值
- 不把 Cloudflare deploy / verify 改成 SQLite-first
- 不改动 Electron 配置模型本身
