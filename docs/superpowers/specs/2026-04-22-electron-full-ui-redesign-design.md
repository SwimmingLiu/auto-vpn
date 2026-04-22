# Electron 全量多页面 UI 重设计

## 目标

将 `vpn-subscription-automation` 的 Electron 渲染层重构为接近设计稿的多页面桌面工作台：

- 左侧固定导航 + 顶部快捷动作 + 主内容区。
- 首页、配置管理、运行任务、任务历史、节点管理、订阅地址、日志中心、部署设置、系统监控、设置、关于 共 11 个页面均可切换。
- 保留现有真实能力：`profile` 加载/保存、运行流水线、停止流水线、日志流、阶段状态与汇总计数。
- 将现有真实数据映射到新的工作台卡片、表单、日志和统计视图中；缺失的数据使用稳定的本地派生样本填充，保证视觉完整度与测试稳定性。

## 约束

- 不引入重量级 UI 框架，继续使用原生 HTML/CSS/ESM。
- 保持 Electron bridge API 不变，避免影响 main/preload/backend 流程。
- 设计稿中的 `impeccable` skill 当前未安装，因此按设计稿视觉特征手工实现：
  - 浅色工具型桌面界面
  - 左导航、分段标签、数据卡片、表格、深色日志窗
  - 紫色主强调色 + 橙/绿状态色
- UI 变更后必须执行 Playwright 端到端与像素级验证，并把此要求写入 `AGENTS.md`。

## 信息架构

### 全局骨架

- 左侧：品牌、导航、系统状态卡。
- 顶部：页面标题、副标题、快捷动作、运行按钮组。
- 内容区：按页面切换不同布局。

### 页面定义

1. `dashboard`：流程概览、核心配置、运行统计、实时日志、快捷操作、订阅地址、节点分布。
2. `config`：抓包 API / 测速 / 节点处理 / 加密 / 路径 / 部署配置 分段页。
3. `runs`：当前运行任务、阶段进度、执行日志、控制区、输出文件。
4. `history`：任务过滤、汇总指标、历史表格、趋势图、任务详情。
5. `nodes`：节点列表、筛选、分页、节点详情。
6. `subscriptions`：订阅地址卡片、二维码占位、统计信息、说明动作。
7. `logs`：日志标签、过滤器、统计卡、日志表格、右侧详情。
8. `deploy`：平台配置、部署参数、手动操作、部署记录。
9. `monitor`：资源曲线、告警统计、进程排行、系统信息。
10. `settings`：通用设置标签页和表单开关。
11. `about`：产品信息、系统架构图、更新日志、致谢。

## 数据策略

- 真实数据源：
  - `profile.sources`
  - `profile.speed_test`
  - `profile.deploy`
  - `stageStatus`
  - `counts`
  - `logEntries`
  - `runState/runResult/lastUpdateAt`
- 派生数据源：
  - 根据 `counts` 和 `stageStatus` 生成 dashboard / runs / history 统计。
  - 根据 `profile.sources` 和固定区域模板生成节点列表与过滤结果。
  - 根据 `profile.deploy.subscription_url` 生成多客户端订阅地址卡片。
  - 根据 `logEntries` 生成日志中心明细和侧栏详情。
  - 根据固定 deterministic 样本生成监控折线、部署记录、更新日志和 about 架构图。

## 组件边界

- `app.js`：状态、事件、渲染调度、bridge 交互。
- `views.js`：页面级 HTML 片段与可复用 UI 片段生成。
- `styles.css`：完整视觉系统、布局、卡片、表格、图表、响应式。
- `i18n.js`：导航、页面标题、按钮、说明文案。
- `state.js`：阶段顺序、运行状态、派生展示数据辅助函数。

## 交互

- 左侧导航切换主页面，不再滚动定位。
- 顶部快捷动作可跳转到配置、运行、部署等相关页面。
- 保存配置在配置页和全局按钮都可触发。
- 运行/停止按钮全局可见，所有页面共享状态。
- 运行中的日志同步刷新到 dashboard、runs、logs 三处。

## 测试与验收

- 单元测试：状态派生、i18n 文案、窗口配置。
- E2E：用 Playwright 遍历多页面导航，校验关键标题、表单、日志和运行按钮状态。
- 像素级：对 dashboard/config/runs/history/nodes/subscriptions/logs/deploy/monitor/settings/about 截图并校验固定哈希。
- Electron 启动测试：真实 bridge 存在，真实配置可渲染到新的配置页面。
- `AGENTS.md` 更新为“每次 UI/UX 改动或任何行为变更后必须重新执行 Playwright/Computer Use 的 e2e + visual 验证”。
