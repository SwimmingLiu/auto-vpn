# Electron 中文唯一界面收敛设计

## 目标

将 `vpn-subscription-automation` 的 Electron 渲染层从“保留多语言壳但实际只用中文”收敛为“中文唯一实现”：

- 界面只保留中文，不再保留任何英文文案、英文 fallback、英文选项或语言切换残留。
- 前端代码不再围绕 `language` 做双语分支，而是直接输出中文常量。
- 保持现有页面结构、IPC 接口、运行按钮、日志流与后端行为不变。

## 范围

### In scope

- `electron/renderer/i18n.js`
  - 保留中文消息源。
  - 移除多语言兼容语义，只返回中文。
- `electron/renderer/app.js`
  - 固定中文初始化。
  - 清理语言存储、浏览器语言推导等无效残留。
- `electron/renderer/views.js`
  - 删除所有中英双分支 helper 用法。
  - 所有标签页、状态、占位数据、演示文案统一改成中文常量。
- `electron/tests/*.mjs`
  - 更新与语言相关的断言。
  - 验证页面内不再出现英文 UI 文案或语言切换入口。

### Out of scope

- 前后端联调缺口补齐。
- 页面信息架构调整。
- 文案内容重写或视觉改版。
- 后端、IPC、preload API 扩展。

## 设计决策

### 1. 中文作为唯一渲染语言

渲染层默认且唯一使用 `zh-CN`。`resolveLanguage()` 不再做参数判断，只返回 `zh-CN`；`getMessages()` 不再根据入参切换不同语言包。

### 2. 删除“语言壳”而不是继续保留伪多语言结构

当前代码虽然已经只支持中文，但 `views.js` 里仍大量保留 `pick(language, zh, en)`、英文 tab label、英文状态和英文 fallback。继续保留这些分支只会增加后续联调和维护噪音，因此本轮直接删掉，而不是只隐藏显示层。

### 3. 保持函数边界，但简化参数

不借机做大范围重构。现有 `buildViewModel`、`buildPageMarkup`、`buildLogsPage` 等函数可以继续保留，但会逐步移除已经没有意义的 `language` 双语分支，使渲染层边界保持稳定、改动面可控。

## 实施方式

### `electron/renderer/i18n.js`

- 保留中文消息对象。
- 移除多语言集合和语言选择兼容逻辑。
- `resolveLanguage()` 直接返回 `zh-CN`。
- `getMessages()` 直接返回中文消息对象。

### `electron/renderer/app.js`

- `bootstrap()` 不再依赖本地存储或浏览器语言。
- `state.language` 固定为 `zh-CN`，仅作为兼容字段保留，避免一轮改动触碰过多调用点。

### `electron/renderer/views.js`

- 删除所有英文 fallback 文案：
  - 配置页 tab
  - 日志页/部署页/设置页 tab
  - 运行模式、状态、演示日志、历史记录、部署记录等派生数据
- 删除 `pick(language, ...)` 的双语模式，统一输出中文。
- 保留当前页面 ID、DOM 结构和测试锚点，避免影响既有 e2e / visual 用例结构。

## 风险与控制

- 风险：视觉快照哈希会变化。
  - 控制：更新 visual test 哈希并重新执行截图校验。
- 风险：测试仍依赖旧的 `getMessages('en-US')` 行为。
  - 控制：同步把测试改成“无论传什么都返回中文”或直接不再传英文参数。
- 风险：删除双语分支时误伤页面结构。
  - 控制：保留 DOM 锚点与页面布局不变，只收敛文案与条件分支。

## 验证

- `npm run test:electron`
- 开发态 Electron 页面人工确认：
  - 不存在语言切换入口
  - 不存在 `English`、`Local first`、`Platform`、`General` 等英文显示
  - 11 个页面仍能正常切换

## 验收标准

- 前端页面中不再出现英文 UI 文案。
- 渲染层不再保留双语 fallback 逻辑。
- Electron 测试通过，视觉回归更新完成。
- 本轮不引入后端行为变化。
