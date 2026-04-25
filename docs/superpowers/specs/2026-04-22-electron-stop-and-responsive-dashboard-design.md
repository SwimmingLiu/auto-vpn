# Electron 停止控制与响应式仪表盘设计

## 目标

修复 `vpn-subscription-automation` 当前 Electron 桌面端的两个核心问题：

1. 运行中没有停止按钮，用户无法中断长时间流水线。
2. 首页 UI 过于拥挤，日志、按钮和文案在常见窗口尺寸下被遮挡，缺少对不同分辨率的自适应。

同时把“完成改动后必须做 Playwright / computer use 的端到端与视觉验证”写入 `AGENTS.md`。

## 现状问题

- `electron/ipc.js` 仅暴露 `pipeline:run`，没有 stop/cancel 通道，也没有运行状态管理。
- `electron/renderer/app.js` 只维护“点击运行后禁用 run 按钮”的最小状态，没有停止状态和显式控制栏。
- `electron/renderer/styles.css` 使用了：
  - `html, body { overflow: hidden; }`
  - `.app-shell { width: min(100%, clamp(820px, 56vw, 1120px)); }`
  - `.workspace-grid { grid-template-columns: minmax(0, 1fr) 286px; }`

这些策略会把内容限制在偏窄中栏，并让日志区长期处于固定窄栏中；窗口较大时内容不扩展，窗口较小时又容易压缩文字和按钮。

## 设计原则

- 优先可读性，而不是“卡片感”。
- 运行操作、阶段状态、日志必须同时在首屏内可发现。
- 应用型 dashboard 使用固定 `rem` 文字尺度，不用 fluid typography。
- 响应式不是整体缩放，而是在断点上重排布局。
- 日志面板视为一级功能，不再只是角落里的摘要。

## 方案

### 1. 运行控制

- 在顶部操作区加入独立 `停止运行` 按钮。
- 运行态下：
  - `运行全流程` 按钮禁用并显示运行文案；
  - `停止运行` 按钮启用；
  - 页面显示明确运行状态徽标。
- Electron main process 保存当前活跃 backend child process。
- 新增 `pipeline:stop` IPC：
  - 若有活跃进程，先发送 `SIGTERM`；
  - 在进程关闭后清理运行状态；
  - renderer 收到结束结果后恢复按钮状态并写日志。

### 2. 信息架构

首页改为三层结构：

- 顶部：品牌、语言、保存、运行、停止、运行状态。
- 中部：概览说明 + 核心指标 + 运行提示。
- 主工作区：
  - 左侧：配置卡片（抓包源 / 测速 / 部署 / 摘要）
  - 右侧：运行区（阶段状态 + 日志）

右侧运行区比左侧配置区更宽，日志获得主视图优先级。

### 3. 响应式布局

- 默认桌面窗口扩大到更舒适的工作尺寸，并降低最小窗口限制。
- 宽屏：左右双栏，右侧更宽。
- 中等宽度：顶部概览与控制区重排，但日志仍保持大面积展示。
- 窄窗口：配置区、阶段区、日志区垂直堆叠，允许页面纵向滚动，不再全局 `overflow: hidden`。

### 4. 视觉方向

当前玻璃拟态和偏淡紫的“AI dashboard”感过强，改成更稳的工具型视觉：

- 更克制的中性色背景和边框；
- 更清晰的层级与对比；
- 更高信息密度但保留呼吸感；
- 日志区使用深色 terminal panel；
- 阶段状态改为纵向列表，避免文本被压缩。

由于本会话中 `impeccable` skill 未安装，实施时参考其官方公开设计原则来完成重构，重点落在：

- responsive redesign
- overflow / edge-state design
- visual iteration with browser checks

## 验收标准

- 运行后可见并可点击 `停止运行`。
- `960x720` 下首屏无横向溢出，主要功能区可见。
- 日志区在桌面常用尺寸下可直接阅读，不再被压缩到难以使用。
- 中英文切换下按钮与标题不被遮挡。
- Playwright e2e 与 visual regression 通过。
- `AGENTS.md` 明确要求：UI/UX 变更或任务完成后，必须执行 Playwright 或 computer use 的端到端与像素级验证。
