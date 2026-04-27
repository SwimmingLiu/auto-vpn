# Electron 运行页阶段重试设计

## 背景

当前 Electron 运行页已经有一个 `重试当前阶段` 按钮，但它只是重新调用整条 pipeline，无法满足“基于某次历史 run，从指定阶段开始，把后续阶段一路跑完”的需求。现有后端只支持：

- 全量 `run`
- 从最近未完成 `run.db` 恢复的 `run --resume-latest`
- 基于 `session.json` 的 `resume-speedtest`
- 基于 `session.json` 的 `resume-pipeline`

这些能力都不适合运行页直接对任意历史 artifact 做阶段级重试。

## 目标

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer` 的运行页顶部增加“历史 run + 阶段 + 重试”交互，允许用户：

1. 选择当前或历史 artifact
2. 仅选择有足够前置产物的阶段
3. 从选定阶段开始执行，并自动串行跑完后续阶段直到 `verify`
4. 重试时新建一个新的 retry artifact，保留原始 run
5. 阶段重试使用当前已保存 profile，而不是历史 run 当时的 profile

## 非目标

- 不支持 `doctor / extract / dedupe` 的阶段重试
- 不支持在原 artifact 上原地覆盖
- 不支持在运行页里编辑“重试 DAG”或自定义后续阶段集合
- 不支持依赖 `session.json` 的历史重试入口；历史重试必须只依赖 artifact 目录与 `run.db`

## 用户确认后的约束

- 可重试阶段限定为：
  - `speedtest`
  - `availability`
  - `postprocess`
  - `render`
  - `obfuscate`
  - `deploy`
  - `verify`
- 历史 run 选择入口放在运行页顶部
- 只允许点击“前置产物已具备”的阶段
- 从历史 run 重试时新建一个新的 artifact
- 重试时使用当前已保存 profile
- 阶段重试固定从所选阶段一路跑到 `verify`
- 阶段重试忽略运行页的 `跳过部署 / 跳过验证`；仅保留“保存配置后运行”对 profile 持久化的影响

## 方案选择

### 方案 A：继续堆叠现有 `resume-speedtest` / `resume-pipeline`

优点：

- 复用已有命令
- 改动入口少

缺点：

- 依赖 `session.json`
- 只能覆盖极少数阶段边界
- 无法自然扩展到 `postprocess / render / obfuscate / deploy / verify`

结论：不选。

### 方案 B：在 `PipelineController.run()` 中加入通用 `start_stage`

优点：

- 把“从任意阶段开始跑”的逻辑集中在 controller
- CLI / Electron 都能共用

缺点：

- 需要把 controller 当前“一次性全量执行”的实现整体拆开
- 容易影响正常全量 run 与 existing resume 语义
- 改动面较大，回归风险高

结论：本轮不选。

### 方案 C：新增 artifact-based 阶段重试编排层

做法：

- 保留 `PipelineController` 的全量 run 逻辑不动
- 在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py` 上方新增一组“基于 artifact 目录的阶段重试” helper
- 新增 backend CLI 子命令，例如 `retry-stage`
- Electron 通过 IPC 调用这个新命令
- 每次重试创建新 artifact，并复制/重建该阶段之前必须的中间产物

优点：

- 与现有全量 run 解耦
- 可以直接围绕 artifact 文件和 `run.db` 做历史重试
- 易于限定阶段集合和前置条件
- 风险集中在 retry 通道，便于测试

结论：选择该方案。

## 运行页设计

在运行页顶部新增一个 retry 控制区，位置在现有开始/停止运行按钮上方，包含：

1. **历史 run 下拉框**
   - 默认选中最新 artifact
   - 展示值为 artifact 目录名（如 `20260427-081718`）
   - 附带状态文案：`成功 / 失败 / 运行中 / 重试自 xxx`

2. **阶段下拉框**
   - 内容来自当前选中 artifact 的 `retryable_stages`
   - 仅显示可重试阶段
   - 默认选中该 artifact 最靠后的失败阶段；若没有失败阶段，则选中最靠后的可重试阶段

3. **阶段重试按钮**
   - 文案：`从所选阶段重试`
   - 点击后：
     - 若勾选“保存配置后运行”，先持久化当前 profile
     - 调用 Electron IPC 开始 `retry-stage`
     - 新建 retry artifact
     - 运行页实时显示新 artifact 的 stage / summary / logs

4. **说明文案**
   - `阶段重试会新建 artifact，并从所选阶段继续执行到 verify`

现有 `重试当前阶段` 按钮删除，避免与新的阶段选择模型冲突。

## 历史 run 数据模型

新增 backend CLI `artifact-list`，返回最近 N 个 artifact 的轻量列表。每一项至少包含：

- `artifact_dir`
- `artifact_name`
- `run_status`
- `stage_status`
- `counts`
- `updated_at`
- `retry_context`
  - `source_artifact_dir`
  - `source_artifact_name`
  - `start_stage`
- `retryable_stages`

`retryable_stages` 由 artifact 现存文件与 report 联合推导：

