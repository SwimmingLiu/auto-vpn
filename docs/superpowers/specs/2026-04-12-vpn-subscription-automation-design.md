# VPN Subscription Automation Design

## Goal

在 `/Users/swimmingliu/data/VPN` 下新增一个独立的本地 GUI 自动化项目，用来统一编排现有 `vpn-catch-nodes` 和 `cloudflarevpn/edgetunnel` 两套流程。用户每次只需要填写抓包得到的几个 URL / key、测速阈值和测速目标，剩余的抓取、去重、测速、节点后处理、`vmess_node.js` 回填、混淆、打包、Cloudflare Pages 部署、部署校验都由本地 GUI 一键完成。

## Chosen Approach

### Recommended architecture

- **主入口**：本地桌面 GUI
- **实现语言**：Python 3.12
- **GUI 框架**：标准库 `tkinter` + `ttk`
- **执行模式**：**全本地执行为默认路径**
- **测速内核**：**Xray-core**（优先支持 vmess）
- **混淆方式**：本地调用 `javascript-obfuscator`
- **Cloudflare 部署**：本地调用 `wrangler pages deploy`
- **GitHub Actions**：仅保留为可选 fallback，不作为默认主链路

### Why this approach

1. 现有节点抓取逻辑已经是 Python，直接复用成本最低。
2. `tkinter` 不需要额外 GUI 运行时，适合先快速做出稳定桌面工具。
3. 本地执行可以去掉“改文件 → push → 等 Actions → 手工下载/上传”的长链路。
4. Cloudflare Pages 已支持通过 Wrangler 做本地直接上传部署，适合替代手工上传 zip。
5. 将自动化项目单独放到新目录，并用独立 private repo 管理，可以避免污染现有两个历史项目。

## Alternative approaches considered

### Option A — Python desktop app + local pipeline (**chosen**)

优点：

- 能最大化复用现有 Python 脚本
- 部署链路最短
- 调试成本最低
- 后续可逐步把旧脚本吸收到统一框架

缺点：

- GUI 观感不如 Web 技术栈现代
- 跨平台包装体验一般

### Option B — Tauri / Electron desktop shell + Python backend

优点：

- UI 更现代
- 更容易扩展成 Web/桌面双栈

缺点：

- 技术栈更复杂
- 需要同时维护前端、桌面壳、Python/Node 进程编排
- 对当前“先尽快跑通全链路自动化”的目标不划算

### Option C — 本地 Web 控制台 + 后端服务

优点：

- 后续最容易扩成云端服务
- UI 交互灵活

缺点：

- 对“本地 GUI 优先”的目标不如桌面应用直接
- 需要处理本地服务生命周期、端口占用、浏览器唤起等问题

## Scope

### In scope

- 管理 5 个 VPN 源配置（URL / key / 启停）
- 一键执行完整流水线
- 节点去重
- 节点连通性与下载速度测试
- 按国家缩写和 emoji 后处理
- 生成并回填 `vmess_node.js` 的 `MainData`
- 本地执行混淆，生成 `vmess_node_worker.js`
- 生成 Cloudflare Pages 部署目录
- 通过 Wrangler 自动部署到 Pages
- 部署结果校验与失败重试
- GUI 中展示日志、阶段状态、产物路径
- 将自动化项目单独放入 private GitHub repo

### Out of scope for phase 1

- 自动抓包
- 云端多用户系统
- 彻底重写现有抓取算法
- 将现有两个旧项目改造成 monorepo
- 支持所有协议类型（phase 1 先聚焦 vmess）

## Workspace layout

