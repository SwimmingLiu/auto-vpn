# Electron 停止控制与响应式仪表盘 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Electron 桌面端补齐停止运行能力，并把首页重构为可读、可扩展、响应式的运行工作台。

**Architecture:** 在 main process 维护活跃 backend child process，renderer 新增运行控制状态；首页从“紧凑摘要页”改为“配置区 + 运行区”的响应式工作台，日志与阶段状态提升为一等功能区。

**Tech Stack:** Electron, Playwright, Node.js test runner, vanilla HTML/CSS/JS

---

### Task 1: 先补失败测试

**Files:**
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/window-config.test.mjs`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: 为运行控制状态写失败测试**
- [ ] **Step 2: 为更合理的窗口默认尺寸与最小尺寸写失败测试**
- [ ] **Step 3: 为 `960x720` 与更宽窗口下的停止按钮、日志可见性、无溢出写失败 e2e**
- [ ] **Step 4: 更新视觉快照哈希，让 visual regression 先失败**

### Task 2: 实现运行停止通道

**Files:**
- Modify: `electron/ipc.js`
- Modify: `electron/preload.cjs`
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/state.js`

- [ ] **Step 1: 在 main process 保存活跃 child process 并暴露 `pipeline:stop`**
- [ ] **Step 2: 在 preload bridge 暴露 stop API**
- [ ] **Step 3: 在 renderer 管理 idle / running / stopping 状态**
- [ ] **Step 4: 让按钮状态和日志输出随着运行控制切换**

### Task 3: 重构首页布局与样式

**Files:**
- Modify: `electron/renderer/index.html`
- Modify: `electron/renderer/styles.css`
- Modify: `electron/renderer/i18n.js`
- Modify: `electron/window-config.js`

- [ ] **Step 1: 把顶部操作区补齐停止按钮与运行状态**
- [ ] **Step 2: 把主工作区改为配置区 + 运行区双栏**
- [ ] **Step 3: 提升日志区优先级并改善阶段列表可读性**
- [ ] **Step 4: 加入多断点响应式重排，确保不同分辨率下可用**

### Task 4: 更新项目约束

**Files:**
- Modify: `AGENTS.md`
- Modify: `/Users/swimmingliu/data/VPN/AGENTS.md`

- [ ] **Step 1: 把 UI/UX 改动后的 e2e + visual 验证要求写入项目 AGENTS**
- [ ] **Step 2: 同步到上层工作区 AGENTS，避免跨项目执行时遗漏**

### Task 5: 验证

**Files:**
- Test: `electron/tests/*.mjs`

- [ ] **Step 1: 跑 `npm run test:electron`**
- [ ] **Step 2: 单独跑 Playwright renderer e2e 与 visual**
- [ ] **Step 3: 启动 Electron 做一次真实界面检查**
- [ ] **Step 4: 用 computer use 或截图确认关键区块无裁切、日志可见、停止按钮可达**
