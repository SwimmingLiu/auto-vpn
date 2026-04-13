# Electron GUI Pivot Design

## Outcome

将桌面程序从 Tk GUI 切换为 Electron，本地 Python 流水线保留为后台执行引擎。最终用户入口为 Electron 应用，不再把 Python GUI 作为交付界面。

## Architecture

- Electron renderer：现代深色控制台风格 UI
- Electron main：本地桌面集成、IPC、子进程管理
- Python backend CLI：profile bootstrap、pipeline run、JSONL event stream

## UI/UX direction

- 左侧导航
- 顶部 hero 区
- 中间 source / settings 卡片
- 右侧 metrics / stages / log 面板
- 深色渐变、卡片化、明显的状态 chip 和主 CTA

## Packaging

- 最终交付物改为 Electron app
- 后端继续复用本机 Python3 环境和仓库中的 `src/vpn_automation`

## Verification

- Python tests
- Electron node tests
- Electron renderer e2e
- Electron renderer visual hash
- 打包后的 Electron app 启动 smoke test
