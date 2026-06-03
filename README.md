# vpn-subscription-automation

本项目当前采用 **Electron 桌面前端 + Python 自动化后端** 的结构，用于抓取 VPN 节点、测速过滤、地区可用性过滤、渲染产物并部署到 Cloudflare Pages。

## Current Status

截至 2026-04-25，当前主线已完成：

- Electron 六页桌面工作区
  - 中文唯一界面
  - 概览 / 运行 / 结果 / 订阅 / 日志 / 设置
  - 设置抽屉、阶段状态、日志筛选、结果预览
- Python 自动化后端
  - 节点抓取
  - vmess 去重
  - Xray 连通性与多测速源平均下载测速
  - Gemini / ChatGPT / Claude 首页可用性全通过过滤
  - 国家识别、节点命名、模板渲染、JS 混淆
  - Cloudflare Pages 部署与最终校验
- 运行时与恢复能力
  - TOML 主配置
  - SQLite checkpoint (`run.db`)
  - 最近未完成运行恢复
  - 监控脚本读取最新运行状态
- macOS Electron 打包链路
  - 可生成 `.app`
  - 打包态与开发态共享同一份主配置文件

当前仍保持的约束：

- 打包产物 **依赖当前源码仓库与本地 Python 环境**
- 还没有做“完全独立的内嵌 Python 发行版”

## Architecture

### Electron

- 本地桌面窗口
- UI/UX 控制台
- 六页工作区
- 配置编辑与保存
- 实时日志与阶段状态
- 通过 IPC 调用本地 Python backend

### Python backend

- 抓取 5 个来源的节点
- vmess 去重
- Xray 代理连通性检测
- 多测速网站平均下载测速
- Gemini / ChatGPT / Claude 首页地区可用性验证
- IP 国家识别与节点命名
- `vmess_node.js` 回填
- JavaScript obfuscation
- Cloudflare Pages 部署与校验
- SQLite checkpoint / resume

## Canonical Runtime Profile

桌面端当前只使用这份文件作为**唯一运行时主配置**：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`

说明：

- 配置文件格式为 TOML，可直接手工编辑
- Electron / backend 都通过 Python backend 读写这份 TOML
- 当应用从 `.worktrees/` 启动时，配置仍锚定到主仓库 `state/profile.toml`
- `state/` 目录属于**本地运行时配置**，当前被 `.gitignore` 忽略，不进入 git
- 旧路径 `state/profiles/default.json` 已废弃，不再参与运行

你现在需要手工维护的配置，都应当写在这份 TOML 文件里。

当前为了缩短真实抓取时长，默认 source 配置里的 `max_iterations` 已临时统一降到 `5000`。

### Worker build configuration

`profile.toml` 现在额外包含一个 `[worker_build]` 配置段，用来控制 Worker 构建环境、变量命名前缀、注释模板、基础关键词拆分，以及是否输出模块化 sidecar 文件。

默认配置示例：

```toml
[worker_build]
environment_name = "production"
entry_filename = "_worker.js"
bundle_subdir = "pages_bundle"
modules_subdir = "modules"
manifest_filename = "manifest.json"
variable_prefix = "sg"
comment_template = "subscription worker: returns encoded payload on secret match, random bytes otherwise"
random_noise_min_length = 24
random_noise_max_length = 96
enable_keyword_fragmentation = true
enable_identifier_randomization = true
emit_sidecar_modules = true
```

这组配置当前不在设置页暴露，默认通过 TOML 手工维护；设置页仍只负责常用 deploy 配置。

### Packaged seed profiles

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/default-profile.toml`
  - 受版本控制
  - 作为**打包时的空白回退 seed**
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/bundled-profile.toml`
  - **不纳入版本控制**
  - 由 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/build/package.mjs` 在打包前自动生成
  - 优先复制当前 `state/profile.toml`；如果运行时主配置不存在，再退回 `default-profile.toml`

不要手工维护 `bundled-profile.toml`，它是打包派生产物，不是源码真相。

## Repository Layout

```text
src/vpn_automation/          Python backend
electron/                    Electron main / preload / renderer
templates/                   内置模板资源
tests/                       Python tests
docs/superpowers/specs/      设计文档
docs/superpowers/plans/      实施计划
state/                       本地运行配置（git ignore）
artifacts/                   流水线输出目录（git ignore）
dist-electron/               Electron 打包产物（git ignore）
.worktrees/                  隔离开发工作树（git ignore）
```

## Requirements

- Python 3.12+
- Node.js 24+
- `xray` 已安装并在 `PATH`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.env` 中有：

```env
CLOUDFLARE_API_TOKEN=...
```

## Setup

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
npm install
npx playwright install chromium
brew install xray
```

## Run the Electron app in development

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run electron:dev
```

当前 Electron UI 为中文唯一界面，不再提供中英文切换。

## Run the backend pipeline manually

如果这次只想验证后端真实链路，不经过 Electron，直接运行：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh
```

默认行为：

