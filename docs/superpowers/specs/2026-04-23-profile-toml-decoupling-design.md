# VPN Profile TOML Decoupling Design

## Goal

在 `/Users/swimmingliu/data/VPN/vpn-subscription-automation` 内彻底移除对兄弟项目 `vpn-catch-nodes` 和 `cloudflarevpn/edgetunnel` 的配置与模板依赖，并把运行时主配置从 `state/profiles/default.json` 重置为更适合人工编辑的 `state/profile.toml`。

## User Requirements

- 直接重置为新格式，不保留旧 `default.json` 兼容迁移逻辑
- 配置文件应当方便人工修改
- 新项目不得再依赖旧项目代码或运行时资源
- 后续流程继续按仓库要求推进：测试、PR、评审、合并

## Current Problems

1. Python backend 在默认 profile 生成时会读取兄弟项目 `vpn-catch-nodes/config/vpn_api.json`
2. pipeline 渲染阶段会读取兄弟项目 `cloudflarevpn/edgetunnel/vmess_node.js`
3. Electron 与 backend 都把主配置文件路径写死为 `state/profiles/default.json`
4. 现有 profile 含有 `workspace` 路径字段，暴露了不应由用户维护的内部运行路径
5. JSON 不支持注释，不适合作为长期手工维护配置

## Recommended Approach

### Option A - Recommended: TOML runtime profile + internal resources + derived runtime paths

- 主配置改为 `state/profile.toml`
- 配置只保留用户需要编辑的业务字段：`sources`、`speed_test`、`deploy`、`filters`
- 所有运行路径与模板文件统一从当前项目根目录推导
- 新项目自带内部模板资源 `templates/vmess_node.js`
- Electron 通过 backend 读写配置，配置在磁盘上存储为 TOML，进程间仍传 JSON 对象

**Why this is recommended**

- 彻底切断兄弟项目依赖
- 配置文件可读性高，可加注释
- 用户不再需要维护内部路径
- Electron 与 Python 各自只负责自己擅长的事：Python 负责配置序列化，Electron 负责 UI

### Option B: Keep JSON but remove external dependencies

- 保持 `state/profile.json`
- 去掉旧项目路径与模板依赖

**Tradeoff**

- 改动面较小
- 但仍然不适合人工维护，也不满足“方便修改”的目标

### Option C: YAML runtime profile + internal resources

- 主配置改为 `state/profile.yaml`
- 其余与推荐方案类似

**Tradeoff**

- 可读性可以接受
- 但缩进脆弱，出错后对非程序员不友好，不如 TOML 稳定

## Approved Design

按 Option A 实现。

## Config Shape

主配置文件路径：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`

主配置文件只保留以下结构：

```toml
[sources.leiting]
url = ""
key = ""
enabled = true
max_iterations = 100000
min_iterations = 10000
plateau_limit = 8
use_random_area = true
failure_limit = 3
max_runtime_seconds = 0

[speed_test]
min_download_mb_s = 0.5
timeout_seconds = 20
concurrency = 3
urls = [
  "https://speed.cloudflare.com/__down?bytes=5000000",
  "https://proof.ovh.net/files/10Mb.dat",
  "https://cachefly.cachefly.net/10mb.test",
]
probe_url = "https://www.gstatic.com/generate_204"
max_download_bytes = 5000000
startup_wait_seconds = 1
max_download_candidates = 50

[deploy]
project_name = "vmessnodes"
subscription_url = "https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937"
pages_project_url = "https://vmess2clash.pages.dev"
secret_query = "serect_key=swimmingliu"
account_id = "e743286b4304e96ee8795d62917052aa"
use_wrangler = true

[filters]
excluded_country_codes = ["CN"]
```

说明：

- `workspace` 字段整体删除
- 不再允许外部项目路径进入用户配置
- TOML 文件由 backend 生成，带固定注释说明，保证人工可读

## Runtime Path Derivation

以下路径改为内部推导，不再来自配置文件：

- profile path: `<project_root>/state/profile.toml`
- env path: `<project_root>/.env`
- artifacts root: `<project_root>/artifacts`
- template path: `<project_root>/templates/vmess_node.js`
- build root: `<project_root>/build`

worktree 下仍保持锚定主仓库根目录：

- 从 `.worktrees/<branch>` 运行时，配置仍落在主仓库 `state/profile.toml`
- 这与现有 worktree 行为一致，只是文件名从 `state/profiles/default.json` 改为 `state/profile.toml`

## Backend / Electron Responsibilities

### Python backend

- 负责默认配置生成
- 负责 TOML 读写
- 负责把 TOML 配置转成 JSON 发给 Electron
- 负责把 Electron 回传的 JSON 校验并写回 TOML
- 负责推导运行时路径并驱动 pipeline

### Electron

- 不再直接写磁盘配置文件
- `profile:load` 继续通过 backend 读取
- `profile:save` 改为通过 backend 保存
- 如需本地辅助路径解析，仅用于测试与路径显示，不承担序列化职责

## Internal Template Resource

新增受控模板文件：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js`

pipeline 在渲染阶段只读取该文件，不再访问：

- `vpn-catch-nodes`
- `cloudflarevpn/edgetunnel`

## Non-Goals

- 不迁移旧 `state/profiles/default.json`
- 不尝试自动读取兄弟项目历史配置
- 不修改历史设计文档作为运行真相来源
- 不把 Python runtime 完整打包进 Electron `.app`

## Test Strategy

### Python

- config store round-trip: TOML 读写一致
- default profile bootstrap: 缺少 `state/profile.toml` 时自动创建
- repo anchor / worktree path: 仍锚定主仓库 `state/profile.toml`
- backend CLI: `profile` 返回 JSON；`profile-save` 能把 JSON 写回 TOML
- e2e controller: 使用项目内模板目录执行完整 fake pipeline

### Electron

- backend invocation: 支持 `profile` / `profile-save`
- path helper: worktree 下解析到 `state/profile.toml`
- IPC save/load: 改为通过 backend round-trip，而非直接 JSON 文件写入

### Manual / UI Verification

- Electron 开发态加载新 `state/profile.toml`
- 在界面修改抓包源 URL / key 并保存
- 关闭再打开应用后配置仍存在
- 运行一次 pipeline，确认能从项目内模板完成 render / obfuscate / deploy bundle 产物生成

## Files Expected To Change

### Python

- `pyproject.toml`
- `src/vpn_automation/config/models.py`
- `src/vpn_automation/config/store.py`
- `src/vpn_automation/config/runtime.py`
- `src/vpn_automation/backend.py`
- `src/vpn_automation/pipeline/controller.py`

### Electron

- `electron/ipc.js`
- `electron/paths.js`
- `electron/tests/backend.test.mjs`

### Tests

- `tests/config/test_store.py`
- `tests/config/test_runtime_paths.py`
- `tests/backend/test_backend_cli.py`
- `tests/e2e/test_controller_e2e.py`

### New resources / docs

- `templates/vmess_node.js`
- `docs/superpowers/plans/2026-04-23-profile-toml-decoupling.md`
- `README.md`

## Spec Self-Review

- 无迁移占位描述，已明确“直接重置”
- 运行时唯一配置路径已固定，不存在双写入口
- 路径派生与模板归属已与用户需求一致
- 范围聚焦于配置与运行资源解耦，未扩展到独立打包 Python runtime
