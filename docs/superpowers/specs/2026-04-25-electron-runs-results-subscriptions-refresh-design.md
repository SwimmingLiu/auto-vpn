# Electron 运行页、结果页、订阅页与设置页刷新设计

## 背景

当前 Electron 客户端已经完成六页工作区切分，但在真实运行过程中暴露出一组连续的交互与信息架构问题：

- 运行中每收到日志或阶段事件，前端都会调用全量 `renderAll()`，导致 `#pageActions` 与 `#pageContent` 整块重建。
- 运行页同时存在顶部按钮组和页内按钮组，控制入口重复；页面内还混入最近日志，和独立日志页重复。
- 结果页主要展示 artifact 文件列表，没有把 pipeline 最终留下的节点以可用信息的形式展示出来。
- 订阅页顶部和页内存在重复操作按钮，格式切换区过于紧凑，不符合用户希望“不要把所有组件都聚拢在一块”的要求。
- 设置页的数据源配置只能编辑地址、密钥、启用状态，缺少“所有数据源统一最大迭代次数”的入口。
- 所有页面都出现“顶部介绍 + 内容区二级介绍”的双重说明，视觉和语义都重复。

## 根因证据

本轮先做被动分析与最小复现，确认运行页闪烁和点击失效不是 Electron 或 CSS 本身的问题，而是渲染策略问题。

### 代码证据

`/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`

- `appendLog()` 每次追加日志都会调用 `renderAll()`
- `handlePipelineEvent()` 在 `log`、`stage`、`summary`、`run_started` 等路径里都会触发 `renderAll()`
- `renderAll()` 每次都会重写：
  - `elements.pageActions.innerHTML`
  - `elements.pageContent.innerHTML`

这意味着运行过程中按钮节点会被频繁销毁并重建。

### 复现实验

使用 Playwright 构造运行页并连续发送日志事件后，监控运行页主按钮 DOM 替换次数：

- 8 条日志事件 -> 运行页“开始运行”按钮被替换 8 次
- 在 `mousedown` 与 `mouseup` 之间插入一次日志事件，最终 `runPipeline` 调用次数为 0

这解释了用户看到的三个现象：

1. 按钮持续闪烁：DOM 被重建，hover/active/focus 状态反复丢失。
2. 按钮偶发失效：点击过程中的节点被替换，浏览器不会把 `mouseup/click` 交给新节点。
3. 需要多次点击：只有在事件空档点中的那次点击才可能成功。

## 目标

本轮只做 Electron 渲染层与预览逻辑的重构，不改 backend 流水线协议。

1. 修复运行中频繁闪烁与点击丢失问题。
2. 去掉运行页、结果页、订阅页的重复按钮与重复介绍。
3. 让设置页支持“所有数据源统一最大迭代次数”。
4. 把结果页改成“最终节点视图”，展示 pipeline 过滤后的最终节点。
5. 把订阅页改成更舒展的 tab 切换布局，保持足够留白。
6. 保持现有六页结构、中文界面和浅色蓝紫视觉基调不变。

## 非目标

- 不重写 Python backend 的阶段定义和事件协议。
- 不引入新的前端框架。
- 不改变 Electron main/preload 的 IPC 总体分层。
- 不在本轮加入新的订阅格式或新的 pipeline 阶段。

## 方案比较

### 方案 A：仅删重复按钮和文案

- 只删除运行页/订阅页顶部重复按钮
- 只把结果页表头换一下
- 保持现有 `renderAll()` 策略不变

优点：改动小。  
缺点：无法解决闪烁和点击失效这个根因问题。

### 方案 B：运行时局部渲染 + 页面信息重整（推荐）

- 保留当前文件组织
- 限制高频事件对 DOM 的影响范围
- 运行页、结果页、订阅页、设置页分别重做局部布局
- `artifact:preview` 补充真实节点解析，结果页直接消费

优点：能同时覆盖根因修复和用户提出的 6 类产品问题。  
缺点：需要同步更新 e2e、visual 和 backend preview 测试。

### 方案 C：整套 renderer 重画

- 再次大规模改写 `views.js` / `styles.css`
- 统一重排六页

优点：统一度最高。  
缺点：范围过大，不符合本轮反馈的边界。

## 选型

采用 **方案 B**。

这条路线既能解决运行页交互失效的根因，又能把结果页、订阅页和设置页改到“可用且符合反馈”的状态，同时不需要重写后端协议。