新项目目录：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation`

该项目作为控制器，默认通过配置引用现有 sibling 目录：

- `/Users/swimmingliu/data/VPN/vpn-catch-nodes`
- `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`

这样可以先自动化现有流程，而不是一开始就迁移全部历史代码。

## High-level data flow

1. GUI 读取本地 profile
2. 用户点击“开始执行”
3. Pipeline 先做环境检查：
   - Python 依赖
   - Node/npm
   - `javascript-obfuscator`
   - `wrangler`
   - `gh`
   - `xray`
4. 根据 profile 更新 `vpn_api.json`
5. 顺序或有限并发执行 5 个抓取源
6. 读取 `output/vpn_node.txt`
7. 对 vmess 节点做解析、标准化、去重
8. 用 Xray-core 对每个节点做：
   - 基础连通性测试
   - 下载速度测试
9. 只保留达到阈值的节点，写入 `vpn_node_speedtest.txt`
10. 进行国家 / emoji 后处理，写入 `vpn_node_emoji.txt`
11. 将结果渲染进 `vmess_node.js` 的 `MainData`
12. 本地执行混淆生成 `vmess_node_worker.js`
13. 生成 Pages 部署目录（包含 `_worker.js`）
14. 本地调用 Wrangler 部署到 Cloudflare Pages 项目 `vmessnodes`
15. 请求订阅 URL 做部署校验
16. GUI 展示最终状态、失败阶段、产物目录

## Detailed component design

### 1. GUI layer

GUI 使用 `tkinter` / `ttk`，采用单窗口多区域布局：

- 左侧：配置表单
- 中间：执行控制和阶段状态
- 右侧：日志流
- 底部：最近产物和快捷操作

表单字段分为三组：

- **源配置**：5 个抓包 URL 与 key
- **测速配置**：最低下载速度、超时、并发数、测速 URL 列表
- **部署配置**：Pages 项目名、部署目录、订阅校验 URL、是否启用 fallback

### 2. Config store

配置分两类：

- **持久化业务配置**：保存到新项目下 `state/profiles/default.json`
- **认证状态**：不由应用自己保存；直接复用 `gh auth` 与 `wrangler` 登录状态

这样可以减少密钥管理复杂度，避免把 Cloudflare / GitHub token 再存一份。

### 3. Source runner

不直接重写原有抓取逻辑，phase 1 先做“编排适配层”：

- 更新 `vpn-catch-nodes/config/vpn_api.json`
- 调用已有脚本：
  - `run/leiting.py`
  - `run/heidong.py`
  - `run/mifeng.py`
  - `run/xuanfeng1.py`
  - `run/xuanfeng2.py`
- 将抓取输出统一汇总到 automation 项目自己的 artifact 目录

Phase 2 再考虑把抓取能力彻底抽到新项目内部。

### 4. Node normalization and dedupe

对每条 vmess 链接进行解码，抽取以下 canonical key：

- `add`
- `port`
- `id`
- `net`
- `host`
- `path`
- `tls`
- `sni`

以 canonical key 去重，而不是单纯按整行字符串去重。这样能消除备注不同但实际同节点的重复项。

### 5. Speed test engine

测速使用 Xray-core，原因：

- vmess 支持成熟
- 本地可临时启动单节点出站
- 配置生成简单

测速分两段：

1. **连通性检查**
   - 目标：快速过滤死节点
   - 方式：通过本地临时 HTTP/SOCKS 代理请求一个可配置探活 URL
2. **下载测速**
   - 目标：计算 MB/s
   - 方式：在固定时窗内下载用户配置的测试 URL
   - 输出：平均速度、峰值速度、耗时、成功目标数

测速 URL 采用“可配置 + 内置默认 preset”的方式。默认 preset 选择国际可达、HTTPS、静态资源型目标；用户可自行覆盖。

### 6. Node post-process

国家识别沿用现有“按 IP 获取国家信息并给节点名加 emoji”的思路，但要做成新项目内的纯函数模块，并消除写死 Windows 路径的问题。

规则：

- CN 直接过滤
- HK / TW 不再硬编码只保留极少量，改为可配置上限
- 节点命名统一为：`<emoji> <country-code> <original-ps>`

### 7. Template render and obfuscation

保留现有 `vmess_node.js` 的结构，不改业务逻辑，只替换 `MainData` 的文本块。

主链路：

1. 从 `vmess_node.js` 读取模板
2. 替换 `MainData`
3. 输出工作副本到新项目 artifact
4. 本地执行：
   - `npx javascript-obfuscator vmess_node.js --output vmess_node_worker.js ...`

这样可以完全替代现在的 GitHub Actions `Obfuscate Vmess Node`。

### 8. Cloudflare Pages deploy

默认部署方式改为：

- 生成部署目录
- 将混淆结果命名为 `_worker.js`
- 本地调用：
  - `npx wrangler pages deploy <deploy-dir> --project-name vmessnodes`

这条链路替代“复制改名 → 打 zip → dashboard 手工上传”。

### 9. Deployment verification

部署成功不以 CLI 返回码为唯一标准，还要追加校验：

- 访问最终订阅地址
- 检查响应码
- 检查响应体是否符合预期格式
- 如失败，按策略重试：
  - 重新混淆一次
  - 重新部署一次

### 10. Artifact management

每次运行创建独立目录：

- `artifacts/YYYYMMDD-HHMMSS/`

包含：

- `vpn_node_raw.txt`
- `vpn_node_deduped.txt`
- `vpn_node_speedtest.txt`
- `vpn_node_emoji.txt`
- `vmess_node.js`
- `vmess_node_worker.js`
- `pages_bundle/_worker.js`
- `run_report.json`

这样能保证可追溯、可回放、可比较。

## Failure handling

### Stage-level failure policy

- 抓取单源失败：记录失败，但不立即终止整批；最终按成功源继续
- 去重失败：终止流程
- 测速阶段异常：记录失败节点并继续其余节点
- 混淆失败：允许执行一次依赖修复和重试
- 部署失败：先重试部署；若怀疑混淆产物问题，再回退到“重新混淆 + 重部署”

### Operator visibility

GUI 需要明确显示：

- 当前阶段
- 当前节点数 / 已测速数 / 保留数
- 失败源列表
- 部署返回摘要
- 最终订阅校验结果

## Verification strategy

### Automated verification

- 单元测试：
  - vmess 解析 / 生成
  - canonical dedupe key
  - `MainData` 替换
  - Pages 部署目录生成
- 集成测试：
  - 用 fixture 节点文件跑“去重 → 渲染”链路
  - 对 deploy adapter 做命令拼装测试

### Manual verification

- GUI 启动 smoke test
- 仅跑抓取链路
- 仅跑测速链路
- 仅跑渲染 + 混淆 + 打包
- 对真实 Pages 项目做一次完整部署

## Initial repository plan

新建 private GitHub repo：

- `SwimmingLiu/vpn-subscription-automation`

本仓库仅管理自动化控制器本身，不直接吞并现有两个历史仓库。自动化控制器通过路径配置操作 sibling 目录。

## Implementation phases

### Phase 1

- 桌面 GUI
- 配置持久化
- 抓取编排
- 去重
- Xray 测速
- 节点后处理
- `MainData` 替换
- 本地混淆
- Cloudflare Pages 部署
- 部署校验

### Phase 2

- GitHub Actions fallback 触发与监控
- 更丰富的测速 preset
- 更细的失败重跑策略
- 一键打包桌面应用

## Design decisions locked in

- **桌面形态锁定为本地 GUI**
- **执行链路锁定为本地优先**
- **Cloudflare 部署锁定为 Wrangler 直传**
- **GitHub Actions 降级为 fallback**
- **测速内核锁定为 Xray-core**
- **自动化项目与现有项目分离**
- **新项目使用独立 private GitHub repo 管理**
