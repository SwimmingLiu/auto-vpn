# vpn-subscription-automation

本项目当前采用 **Electron 桌面前端 + Python 自动化后端** 的结构，用于抓取 VPN 节点、测速过滤、地区可用性过滤、渲染产物并部署到 Cloudflare Pages。

## Current Status

截至 2026-04-21，当前主线已完成：

- Electron 紧凑仪表盘首页
  - 半屏优先布局
  - 中英文切换
  - 配置抽屉、阶段状态、日志摘要
- Python 自动化后端
  - 节点抓取
  - vmess 去重
  - Mihomo 连通性与全量下载测速
  - Gemini / ChatGPT / Claude 首页可用性全通过过滤
  - 国家识别、节点命名、模板渲染、JS 混淆
  - Cloudflare Pages 部署与最终校验
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
- 紧凑仪表盘首页
- 配置编辑与保存
- 实时日志与阶段状态
- 通过 IPC 调用本地 Python backend

### Python backend

- 抓取 5 个来源的节点
- vmess 去重
- Mihomo 代理连通性检测
- 基于 GitHub Raw 测速文件的全量下载测速
- Gemini / ChatGPT / Claude 首页地区可用性验证
- IP 国家识别与节点命名
- `vmess_node.js` 回填
- JavaScript obfuscation
- Cloudflare Pages 部署与校验

## Canonical Runtime Profile

桌面端当前以这份文件作为**最高优先级主配置**：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`

说明：

- Electron / backend 都通过 Python 配置层读写这份 TOML 文件
- 当应用从 `.worktrees/` 或打包后的 `.app` 启动时，也会优先回退到这份主配置
- `state/` 目录属于**本地运行时配置**，当前被 `.gitignore` 忽略，不进入 git

这意味着你现在手工更新的 5 个抓包源 URL / key，应当成为桌面端实际读取到的配置来源。

## Repository Layout

```text
src/vpn_automation/          Python backend
electron/                    Electron main / preload / renderer
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
- `mihomo` 已安装并在 `PATH`
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
brew install mihomo
```

## Run the Electron app in development

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run electron:dev
```

默认跟随系统语言，也可以在右上角手动切换中文 / English。

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

## Monitor a manual backend run

在另一个终端里运行：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/monitor_run.sh
```

默认监控最近一次 session。只打印一次快照：

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
./scripts/monitor_run.sh --once
```

监控输出会展示：

- 每个阶段当前状态
- 每个抓取源的 `iter/max`、当前累计节点数、最近新增节点数
- 请求成功/失败、解密成功/失败计数
- speedtest / availability 进度摘要
- 最近日志和卡住告警

## Tests

### Python

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3.12 -m pytest tests -q
```

### Electron / renderer

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run test:electron
```

## Package the Electron desktop app

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run package:electron
```

默认打包输出：

- `dist-electron/mac-arm64/VPN Subscription Automation.app`

## Notes

- Electron app 优先通过项目 `.venv` 的 Python 调用后端；若不存在，则回退到 `python3.12`，最后回退到 `python3`
- 当前打包产物默认与项目仓库放在一起使用，以复用 sibling 目录：
  - `/Users/swimmingliu/data/VPN/vpn-catch-nodes`
  - `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`
- 如果后续要做完全独立分发，需要额外把 Python runtime、依赖和仓库资源一起封装