## 交互决策

本轮采用以下确定决策：

- 运行页保留 **一组主运行按钮**，顶部不再重复提供运行控制。
- 运行页 **移除最近日志面板**，日志统一到日志页。
- 订阅页采用 **上方 tab + 中部主内容 + 下方留白统计区** 的布局，不做紧凑型分段控件。
- 数据源最大迭代次数采用 **统一配置、批量写入各 source.max_iterations** 的方式。
- 结果页直接展示 **最终节点列表 + 区域统计卡片**，不再让 artifact 文件列表占据主视图。
- 页内重复的第二份标题介绍统一删除，仅保留顶部 `pageTitle + pageSubtitle`。

## 页面级设计

### 1. 运行页

#### 保留内容

- 主运行控制区
- 阶段进度
- 当前阶段详情

#### 删除内容

- 顶部 `pageActions` 中的 `开始运行 / 停止运行 / 重试当前阶段`
- 页内“最近日志”面板
- 内容区重复的 “02 运行 / 执行流水线...” 二级头部

#### 交互调整

- 运行页只保留页内一组按钮：
  - 开始运行
  - 停止运行
  - 重试当前阶段
- 按钮 disabled 态由 `resolveRunControlState()` 控制
- `retry-current-stage` 暂仍复用现有 run 入口，不改变 backend 语义

### 2. 结果页

#### 信息结构

结果页改成三块：

1. 顶部结果摘要
   - Artifact 目录
   - 最终节点数量
   - 最近更新时间
2. 区域统计卡片区
   - 按区域/国家码统计节点数量
3. 最终节点列表
   - 序号
   - 节点名称
   - IP 地址
   - 协议
   - path

#### 数据来源

- 优先读取 `vpn_node_emoji.txt`
- 若不存在，则 fallback：
  - `vpn_node_availability.txt`
  - `vpn_node_speedtest.txt`

#### 节点解析

对 `vmess://` 做 base64 解码，提取：

- `ps` -> 节点名称
- `add` -> 地址/IP
- 固定协议 -> `vmess`
- `path` -> 路径

若 `ps` 里存在区域前缀（例如 `🇺🇸 US xxx`），优先抽取国家码统计；否则归入“其他”。

#### 按钮

- 删除顶部结果页按钮
- 页面内部保留：
  - 复制节点
  - 打开 artifact 目录

产物文件列表不再作为主模块；如果保留，只能降级成次要信息块，不允许继续占据主要空间。

### 3. 订阅页

#### 设计原则

- 不做紧凑布局
- 组件之间保留明显间距
- tab 区、地址区、二维码区、操作区、统计区分层摆放

#### 布局

订阅页采用三段布局：

1. 上方 tab 区
   - `Clash`
   - `Clash Meta`
   - `Sing-box`
   - `Surge`
   - 放在一个横向 tab rail 中，active tab 有滑动/高亮效果
2. 中部主内容区
   - 左侧：当前订阅地址、说明、复制/打开按钮
   - 右侧：二维码
3. 下方信息区
   - 最后生成时间
   - 最终节点数量

#### 调整项

- 删除顶部 `复制链接 / 打开订阅`
- 页面主体保留一组操作按钮
- 原“主订阅地址”不再是单一静态卡片，而是与 tab 联动

### 4. 设置页

#### 数据源配置

在数据源配置抽屉中新增统一字段：

- `最大迭代次数`

位置在数据源表格顶部，作为整个分组的公共参数，而不是每行都显示一个输入框。

#### 保存逻辑

- 抽屉中的统一 `最大迭代次数` 修改后，保存时批量写回所有 `draft[source].max_iterations`
- 保留每个来源的：
  - 启用
  - 地址
  - 密钥
- 不新增每个来源独立的 max_iterations 列，避免表格拥挤

#### 概览卡片摘要

“数据源配置”卡片摘要需体现：

- 启用源数量
- 当前统一最大迭代次数

### 5. 全局页面介绍

所有页面统一采用：

- 顶部 `#pageTitle`
- 顶部 `#pageSubtitle`

删除 `buildPageMarkup()` 里现有的 `page-header-card` 二级介绍头部，避免所有页面出现两份标题与说明。

## 渲染策略调整

### 当前问题

高频事件路径会触发整页重渲染：

- `appendLog()`
- `handlePipelineEvent(log/stage/summary/run_started)`
- 输入变更中的部分 `renderAll()`

### 新策略

