# vpn-subscription-automation

本项目把现有 VPN 订阅抓取、测速、节点加工、`vmess_node.js` 回填、混淆、Cloudflare Pages 部署和结果校验封装成一个本地 GUI 工具。

## Current capabilities

- 管理 5 组抓包 URL / key
- 直接从抓包接口拉取并解密节点
- 基于 vmess 字段做去重
- 基于 Xray-core 做可达性和下载测速
- 根据 IP 国家信息给节点加国家缩写和 emoji
- 自动回填 `vmess_node.js`
- 本地执行 `javascript-obfuscator`
- 通过 Cloudflare API token + Wrangler 自动部署到 Pages
- 校验 `vmess2clash.pages.dev` secret endpoint 和最终订阅 URL
- 打包为本地可运行 GUI 应用

## Workspace dependencies

默认引用以下 sibling 目录：

- `/Users/swimmingliu/data/VPN/vpn-catch-nodes`
- `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`

## Environment

Cloudflare API Token 默认从以下文件读取：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.env`

格式：

```env
CLOUDFLARE_API_TOKEN=...
```

## Bootstrap

1. `python3 -m venv .venv`
2. `source .venv/bin/activate`
3. `pip install -e .[dev]`
4. `brew install xray`
5. 确保 `.env` 中有 `CLOUDFLARE_API_TOKEN`

## Run the GUI

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3 -m vpn_automation.app
```

## Run tests

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3 -m pytest tests -v
```

## Build the packaged app

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
python3 -m vpn_automation.app --package
```

打包产物默认在：

- `dist/VPNSubscriptionAutomation.app`
- `dist/VPNSubscriptionAutomation/`
