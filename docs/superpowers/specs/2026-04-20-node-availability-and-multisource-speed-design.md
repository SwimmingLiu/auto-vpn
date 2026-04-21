# Node Availability Verification and Multi-Source Speed Design

## Outcome

在现有 VPN 节点流水线里新增一个严格的节点可用性过滤阶段：节点只有在通过多测速站点平均值阈值后，且同时通过 Gemini、ChatGPT、Claude 三个官网首页的地区可用性验证，才会进入后处理、渲染和部署。Electron 首页同步改成展示“多个测速站点求平均值”的摘要，而不是只展示第一个测速 URL。

## User-Confirmed Rules

- 节点验证目标固定为：
  - `https://gemini.google.com/`
  - `https://chatgpt.com/`
  - `https://claude.ai/`
- 验证标准使用官网首页是否可访问，且不是地区限制页
- 通过规则为 **all-pass**
  - 三个站点必须全部通过
  - 任意一个站点返回地区限制、连接失败、超时、拦截页，都过滤节点
- 中途不再暂停征求意见；如果实现细节有不确定项，优先参考当前开源实现和官方公开文档，再选择最稳妥方案

## Research Basis

截至 2026-04-20，OpenAI、Anthropic、Google 官方帮助文档都明确说明各自服务只在支持地区开放，且地区支持列表会变化。因此实现不应把“支持国家名单”硬编码到仓库，而应通过 **节点代理下的实时站点访问结果** 来判断节点是否可用：

- OpenAI 官方帮助中心说明，来自 unsupported country or region 的访问会被拒绝，且在不支持地区访问服务可能导致账号被封禁
- Anthropic 官方帮助中心说明，Claude.ai 只对 physically located in supported regions 的用户开放
- Google 官方帮助中心说明，Gemini / Gemini Apps 只在支持国家或地区可用

结论：实现使用 **实时首页探测 + 提供商特定的拦截文案匹配**，而不是维护静态国家白名单。

## Pipeline Design

### 1. 多测速站点平均值继续保留，但首页摘要要修正

- 现有 `SpeedTestConfig.urls` 和 `aggregate_speed_measurements()` 已经支持多测速站点求平均值
- 后端逻辑保持“对 `speed_test.urls` 中每个 URL 测速，并求平均下载速度”不变
- 首页“测速配置”卡片改成展示：
  - 最低阈值
  - 并发数
  - 测速站点数量
  - “多个测速站点求平均值”的策略说明
- 详细测速 URL 列表仍放在抽屉中编辑，不在首页摘要里只展示第一个 URL

### 2. 新增 `availability` 节点级站点验证阶段

- 在 `speedtest` 和 `postprocess` 之间新增一个独立阶段：`availability`
- 输入：通过测速阈值的 `fast_results`
- 输出：只保留同时通过 Gemini / ChatGPT / Claude 三站首页验证的节点
- 新阶段保持与速度过滤解耦，这样 UI 可以单独展示“测速通过”和“站点验证通过”两个计数

### 3. Provider 验证策略

- 每个节点通过自身代理分别访问 3 个目标 URL
- 访问方式：
  - 使用与 speedtest 相同的 Xray 本地代理运行时
  - 允许重定向
  - 禁用系统代理继承
  - 默认使用与 speedtest 相同的超时配置，避免再引入一套新超时参数
- 单个 provider 通过条件：
  - 请求成功返回 2xx / 合理的 3xx 跳转链
  - 最终 URL 仍然停留在该 provider 的允许域名内
  - 页面标题或正文 **不包含** 该 provider 的地区限制/不可用文案
- 单个 provider 失败条件：
  - 连接失败、TLS 失败、超时、5xx、代理未建立
  - 最终跳到明显的拦截/不支持页
  - 命中 provider 特定的 negative phrase

### 4. Provider 特定判断规则

实现采用固定的 target registry，而不是把 target 暴露为用户配置。这样能减少 UI 和 profile schema 的改动范围，并保证默认行为稳定。

每个 target 定义：
- `name`
- `url`
- `allowed_hosts`
- `negative_phrases`

初始 target registry：

- Gemini
  - URL: `https://gemini.google.com/`
  - allowed hosts: `gemini.google.com`, `accounts.google.com`
  - negative phrases:
    - `not available in your country`
    - `not available in your country or territory`
    - `isn't available in your country`
    - `not available in your region`

- ChatGPT
  - URL: `https://chatgpt.com/`
  - allowed hosts: `chatgpt.com`, `chat.openai.com`, `auth.openai.com`, `login.openai.com`
  - negative phrases:
    - `unsupported country`
    - `unsupported region`
    - `country, region, or territory`
    - `not available in your country`