按更新频率拆分：

1. **高频局部更新**
   - 日志追加只更新日志页容器和必要计数
   - 运行中阶段状态变化只更新运行页中的阶段相关区域
2. **低频整页更新**
   - 页面切换
   - 设置抽屉开关
   - profile 加载/保存
   - 结果预览完成

### 最小实现边界

不引入虚拟 DOM。

仍保留 `renderAll()` 作为低频路径，但新增：

- `renderPageActions()`
- `renderPageContent()`
- `renderRunsPanels()`
- `renderLogsPanel()`
- `renderResultsPanels()`

并确保 `appendLog()` 不再调用整页 `renderAll()`。

## 后端预览数据扩展

### 当前问题

`/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js` 中的 `artifact:preview` 只返回：

- `outputFiles`
- `nodeRows`（仅前 10 条，且只是 hostname 摘要）

这不足以支撑新的结果页。

### 新返回结构

`artifact:preview` 扩展返回：

- `outputFiles`
- `nodeRows`
  - `name`
  - `address`
  - `protocol`
  - `path`
  - `link`
  - `regionCode`
- `regionCards`
  - `regionCode`
  - `count`
- `finalNodeCount`

仍保持兼容：如果找不到最终节点文件，返回空数组。

## 状态模型调整

前端状态新增：

- `regionCards`
- `finalNodeCount`

前端状态继续保留：

- `subscriptionFormat`
- `logFilter`
- `settingsDrawer`
- `outputFiles`
- `nodeRows`

其中 `nodeRows` 从“简单预览行”升级为“结果页最终节点实体”。

## 代码组织

### `electron/renderer/app.js`

- 拆分高频与低频渲染路径
- 运行事件不再默认全量 `renderAll()`
- 设置抽屉保存时支持统一 `max_iterations`
- 结果预览写入：
  - `nodeRows`
  - `regionCards`
  - `finalNodeCount`

### `electron/renderer/views.js`

- 删除 `page-header-card`
- 重写：
  - `buildRunsPage()`
  - `buildResultsPage()`
  - `buildSubscriptionsPage()`
  - `buildSettingsDrawerBody()`
- 新增：
  - 结果区域卡片渲染
  - 更宽松的 tab rail 渲染
  - 统一数据源迭代次数字段渲染

### `electron/renderer/styles.css`

- 删除导致视觉重复的页面二级头部相关样式
- 为订阅页增加更宽松的：
  - tab rail
  - 双栏主体
  - 底部信息区
- 为结果页增加：
  - 区域卡片 grid
  - 新节点表格列宽
- 为运行页移除终端日志块后重新分配布局

### `electron/ipc.js`

- 扩展 `artifact:preview` 的最终节点解析逻辑
- 解析 vmess，构造结果页真实需要的数据

### 测试

需要更新：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`（必要时补 preview 数据相关样本）

## 验证策略

1. Node test 验证状态派生与 preview 解析。
2. Playwright e2e 验证：
   - 运行页只有一组主运行按钮
   - 运行页不再展示最近日志面板
   - 设置抽屉可配置统一最大迭代次数
   - 结果页展示最终节点字段
   - 订阅页顶部按钮已移除，tab 切换能更新 URL/二维码
3. Playwright 视觉回归更新六页 hash。
4. Computer Use 检查：
   - 运行过程中按钮不再闪烁
   - 订阅页布局不紧凑，组件间有明显留白
   - 结果页信息层级正确

## 风险与处理

### 风险 1：局部渲染后页面状态不同步

处理：

- 保留 `renderAll()` 作为低频兜底路径
- 高频区域使用明确的单区域渲染函数
- 通过 e2e 覆盖运行中日志追加、阶段切换、页面切换

### 风险 2：最终节点文件缺失或内容异常

处理：

- `artifact:preview` 容错 fallback
- 单条 vmess 解析失败时跳过并继续
- 页面展示明确 empty state

### 风险 3：订阅页为了 tab rail 引入新的紧凑问题

处理：

- tab rail 使用较大 padding、卡片间距和分层布局
- 视觉验证中把“不可过度紧凑”作为显式检查项

## 结论

本轮改造应先解决运行页的高频整页重渲染根因，再同步完成结果页、订阅页、设置页和全局标题结构的整理。这样既能解决“频繁闪烁、点击失效”，也能把用户指出的重复按钮、无效结果页和过于紧凑的订阅布局一次性修正到位。
