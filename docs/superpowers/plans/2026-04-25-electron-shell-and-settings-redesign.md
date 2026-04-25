# Electron 外壳精简与设置抽屉重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 精简 Electron 客户端导航层级，修复订阅/日志/设置页交互，并把设置页重构为抽屉式编辑体验。

**Architecture:** 保持现有原生 JS + 单文件 renderer 架构不变，重点调整 `index.html`、`app.js`、`views.js`、`styles.css` 的外壳与状态模型。新交互通过更明确的前端状态驱动，不修改后端协议。

**Tech Stack:** Electron、原生 JS、Node test、Playwright

---

### Task 1: 重构壳层导航与首页状态

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 先写失败的 e2e 断言，约束新壳层**

补充断言：

- 顶部 `shortcut-action` 数量为 `0`
- 左侧不再有 `.status-card`
- 首页不再出现“高频操作”
- 首页出现“系统状态摘要”类信息

- [ ] **Step 2: 跑 e2e 测试，确认新断言先失败**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 断言因为旧 DOM 仍存在而失败。

- [ ] **Step 3: 修改壳层结构与首页 markup**

实现内容：

- `index.html` 删除 `shortcutStrip` 和侧栏 `status-card`
- `app.js` 删除相关元素引用与渲染
- `views.js` 删除首页“高频操作”，把系统状态摘要并入首页
- 顶部改为 `pageActions` 容器

- [ ] **Step 4: 修改样式**

实现内容：

- 侧栏图标和文案放大
- 隐藏侧栏滚动条
- 顶部布局从三列改成标题区 + 动态操作区

- [ ] **Step 5: 再跑 e2e 测试，确认壳层重构通过**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 新断言通过，且未引入新的导航回归。

### Task 2: 让订阅格式切换真正驱动 URL 和二维码

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 先写失败的订阅切换测试**

补充断言：

- 点击 `Clash Meta` 后，主订阅地址变为 `?format=clash-meta`
- 二维码 `img[src]` 发生变化
- `复制链接` 与 `打开订阅` 绑定到当前格式 URL

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 旧页面的格式按钮没有状态与 URL 切换，测试失败。

- [ ] **Step 3: 最小实现订阅格式状态**

实现内容：

- `state.subscriptionFormat = 'Clash'`
- 点击格式按钮后切换当前格式
- `buildSubscriptionsPage()` 使用当前格式卡片而不是固定第一项
- `refreshQrCode()` 读取当前格式 URL

- [ ] **Step 4: 压紧订阅页按钮与分段控件样式**

实现内容：

- 分段控件更紧凑
- 复制/打开按钮保留双按钮布局，但整体高度更低

- [ ] **Step 5: 再跑订阅相关测试**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 订阅格式切换断言通过。

### Task 3: 加上日志筛选与日志工具栏操作

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 先写失败测试，覆盖日志筛选语义**

补充断言：

- “错误”筛选只显示错误/失败日志
- “运行日志”隐藏错误项
- “按阶段”显示分组标题
- “清空显示”点击后日志区域为空状态

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`

Expected: 由于当前无筛选状态和按钮绑定，测试失败。

- [ ] **Step 3: 最小实现结构化日志与筛选状态**

实现内容：

- `appendLog()` 存对象而不是纯字符串
- `handlePipelineEvent('stage')` 合成阶段日志
- 增加 `state.logFilter`
- `views.js` 中新增过滤与分组函数

- [ ] **Step 4: 实现工具栏动作**

实现内容：

- 复制日志：复制当前筛选结果
- 清空显示：清空前端日志缓存
- 打开日志文件：优先打开 `${artifactDir}/human.log`，失败时写入错误日志

- [ ] **Step 5: 再跑日志相关测试**

Run: `rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`

Expected: 日志筛选与工具栏断言通过。

### Task 4: 把设置页改成卡片 + 抽屉编辑

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/index.html`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/styles.css`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 先写失败测试，约束抽屉行为**

补充断言：

- 设置页默认只出现配置卡片，不直接出现大表格
- 点击“数据源配置”打开右侧抽屉
- 点击“取消”关闭抽屉且不写回
- 点击“保存”关闭抽屉并把分组变更写回页面摘要

- [ ] **Step 2: 跑测试确认失败**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 旧设置页仍是平铺表格，测试失败。

- [ ] **Step 3: 最小实现设置抽屉状态**

实现内容：

- `state.settingsDrawer = null | { section, draft, dirty }`
- 点击卡片时克隆当前 section 到 draft
- 抽屉输入只改 draft
- `drawer-save` 才回写到 `state.profile`
- `drawer-cancel` 丢弃 draft

- [ ] **Step 4: 替换页面结构与样式**

实现内容：

- 设置主页改为 summary cards
- 增加 drawer overlay / panel
- 抽屉底部固定取消/保存按钮
- 顶部页面操作只保留“保存配置”

- [ ] **Step 5: 再跑设置页测试**

Run: `rtk node --test electron/tests/renderer-e2e.test.mjs`

Expected: 抽屉交互与摘要更新断言通过。

### Task 5: 更新视觉快照并做完整验证

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/app-launch.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: 运行视觉测试，拿到新的 hash**

Run: `rtk node --test electron/tests/renderer-visual.test.mjs`

Expected: 先失败，并打印新的截图 hash。

- [ ] **Step 2: 更新 `EXPECTED_DIGESTS`**

把六页最新 hash 写回 `renderer-visual.test.mjs`。

- [ ] **Step 3: 跑 Electron 全量测试**

Run: `rtk npm run test:electron`

Expected: 全部 Electron tests 通过。

- [ ] **Step 4: 跑 Python + Electron 全量测试**

Run: `rtk npm run test:all`

Expected: Python tests + Electron tests 全部通过。

- [ ] **Step 5: 打包并人工验证**

Run: `rtk npm run package:electron`

然后：

- 打开 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/dist-electron/mac-arm64/VPN Subscription Automation.app`
- 检查左侧无可见滚动条
- 检查订阅格式按钮可切换
- 检查日志筛选与设置抽屉可用
