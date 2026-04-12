# vpn-subscription-automation

本项目用于把现有 VPN 订阅生产流程封装成一个本地 GUI 自动化工具。

## Current scope

- 管理抓包得到的 5 组源配置
- 编排现有 `vpn-catch-nodes` 抓取脚本
- 对 vmess 节点做去重、测速、后处理
- 回填 `vmess_node.js`
- 本地混淆生成 worker 文件
- 本地部署到 Cloudflare Pages
- 校验最终订阅地址

## Workspace dependencies

默认引用以下 sibling 目录：

- `/Users/swimmingliu/data/VPN/vpn-catch-nodes`
- `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`

## Bootstrap

1. `python3 -m venv .venv`
2. `source .venv/bin/activate`
3. `pip install -e .`
4. `npm install`
5. `npx wrangler login`
6. Install Xray-core and ensure `xray` is on `PATH`