- `speedtest`：存在非空 `vpn_node_deduped.txt`
- `availability`：存在非空 `vpn_node_speedtest.txt` 且可从 `run.db.speedtest_results` 恢复对应结果
- `postprocess`：存在非空 `vpn_node_availability.txt` 且可从 `run.db.speedtest_results` 恢复对应结果
- `render`：存在非空 `vpn_node_emoji.txt`
- `obfuscate`：存在 `vmess_node.js`
- `deploy`：存在 `vmess_node_worker.js`
- `verify`：`pipeline_report.json` 中 `deploy` 已成功

## 阶段重试后端设计

新增 backend CLI：

```bash
python -m vpn_automation.backend retry-stage \
  --project-root <repo> \
  --artifact-dir <old-artifact> \
  --stage <speedtest|availability|postprocess|render|obfuscate|deploy|verify>
```

### 新 artifact 规则

每次阶段重试都创建新 artifact，例如：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/20260427-153011`

并写入：

- 新的 `run.db`
- 新的 `pipeline_report.json`
- `retry_context.json`（或等价地写入 `pipeline_report.json.retry_context`）

`retry_context` 至少包含：

- `source_artifact_dir`
- `source_artifact_name`
- `start_stage`

### 各阶段输入来源

- `speedtest`
  - 输入：旧 artifact 的 `vpn_node_deduped.txt`
  - 行为：重新跑 `speedtest -> availability -> postprocess -> render -> obfuscate -> deploy -> verify`

- `availability`
  - 输入：
    - 旧 artifact 的 `vpn_node_speedtest.txt`
    - 旧 artifact `run.db.speedtest_results`
  - 行为：恢复 `list[SpeedTestResult]` 后继续跑

- `postprocess`
  - 输入：
    - 旧 artifact 的 `vpn_node_availability.txt`
    - 旧 artifact `run.db.speedtest_results`
  - 行为：恢复 `available_results` 并继续跑

- `render`
  - 输入：旧 artifact 的 `vpn_node_emoji.txt`
  - 行为：直接重新渲染模板，再继续 `obfuscate -> deploy -> verify`

- `obfuscate`
  - 输入：旧 artifact 的 `vmess_node.js`
  - 行为：重新 obfuscate，再继续 `deploy -> verify`

- `deploy`
  - 输入：旧 artifact 的 `vmess_node_worker.js`
  - 行为：重新 build pages bundle + deploy + verify

- `verify`
  - 输入：当前 profile 的 deploy 配置
  - 行为：仅重新 verify

### 实现边界

为了降低耦合，不把这些逻辑重新塞回 `PipelineController.run()`；而是在 `backend_resume.py` 内部新增：

- artifact 基础信息读取
- stage prerequisites 校验
- `SpeedTestResult` 恢复 helper
- `available_results` 恢复 helper
- retry artifact 初始化 helper
- `retry_pipeline_from_stage(...)`

## 状态与事件

`retry-stage` 需要沿用当前 Electron 已有的事件模型：

- `log`
- `stage`
- `summary`
- `run_failed`

这样 renderer 不需要重写整条运行事件消费链，只需在发起 retry 前设置正确的本地状态与 artifact selector 状态。

## 测试策略

### Python

- backend CLI：
  - `artifact-list` 返回最近 artifact 与 retryable stage
  - `retry-stage` 参数校验
  - `retry-stage` 对每个可重试阶段的前置条件校验

- stage retry orchestration：
  - `speedtest` 起点能创建新 artifact 并继续后续阶段
  - `deploy` 起点只跑 `deploy -> verify`
  - `verify` 起点只跑 verify
  - 缺少前置产物时报错
  - `retry_context` 正确写入新 artifact

### Electron / renderer

- runs page：
  - 出现历史 run 选择器、阶段选择器、重试按钮
  - 选中不同 artifact 后阶段列表联动变化
  - 重试按钮在运行中禁用
  - 触发 retry 时调用新的 bridge 方法并传递 `artifact_dir + stage`

### Visual regression

- 运行页新增顶部 retry 控制区后，`electron/tests/renderer-visual.test.mjs` 的 `runs` 哈希需要刷新。

### 手工验证

- 在 Electron 中：
  - 选中一个 deploy failed 的历史 artifact
  - 选择 `deploy`
  - 成功生成新的 retry artifact
  - 新 artifact 的 report 带 `retry_context`
  - 页面 summary / result 能切到新的 artifact

## 风险与控制

### 风险 1：历史 artifact 无 `session.json`

控制：

- 全部重试逻辑只依赖 artifact 文件与 `run.db`
- 不再把历史 retry 绑到 `session.json`

### 风险 2：中间结果恢复不完整

控制：

- `availability` / `postprocess` 只使用 `run.db.speedtest_results` 恢复 `SpeedTestResult`
- 缺数据时直接判定阶段不可重试，而不是让运行半路崩

### 风险 3：UI 入口与现有全量 run 混淆

控制：

- 删除旧的 `重试当前阶段`
- 新增单独的 retry 控制区和说明文案
- 阶段重试固定跑到 `verify`，不复用 `skipDeploy / skipVerify`

## 结论

本轮实现采用 **artifact-based stage retry**：

- Electron 运行页顶部增加历史 run + 阶段选择器
- 仅开放 `speedtest` 之后的 7 个阶段
- 每次重试新建 artifact
- 使用当前保存 profile
- 从所选阶段继续跑到 `verify`

这样既满足运行页直接调度历史重试，又避免对现有全量 pipeline 做高风险重构。
