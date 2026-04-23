# SQLite Resume and Extract Attempt Monitor Design

## Outcome

在现有 SQLite checkpoint pipeline 之上补齐两项核心能力：

- 支持基于最近未完成 run 的 **断点续跑**
- 支持对 5 个抓取渠道的 **逐次抓取尝试日志监控**

续跑时不再从头开始重复抓取已经完成的阶段；监控时不仅能看到每个 source 当前累计 `raw` / `new`，还能看到每次抓取请求是否成功、是否返回节点、返回了多少节点、是否新增节点、失败原因是什么。

## Goals

- backend 增加 resume 模式，可恢复最近一次未完成的 artifact/run
- `extract` 可从 SQLite 中恢复每个 source 的已跑轮次、已见节点集合和累计计数
- 如果 `dedupe` / `speedtest` / `availability` / `postprocess` 已完成，resume 时跳过这些阶段
- 监控脚本显示最近抓取尝试日志，而不仅仅是 source 汇总计数
- 监控输出清楚区分：
  - 请求成功但没有节点
  - 请求成功且有节点但没有新增
  - 请求成功且有新增
  - 请求失败以及失败原因

## Root Cause

当前 SQLite 设计已经能保住中间结果，但还缺两层信息：

1. **恢复边界信息**
   - 只有阶段结果，没有明确的“从哪个 source 的第几轮继续”
   - 没有恢复 `seen` 集合所需的 query helper

2. **逐次抓取尝试日志**
   - 只有 `source_progress`
   - 这只能表达“当前累计进度”，不能表达每次请求本身的成败和返回结果

因此当前虽然可以中途看见数据，但还不能可靠 resume，也无法对“哪个渠道这一轮失败了”给出高质量监控。

## Architecture

### 1. Extend RunStore schema

新增 `extract_attempts` 表：

- `source_name`
- `iteration`
- `url`
- `used_proxy`
- `success`
- `http_status`
- `error_type`
- `error_message`
- `returned_links`
- `new_links`
- `total_links`
- `recorded_at`

同时给 `runs` 增加状态管理字段：

- `status`：`running` / `stopped` / `failed` / `success`
- `updated_at`

### 2. Resume model

resume 先只支持：

- **resume latest incomplete run**

规则：

- 找 artifacts 下最新的 `run.db`
- 如果 run 状态是 `running` / `stopped` / `failed` 且 `verify` 未成功，则允许恢复
- 如果 `verify=success`，视为完成，不恢复

### 3. Stage resume semantics

#### extract

对每个 source：

- 从 `source_progress` 取最后一次 `iteration`
- 从 `raw_links` 取该 source 已见 link 集合
- 从 `extract_attempts` / `source_progress` 恢复累计计数
- 从 `iteration + 1` 开始继续跑

#### dedupe

如果 `dedupe` 已成功：

- 直接读 `vpn_node_deduped.txt` 或从 `raw_links` 重建 dedupe 结果

#### speedtest

如果 `speedtest` 已成功：

- 从 `speedtest_results` 读取结果恢复

#### availability

如果 `availability` 已成功：

- 从 `availability_results` 恢复 provider 结果

#### postprocess

如果 `postprocess` 已成功：

- 从 `final_links` 恢复

#### render / obfuscate / deploy / verify

这些阶段如果未成功，resume 时从最早未完成阶段继续跑。

### 4. Monitoring

`scripts/monitor_run.sh` 增加：

- 最近 `N` 条 `extract_attempts`
- 每条显示：
  - `source`
  - `iter`
  - `ok/fail`
  - `returned`
  - `new`
  - `total`
  - `error`

示例：

- `leiting iter=123 ok returned=1 new=1 total=45`
- `heidong iter=456 ok returned=0 new=0 total=14`
- `mifeng iter=87 fail SSLError: EOF occurred in violation of protocol`

### 5. Backend surface

新增 backend CLI 入口：

- `python -m vpn_automation.backend run --resume-latest --project-root ...`

默认 `run` 仍然新开 run；只有显式 `--resume-latest` 时才恢复。

## Data Flow

### Fresh run

1. 创建 artifact + `run.db`
2. `runs.status = running`
3. `extract` 逐次写 `extract_attempts`
4. source 进度写 `source_progress`
5. 其他阶段继续写 SQLite 中间态
6. 成功后 `runs.status = success`

### Resume run

1. backend 查找最新未完成 run
2. 加载 `run.db`
3. 判断最早未完成阶段
4. `extract` 从每个 source 已完成 iteration 的下一轮继续
5. 已完成阶段直接复用 SQLite 数据，不重做
6. 最终完成后更新 `runs.status = success`

## Error Handling

- 如果找不到可恢复 run：resume 命令直接报错
- 如果 `run.db` 缺关键表：报 schema 不兼容错误，不 silent fallback
- 如果某 source 恢复时发现 `source_progress` 有 iteration 但 `raw_links` 丢失，优先信任 `raw_links` 结果并重算计数
- 如果恢复后阶段数据和文本 artifact 不一致，以 SQLite 为准，必要时重导出文本文件

## Verification

- 单测：
  - `RunStore` 创建 `extract_attempts`
  - `fetch_source_links` 逐次写抓取尝试日志
  - extract resume 从下一 iteration 继续
  - backend `--resume-latest` 能定位最新未完成 run
- e2e：
  - 先跑到 extract 中途写 SQLite
  - 中断
  - resume 后继续而不是从 iteration 1 重来
- 真实验证：
  - 启动真实 run
  - 中途停止
  - 执行 `--resume-latest`
  - 用 `monitor_run.sh` 看到恢复后 iteration 继续增长，且最近尝试日志可见

## Out of Scope

- 不实现跨多次历史 run 的智能选择恢复
- 不实现 speedtest / availability 内部并发任务粒度的精确恢复
- 不实现“恢复任意自定义 artifact id”的复杂 CLI 选择器
