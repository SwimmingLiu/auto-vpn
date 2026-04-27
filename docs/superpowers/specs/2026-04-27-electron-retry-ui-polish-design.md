# Electron 阶段重试 UI 修整设计

## 背景

阶段重试主功能已经可用，但当前运行页的历史 run 选择区存在 3 个实际问题：

1. `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/screenshots` 这类非 run 目录被当成历史 run 展示。
2. 历史 run 改成卡片后，运行页信息过载，而且阶段下拉点击时会闪烁，无法稳定选择。
3. 结果页“复制节点”缺少即时反馈；复制失败也会被静默吞掉。

## 用户已确认的方向

- 历史 run 区改回 **方案 A：双下拉紧凑版**
- 历史 run 与起始阶段各使用一个下拉框
- 仍保留“从所选阶段继续”的主按钮
- 下方保留一块简短摘要，显示当前所选 run 的来源、状态、可重试阶段

## 目标

在不改变阶段重试后端语义的前提下，完成以下修整：

1. 历史 run 列表只展示真实 artifact run
2. 运行页改为双下拉紧凑版，并修复阶段下拉闪烁
3. 结果页“复制节点”提供明确的成功/失败 toast 提示

## 非目标

- 不改变阶段重试允许的阶段集合
- 不改变 retry artifact 的生成规则
- 不新增历史 run 搜索、分页或高级筛选
- 不改动结果页节点表格结构

## 根因分析

### `screenshots` 混入历史 run

当前 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py` 中的 `list_artifacts_with_retry_stages()` 直接遍历 `artifacts/` 下的所有目录，因此会把 `screenshots` 这种仅用于视觉测试产物的目录也返回给 Electron。

### 阶段下拉闪烁

当前 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js` 在 `click` 事件里直接拦截 `select[data-run-retry-stage]`，并立即 `renderAll()`。用户展开下拉时，组件会在真正完成选择前被重渲染，导致焦点丢失和闪烁。

### “复制节点”无反馈

当前复制逻辑只尝试 `navigator.clipboard.writeText()`，成功后仅追加一条日志；失败时直接吞掉异常。结果页没有可见 toast，因此用户无法判断操作是否成功。

## 方案

### 1. 历史 run 过滤

后端 `artifact-list` 仅返回满足以下条件的目录：

- 目录名匹配时间戳 artifact 格式：`YYYYMMDD-HHMMSS`
- 且存在 `run.db` 或 `pipeline_report.json`

这样可以稳定排除：

- `screenshots`
- 未来可能新增的临时目录
- 不完整的视觉基线辅助目录

### 2. 运行页改回双下拉

运行页 retry 区结构调整为：

- 第一列：`历史 run` 下拉
- 第二列：`起始阶段` 下拉
- 第三列：`从该阶段继续` 按钮
- 第二行：摘要卡

下拉文案建议：

- 历史 run：`artifact_name · run_status`
- 若是 retry run，在摘要中显示：
  - `来源 run`
  - `起始阶段`

这样信息密度足够，但不会像卡片列表那样撑高布局。

### 3. 修复阶段下拉交互

- 从 `click` 处理链中移除 `data-run-retry-stage` 的逻辑
- 仅在 `change` / `input` 中更新 `state.selectedRetryStage`
- 历史 run 下拉同样放到 `change` 事件里处理

这样可以避免用户展开下拉时被提前重渲染。

### 4. 复制节点 toast

新增统一 toast 状态：

- `message`
- `tone`：`success | danger | neutral`

行为：

- 成功：显示 `已复制 N 条节点`
- 失败：显示 `复制失败：...`

复制通道优先级：

1. `window.vpnAutomation.copyText()`（Electron clipboard bridge）
2. `navigator.clipboard.writeText()`（浏览器演示/测试环境）

## 影响文件

### Backend

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`

### Electron bridge

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/preload.cjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`

### Renderer

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

## 测试策略

### Backend

- `artifact-list` 不再返回 `screenshots`
- 真实 artifact 仍正确返回 `retryable_stages`

### Renderer E2E

- 运行页渲染两个下拉框，不再渲染历史 run 卡片
- 切换历史 run 后阶段下拉正常刷新
- 选择阶段后可正常触发 retry
- 结果页点击“复制节点”后出现 toast

### Visual

- 刷新 `runs` 页 hash
- 如 toast 影响视觉基线，则在无 toast 的稳定状态截图
