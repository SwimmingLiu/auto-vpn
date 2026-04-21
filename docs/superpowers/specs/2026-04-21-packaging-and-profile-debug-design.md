# Packaging and Profile Debug Design

## Outcome

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation` 完成一条可复现的交付链路：修复“爬虫源/抓包源显示为空”的根因，确保开发态 Electron 能正确读取并展示 `state/profiles/default.json` 中的五个节点来源，然后产出并验证可打开的 macOS `.app` 包。

## Goals

- Electron 开发态启动后，抓包源卡片和抽屉中的五个来源都显示当前配置文件中的 `url` 与 `key`
- 如果 `state/profiles/default.json` 已存在，则它是桌面端读取配置的最高优先级来源
- 若状态文件缺失，回退生成默认 profile 时，字段结构与现有运行链路兼容，不把来源 URL / key 置空
- `npm run electron:dev` 可启动
- `npm run package:electron` 可产出 `.app`
- 打包产物能在当前机器上启动，并能读取同一份 profile

## Root Cause Hypothesis

当前问题更可能出在“项目根目录与配置来源解析”而不是配置文件本身：

- `state/profiles/default.json` 已包含 5 个非空来源
- 后端 CLI `profile` 命令在显式 `--project-root` 指向仓库目录时，返回的也是非空来源
- 因此“来源为空”不是配置内容丢失，而是某些启动路径下应用没有指向正确的 `projectRoot`，或者回退读取了另一条默认配置链路

## Architecture

### 1. 配置读取优先级

- 保持 `state/profiles/default.json` 为 Electron / backend 的主配置文件
- 在默认 profile 生成逻辑中保留从 `vpn-catch-nodes/config/vpn_api.json` 补默认值的能力，但只作为“首次生成或缺失时的回退”
- 对已存在的 state profile 不做覆盖式重建

### 2. 项目根目录解析

- 开发态：继续以仓库根目录作为 `projectRoot`
- 打包态：显式提供或推导出真实仓库根目录，避免 `process.execPath` 或 `app.asar` 目录把应用带到错误位置
- 如果需要，为 packaged app 增加更稳定的 root 解析与后端资源定位逻辑

### 3. 后端资源可用性

- 目前打包配置只包含 `electron/**/*`
- 若 packaged app 仍需调用 Python backend，则必须保证打包后能定位到：
  - Python entry module `vpn_automation.backend`
  - `src/` 目录
  - `pyproject.toml` 或其他用于锚定仓库根目录的证据
- 优先选择最小改动方案：让 `.app` 继续依赖旁边的源码仓库，而不是在本次任务里把 Python 解释器和依赖完全内嵌

## Components

### Config model / store

- 核实 `AppProfile.from_dict()` 与现有 `default.json` 结构一致
- 为默认 profile 生成与已有 state profile 加载补充回归测试

### Electron path resolution

- 核实 `resolveProjectRoot()` 在开发态和打包态的返回值
- 如现状不稳定，补一条优先级更高的解析路径，例如：
  - 显式环境变量
  - 基于 `.app` 相对位置推导源码仓库
  - 回退到现有查找逻辑

### Packaging

- 核实 `electron-builder` 产物是否包含运行时所需最小文件
- 如不包含，补 `extraResources` 或调整运行时路径解析，让 packaged app 能访问仓库中的 `src/` 和 `state/`

## Data Flow

1. Electron main 解析 `projectRoot`
2. IPC `profile:load` 调用 `python3 -m vpn_automation.backend profile --project-root <root>`
3. backend 使用 `ProfileStore.load_or_create(<root>/state/profiles/default.json)`
4. renderer 渲染 `state.profile.sources`
5. 用户保存后仍写回同一路径

## Error Handling

- 若 profile 文件不存在：生成默认 profile，并保证来源字段非空回退可用
- 若后端启动失败：Electron 日志中暴露真实 stderr，不静默吞错
- 若 packaged app 找不到仓库根目录：给出明确日志，并尽量回退到 sibling/source 仓库解析

## Verification

- Python / Node 测试覆盖：
  - 读取现有 state profile 时保留非空来源
  - `resolveProjectRoot()` 在模拟 packaged 路径下能回到真实项目根
- 手工验证：
  - `npm run electron:dev`
  - `npm run package:electron`
  - 启动 `dist-electron/mac-arm64/VPN Subscription Automation.app`
- UI 验证：
  - 抓包源摘要卡片显示非空 URL
  - 来源抽屉中的 5 个源都有 URL / key

## Out of Scope

- 不改动抓取、测速、部署流水线的业务规则
- 不在本次任务里做完整的 Python runtime 内嵌发行版
- 不重构 UI 信息架构，只修与本问题直接相关的配置展示与打包启动路径
