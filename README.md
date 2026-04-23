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
  - Xray 连通性与多测速源平均下载测速
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
- Xray 代理连通性检测
- 多测速网站平均下载测速
- Gemini / ChatGPT / Claude 首页地区可用性验证
- IP 国家识别与节点命名
- `vmess_node.js` 回填
- JavaScript obfuscation
- Cloudflare Pages 部署与校验

## Canonical Runtime Profile

桌面端当前以这份文件作为**最高优先级主配置**：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profiles/default.json`

说明：

- 如果这份文件存在，Electron / backend 优先读取它
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

默认跟随系统语言，也可以在右上角手动切换中文 / English。

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

## GitHub automation

This repository now includes:

- GitHub Actions CI for Python and Electron tests
- pull-request dependency review
- CodeQL code scanning
- macOS Electron packaging workflow
- manual deploy workflow driven by repository secrets
- Copilot review context files and a pull-request context gate

See [`docs/github-automation.md`](docs/github-automation.md) for the maintainer setup and deploy secret format.
That document now also contains the final GitHub variables / environments / secrets checklist for making the release and deploy workflows production-ready.

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