- 真实执行 `doctor -> extract -> dedupe -> speedtest -> availability -> postprocess -> render -> obfuscate`
- 默认跳过 `deploy` 和 `verify`
- 为本次运行创建独立 session 目录：
  - `artifacts/manual-runs/<session-id>/events.jsonl`
  - `artifacts/manual-runs/<session-id>/human.log`

只看本次将执行什么但不真正启动：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh --dry-run
```

如果后面要重新打开真实部署：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/run_backend_pipeline.sh --with-deploy --with-verify
```

## Monitor a backend run

在另一个终端里运行：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/monitor_run.sh
```

只打印一次快照：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/monitor_run.sh --once
```

监控输出会展示：

- 每个阶段当前状态
- 每个抓取源的 `iter/max`、当前累计节点数、最近新增节点数
- speedtest / availability / final link 摘要
- 最近 extract attempts
- 卡住告警

## Pages deploy model (`sub-nodes`)

当前 Pages 生产部署目标固定走 `sub-nodes` 项目，部署链路如下：

1. render 生成：
   - `artifacts/<run>/vmess_node.js`
2. transform 生成：
   - `artifacts/<run>/worker_transformed.js`
3. obfuscate 生成：
   - `artifacts/<run>/_worker.js`
4. package 生成：
   - `artifacts/<run>/pages_bundle/_worker.js`
   - `artifacts/<run>/pages_bundle/modules/*.js`
   - `artifacts/<run>/pages_bundle/manifest.json`
5. Pages deploy 命令：
   - `npx wrangler pages deploy <pages_bundle> --project-name <project_name> --branch main`

这里的 `--branch main` 不是可有可无：

- 不带 `--branch main` 时，Wrangler 会按当前本地 git 分支创建 **Preview** 部署
- `https://sub-nodes.pages.dev` 只会跟随 **Production / main**
- 因此要让 `pages_project_url` 指向的正式地址立即更新，必须显式部署到 `main`

设置页中的 deploy 配置字段含义：

- `project_name`
  - Cloudflare Pages 项目名
  - 当前默认值：`sub-nodes`
- `pages_project_url`
  - 对应正式访问地址
  - 当前默认值：`https://sub-nodes.pages.dev`
  - 当用户尚未手动覆盖时，会随 `project_name` 自动联动为 `https://<project_name>.pages.dev`
  - 一旦用户手动修改过，后续再改 `project_name` 不会覆盖手动值
- `subscription_url`
  - 页面展示与二维码使用的主订阅地址
- `verify_subscription_url`
  - deploy 后 verify 阶段使用的健康检查订阅地址
  - 当前默认值：`https://www.swimmingliu.xyz/sub?token=8410fb43eb2176497f5beafc0c39f5bc`
  - 如果留空，运行时会退回使用 `subscription_url`
- 设置页会额外显示辅助说明，保存后 toast 也会显式回显当前 deploy 目标

postprocess 阶段的最终区域装饰规则：

- 有效国家码保持原样
- `ZZ`、非法国家码、GeoIP 查询失败统一降级到 `US`
- 因此最终节点名称会稳定显示为 `🇺🇸 US ...`，避免看起来像“没有加国旗”

旧 deploy 默认值会在首次加载配置时自动迁移并写回：

- `vmessnodes` + `https://vmess2clash.pages.dev` -> `sub-nodes` + `https://sub-nodes.pages.dev`
- `vms-nodes` + `https://vms-nodes.pages.dev` -> `sub-nodes` + `https://sub-nodes.pages.dev`

更完整的部署说明与 2026-04-29 验证记录见：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/docs/deploy-pages-sub-nodes.md`

## Resume support

主线当前支持：

- 从最近未完成的 `run.db` 自动恢复
- 从已有 artifact/session 继续执行 speedtest 或后续 pipeline

相关运行时数据会落在：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/<run>/run.db`

## Tests

### Python

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/run_pytest.sh tests -v
```

### Electron / renderer

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run test:electron
```

### Full suite

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run test:all
```

## Package the Electron desktop app

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run package:electron
```

默认打包输出：

- `dist-electron/mac-arm64/AutoVPN.app`

## Notes

- Electron app 优先通过项目 `.venv` 的 Python 调用后端；若不存在，则回退到 `python3.12`，最后回退到 `python3`
- pipeline 模板资源已内置在当前仓库：
  - `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js`
- packaged app 打包前会生成内置 seed profile：
  - `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/bundled-profile.toml`
- 如果当前没有 live profile，则 `bundled-profile.toml` 会退回复制：
  - `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/default-profile.toml`
- 每次 pipeline 运行会在 artifact 目录下生成：
  - `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/<run>/run.db`
- 可用以下脚本读取最新 SQLite checkpoint：
  - `/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/monitor_run.sh`
- 当设置 `VPN_AUTOMATION_UPSTREAM_PROXY` 时，所有启用的 source 抓取请求都会统一走这个代理
- 运行时不再依赖 sibling 目录：
  - `vpn-catch-nodes`
  - `cloudflarevpn/edgetunnel`
- 如果后续要做完全独立分发，需要额外把 Python runtime、依赖和仓库资源一起封装
