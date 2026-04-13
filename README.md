# vpn-subscription-automation

本项目现在采用 **Electron 桌面前端 + Python 自动化后端** 的结构。

## Architecture

- **Electron**
  - 本地桌面窗口
  - UI/UX 控制台
  - 配置编辑
  - 实时日志与阶段状态
- **Python backend**
  - 节点抓取
  - vmess 去重
  - Xray 连通性与下载测速
  - IP 国家识别与节点命名
  - `vmess_node.js` 回填
  - JavaScript obfuscation
  - Cloudflare Pages 部署与校验

## Requirements

- Python 3.12+
- Node.js 24+
- `xray` 已安装并在 `PATH`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.env` 中有：

```env
CLOUDFLARE_API_TOKEN=...
```

## Install

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

## Tests

### Python tests

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3 -m pytest tests -v
```

### Electron / renderer tests

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
node --test electron/tests/*.test.mjs
```

## Package the Electron desktop app

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
npm run package:electron
```

打包输出：

- `dist-electron/mac-arm64/VPN Subscription Automation.app`

## Notes

- Electron app 通过本地 `python3 -m vpn_automation.backend` 调用后端流水线。
- 当前打包产物默认与项目仓库放在一起使用，方便复用 sibling 目录：
  - `/Users/swimmingliu/data/VPN/vpn-catch-nodes`
  - `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`