- Claude
  - URL: `https://claude.ai/`
  - allowed hosts: `claude.ai`, `support.anthropic.com`
  - negative phrases:
    - `unavailable in your region`
    - `supported regions`
    - `physically located in one of our supported regions`
    - `outside of our supported locations`

说明：
- `allowed_hosts` 允许常见登录跳转，但不会接受跳出 provider 体系的最终域名
- `negative_phrases` 采用小写比较，匹配 title 与 body
- 如果后续线上发现误判，再扩展 phrase table，而不是提前过度设计成复杂规则引擎

### 5. 运行时与代码结构

为了避免在 `speedtest.py` 和新阶段里复制启动 Xray / 建立代理 / 清理子进程的逻辑，需要把节点代理运行时抽到独立模块。

建议新增一个共享运行时模块，例如：

- `src/vpn_automation/pipeline/proxy_runtime.py`

职责：
- 解析 vmess link
- 定位 Xray
- 生成 runtime config
- 启动/关闭 Xray
- 暴露 `requests.Session` + `proxies`

这样：
- `speedtest.py` 专注测速逻辑
- `availability.py` 专注 provider 访问验证逻辑
- 两者复用同一套代理运行时代码

### 6. 输出产物与日志

新增以下产物：

- `vpn_node_availability.txt`
  - 通过三站验证的最终节点列表
- `vpn_node_availability_report.json`
  - 每个节点对三站的逐项验证结果

日志要求：
- 对每个节点输出类似：
  - `[availability] 3/15 chatgpt=ok claude=ok gemini=blocked`
- 当节点被过滤时，日志要能明确看到是被哪个站点拦掉

### 7. Summary Counts

在 pipeline summary 里新增：

- `availability_links`
  - 通过三站验证的节点数
- 保留已有：
  - `raw_links`
  - `deduped_links`
  - `speedtest_links`
  - `postprocess_links`

这样 UI 可以展示：
- 原始节点
- 测速通过
- 三站验证通过
- 校验状态

## UI Changes

### 1. 阶段状态

- 在阶段状态中加入 `availability`
- 顺序改为：
  - doctor
  - extract
  - dedupe
  - speedtest
  - availability
  - postprocess
  - render
  - obfuscate
  - deploy
  - verify

### 2. 测速配置卡片

- 首页测速卡片不再显示单个测速 URL
- 改为显示：
  - `阈值 X MB/s · 并发 Y`
  - `N 个测速站点，按平均下载速度过滤`
- 抽屉仍展示可编辑的完整 URL 列表

### 3. 运行指标卡片

- 新增一行：
  - `三站验证通过 {count}`
- 现有 `测速通过 {count}` 保留

### 4. 文案

- 阶段状态文案新增：
  - 中文：`站点验证`
  - 英文：`Availability`
- 测速卡副标题和摘要文案改成多站点平均值表述

## Config Handling

### 1. Worktree 同步用户更新的 profile

- 当前主工作区的 `state/profiles/default.json` 已经包含用户最新的五个抓包源 URL
- 当前实现 worktree 里没有这份 profile
- 在进入实现前，需要把主工作区 profile 同步到 worktree 中

### 2. 保留用户抓包源更新，补齐多测速 URL

- 同步 profile 时，保留用户更新过的：
  - 5 个 sources URL / key
  - deploy 配置
  - filters
- 同时把 `speed_test.urls` 扩展成多站点默认值：
  - `https://speed.cloudflare.com/__down?bytes=5000000`
  - `https://proof.ovh.net/files/1Mb.dat`
  - `https://cachefly.cachefly.net/1mb.test`
- `workspace` 路径要改写成当前 worktree 路径，避免从 worktree 运行时把产物写回主工作区

## Testing

### Python

- 单元测试：
  - provider negative phrase / allowed host 判定
  - availability all-pass 策略
  - speed summary 文案/状态辅助函数（若抽出 helper）
- controller 集成测试：
  - 节点测速通过但任一 provider 失败时，被过滤
  - 三站都通过时，进入 postprocess

### Electron

- renderer unit/e2e：
  - 测速卡显示“多个测速站点求平均”
  - 新阶段 `availability` 出现在阶段状态中
  - 运行指标出现“站点验证通过 / Availability passed”

### Regression

- 重新跑：
  - Python unit/e2e
  - `npm run test:electron`
  - visual hash（如果首页摘要文案变化导致截图变化）

## Out of Scope

- 不把 provider target registry 做成用户可编辑 UI
- 不维护静态国家白名单
- 不进入各 provider 登录后的聊天产品页
- 不做按 provider 分开放宽的策略（例如“二选三通过”）
