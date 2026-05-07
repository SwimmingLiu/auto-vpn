# Pages 被封禁后的自动回退与分享项目 `SUB` 同步设计

## 摘要

本次改造的目标，是让现有 Cloudflare Pages 部署链路在项目被 Cloudflare 封禁时能够自动恢复，同时让下游分享项目始终指向最新可用的 Pages 项目地址。

当主 Pages 项目（例如 `sub-nodes`）在部署时被 Cloudflare 以错误码 `8000119` 拒绝时，系统应当：

1. 自动创建一个替代 Pages 项目，命名采用两位数字后缀，例如 `sub-nodes-01`；
2. 把原项目的部署配置复制到这个替代项目；
3. 使用同一份生成出来的 `pages_bundle` 重新部署到替代项目；
4. 把分享项目（例如 `sub-links-share-03`）中的环境变量 `SUB` 更新为新的 Pages 项目 URL，例如 `https://sub-nodes-01.pages.dev`；
5. 如果分享项目本身也被封禁，则继续创建新的分享项目，例如 `sub-links-share-04`；
6. 在主项目和分享项目都验证通过以后，再决定是否删除旧的被封禁项目。

这里的 `SUB` 值必须是**新的 Pages 项目根 URL**，不能写成 secret URL，也不能写成带额外 query 参数的订阅地址。

## 目标

- 在主 Pages 项目被 Cloudflare 封禁时自动恢复部署；
- 使用稳定的两位数字后缀命名规则：`-01`、`-02`、`-03`；
- 当编号超过两位数时，自动扩展到三位、四位甚至更多位，同时继续保证不重名；
- 自动把分享项目中的 `SUB` 环境变量更新到最终可用的 Pages 项目 URL；
- 如果分享项目本身被封禁，也使用同样的自动回退机制；
- 只有在替代项目部署和验证成功后，才删除旧的被封禁项目；
- 尽量复用 `pages-fallback-auto-create` worktree 中已经实现过的逻辑。

## 非目标

- 不替换现有基于 Wrangler 的 Pages 部署方式；
- 不修改 `_worker.js`、`pages_bundle` 或订阅内容本身的生成逻辑；
- 不额外引入与当前需求无关的自定义域名策略变化；
- 不做与本需求无关的 Electron UI 大改，只在确有必要时补最小配置项展示。

## 当前现状

当前主线分支的部署流程能够：

- 生成 Pages bundle；
- 执行 `wrangler pages deploy <bundle_dir> --project-name <project_name> --branch main`；
- 对部署完成后的 Pages URL 和订阅 URL 做基础校验。

但当 Cloudflare 返回封禁错误 `8000119` 时，当前运行会直接在 `deploy` 阶段失败。

与此同时，在如下 worktree 中已经存在一套更完整的 fallback 原型实现：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-fallback-auto-create/src/vpn_automation/integrations/cloudflare.py`

这套 worktree 里已经有：

- 对 blocked Pages 错误的识别；
- 基于两位数字后缀的 fallback 项目名生成；
- Pages 项目的创建、读取、更新、删除 API 封装；
- 部署配置复制；
- 主项目 blocked 后自动创建替代项目并重试部署；
- 验证通过后再删除旧 blocked 项目的清理机制。

但它还没有完整满足当前需求：

- 它虽然会复制 `deployment_configs`，
- 但没有把分享项目里的 `SUB` 明确重写为**新的 Pages 项目根 URL**；
- 也没有把“分享项目本身 blocked 时继续 fallback”这一整条链路完整接通。

## 需求说明

### 1. 主 Pages 项目自动回退

当主 Pages 项目的部署因为 blocked 错误失败时：

- 识别 blocked 条件；
- 在生成 fallback 项目名之前，先检查当前配置中的项目名本身；如果当前项目名已经带数字后缀，则必须从当前后缀之后继续递增，而不能回退到 `-01`；
- 列出现有的 Pages 项目名；
- 使用两位数字后缀生成新项目名；
  - `sub-nodes` -> `sub-nodes-01`
  - 如果 `sub-nodes-01` 已存在 -> `sub-nodes-02`
  - 如果当前项目名已经是 `sub-nodes-99`，则下一个候选名必须至少是 `sub-nodes-100`
  - 以此类推；
- 创建替代项目；
- 复制原项目部署配置；
- 使用同一个 `pages_bundle` 部署到新项目；
- 后续流程统一以这个新项目作为最终 Pages 项目。

### 2. 分享项目 `SUB` 重写

一旦最终主 Pages 项目确定，就必须更新分享项目中的 `SUB`。

更新规则：

- `deployment_configs.preview.env_vars.SUB.value == <最终 Pages 项目根 URL>`
- `deployment_configs.production.env_vars.SUB.value == <最终 Pages 项目根 URL>`

示例：

- 最终主项目：`sub-nodes-01`
- 最终主项目 URL：`https://sub-nodes-01.pages.dev`
- 则 `SUB` 必须写为：`https://sub-nodes-01.pages.dev`

明确禁止把 `SUB` 写成：

- `https://sub-nodes-01.pages.dev/?serect_key=...`
- `https://sub-nodes-01.pages.dev/sub?...`
- 任何 verify URL 或 secret URL

它只能是最终 Pages 项目的根 URL。

### 3. 分享项目 blocked 时自动回退

如果分享项目在更新配置或后续部署时也遇到 blocked：

- 使用同样的两位数字规则生成分享项目的新名字；
- 例如：`sub-links-share-03` -> `sub-links-share-04`；
- 创建替代分享项目；
- 复制原分享项目的部署配置；
- 把 preview 和 production 中的 `SUB` 都改成最终主 Pages 项目根 URL；
- 后续流程统一使用这个新的分享项目。

### 4. 安全清理

旧 blocked 项目必须满足以下条件后才能删除：

- 替代项目已经成功创建；
- 替代项目已经成功部署；
- 必要的 verify 已通过。

这个规则分别适用于：

- 主 Pages 项目；
- 分享项目。

如果 verify 失败，则必须跳过 cleanup，并把失败原因记录到部署元数据中。

## 推荐架构

建议分成两层。

### 第一层：主 Pages 项目 fallback

把低层的 blocked fallback 逻辑继续放在 Cloudflare integration 层。

职责：

- 检测 blocked 部署失败；
- 创建替代 Pages 项目；
- 复制部署配置；
- 重试 Wrangler 部署；
- 返回包含请求项目名、最终项目名、fallback 使用情况和待清理项目的信息。

这一层应尽量复用 `pages-fallback-auto-create` 里现有的实现。

### 第二层：分享项目同步

再单独增加一层“分享项目同步器”。

职责：

- 找到配置中的分享项目；
- 把它的 `SUB` 重写为最终主 Pages 项目根 URL；
- 如果这个分享项目也 blocked，则为它创建替代项目并在新项目上完成同样的重写；
- 返回最终分享项目的信息以及可能的 cleanup 信息。

这一层必须在主项目最终 Pages URL 已经确定之后再执行。

这样做的好处是主项目 deploy 和分享项目同步边界清晰，方便测试和维护。

## 数据模型变更

建议在 deploy 配置中增加明确的分享项目设置。

推荐新增字段：

- `auto_create_project_on_blocked: bool = True`
- `fallback_project_prefix: str = ""`
- `share_project_name: str = "sub-links-share-03"`
- `share_project_auto_fallback: bool = True`
- `share_project_fallback_prefix: str = "sub-links-share"`
- `share_project_sub_env_key: str = "SUB"`
- `fallback_last_used_suffix: int = 0`
- `share_project_fallback_last_used_suffix: int = 0`

规则：

- 如果 `fallback_project_prefix` 为空，则主项目 fallback 命名默认使用 `project_name`；
- 分享项目 fallback 命名使用 `share_project_fallback_prefix`；
- `share_project_sub_env_key` 默认是 `SUB`；
- 如果 `share_project_name` 为空，则跳过分享项目同步。
- `fallback_last_used_suffix` 与 `share_project_fallback_last_used_suffix` 用于避免旧项目已经被删除后，又重复复用相同名字。

这些字段都必须支持：

- `DeployConfig`
- TOML 持久化
- 默认 profile
- 如有必要，Electron deploy 设置 UI 也应可编辑或可见

## 部署元数据变更

建议扩展 deploy 结果元数据，明确记录主项目和分享项目两条链路的结果。

推荐新增字段：

- `requested_project_name`
- `project_name`
- `pages_project_url`
- `fallback_used`
- `cleanup_blocked_project`
- `share_project_requested_name`
- `share_project_name`
- `share_project_fallback_used`
- `share_project_cleanup_blocked_project`
- `share_project_sub_value`
- `share_project_sync_ok`
- `share_project_sync_error`

这些字段应写入 `pipeline_report.json`，保证 artifact 足以独立复盘问题。

## 详细流程

### 第一步：部署主 Pages 项目

调用现有 deploy helper。

如果请求的主项目部署成功：

- 保持 `project_name` 不变；
- 保持 `pages_project_url` 不变。

如果请求的主项目被 blocked：

- 按两位数字后缀生成 fallback 名；
- 创建 fallback 项目；
- 复制原部署配置；
- 重新部署到 fallback 项目；
- 更新最终部署元数据中的 `project_name` 和 `pages_project_url`。

### 第二步：验证主 Pages 项目

verify 只能使用最终部署元数据，而不能继续使用原始配置值。

应校验：

- Pages 根 URL；
- secret URL；
- verify subscription URL。

### 第三步：同步分享项目

把最终主 Pages 项目根 URL 作为新的 `SUB` 值。

目标：

- preview 环境变量
- production 环境变量

如果分享项目健康：

- 直接原地 patch 其 deployment configs。

如果分享项目 blocked：

- 创建 fallback 分享项目；
- 复制原分享项目配置；
- 把复制后的 preview/production 中 `SUB` 都改成最终主 Pages 项目根 URL；
- 后续流程使用这个新分享项目。

### 第四步：检查 cleanup 前提

只有在以下条件满足时才允许 cleanup：

- 主项目最终部署成功；
- 如果启用了分享项目同步，则分享项目同步成功；
- verify 通过。

### 第五步：执行 cleanup

只有在所有成功条件满足后，才删除旧 blocked 项目。

如果 cleanup 自身失败：

- 不应把一个已经成功部署并验证通过的 run 直接打成失败；
- 但必须把 cleanup 错误写进元数据。

## Cloudflare API 交互方式

主项目 fallback 和分享项目同步都依赖以下接口：

- `GET /accounts/{account_id}/pages/projects`
- `GET /accounts/{account_id}/pages/projects/{project_name}`
- `POST /accounts/{account_id}/pages/projects`
- `PATCH /accounts/{account_id}/pages/projects/{project_name}`
- 可选：`DELETE /accounts/{account_id}/pages/projects/{project_name}`

对于分享项目同步，`PATCH` payload 必须保留 deployment config 的其他内容，只改：

- `deployment_configs.preview.env_vars.SUB`
- `deployment_configs.production.env_vars.SUB`

secret 的处理要延续现有逻辑：

- 明文 env var 直接复制；
- `secret_text` 仍然走现有 secret 解析逻辑。

## 命名规则

fallback 项目名必须统一使用两位数字后缀。

示例：

- `sub-nodes` -> `sub-nodes-01`
- 如果 `sub-nodes-01`、`sub-nodes-02` 已存在 -> `sub-nodes-03`
- `sub-links-share-03` blocked -> `sub-links-share-04`
- `sub-nodes-99` -> `sub-nodes-100`
- `sub-nodes-999` -> `sub-nodes-1000`

严禁出现：

- `sub-nodes-1`
- `sub-links-share-4`

建议采用以下防重名规则：

1. 先解析当前项目名本身：
   - 如果当前项目名匹配 `<prefix>-<digits>`，则提取逻辑前缀和当前数字后缀；
   - 如果不匹配，则当前后缀视为 `0`。
2. 再扫描 Cloudflare 上当前仍存在的、同一逻辑前缀下的项目名。
3. 同时读取本地持久化的最后一次已使用后缀：
   - `fallback_last_used_suffix`
   - `share_project_fallback_last_used_suffix`
4. 取三者中的最大值：
   - 当前项目名中的后缀
   - Cloudflare 现存项目中的最大后缀
   - 本地已记录的最后使用后缀
5. 下一个 fallback 后缀必须是 `max + 1`。
6. 格式化规则：
   - 当编号小于 `100` 时，至少保留两位，例如 `01`
   - 当编号大于等于 `100` 时，自然扩展，例如 `100`、`1000`

推荐使用这种“当前项目名 + Cloudflare 现存项目 + 本地计数器”三重联合判断方式，而不是只扫描当前存在的项目名。这样即使旧 fallback 项目已经被删除，也不会再次复用同名项目。

## 错误处理

### 主项目 blocked 但 fallback 失败

如果主项目 blocked，而 fallback 项目创建或 fallback deploy 失败：

- 返回 deploy failed；
- 不删除旧 blocked 主项目；
- 明确暴露 fallback 的失败原因。

### 分享项目 blocked 但 fallback 失败

如果分享项目 blocked，而 fallback 或 `SUB` 同步失败：

- 整个 run 记为 failed；
- 保留主项目部署元数据；
- 明确记录分享项目失败原因。

### 分享项目不存在

如果配置了 `share_project_name`，但 Cloudflare 上根本找不到这个项目：

- 本轮设计建议视为同步失败；
- 不在这一版里把“项目不存在”自动等同于“blocked 后自动创建”。

这样可以避免把“配置错误”和“Cloudflare 风控封禁”混成一类问题。

### cleanup 失败

cleanup 失败不应把一个已经完整通过 verify 的成功 run 降级成 failed。

正确行为应为：

- 运行状态维持 success；
- cleanup 错误写入元数据。

### retry 时的行为

如果用户对一个旧 artifact 从 `deploy` 或 `verify` 阶段发起重试：

- 重试逻辑必须复用与正常运行一致的双重 fallback 规则；
- 不能假设旧 artifact 里记录的项目名仍然可用；
- 必须重新基于：
  - 当前配置中的项目名
  - Cloudflare 现存项目
  - 本地持久化的最后使用后缀
  来重新生成 fallback 候选名；
- 如果主项目在 retry 时 fallback 成功，后续分享项目同步必须继续执行；
- 如果分享项目在 retry 时也 blocked，仍然必须继续走分享项目 fallback。

换句话说，旧 artifact 的 retry 不应该只是“再发一次 deploy 命令”，而是要完整复用：

- 主项目 fallback
- 分享项目 `SUB` 同步
- 分享项目 fallback

## 日志与可观测性要求

本次改造必须增强日志和产物中的错误信息，确保后续排查时能够快速定位失败点。

至少要记录：

- 当前阶段：`deploy` / `verify` / `share_sync` / `cleanup`
- 主项目：
  - `requested_project_name`
  - `final_project_name`
  - `fallback_candidate_names`
- 分享项目：
  - `share_project_requested_name`
  - `share_project_final_name`
  - `share_project_fallback_candidate_names`
- `SUB` 最终被写成的值
- 是否命中 blocked 检测
- Cloudflare API 返回的：
  - 错误码
  - 关键错误文本
  - 失败接口
- cleanup 是否执行、删除了哪个旧项目、cleanup 是否报错

如果运行失败，`pipeline_report.json` 和运行日志中都应该能直接看出：

- 是主项目失败
- 还是分享项目失败
- 是 fallback 创建失败
- 还是 `SUB` patch 失败
- 还是 cleanup 失败

## 测试策略

### 配置测试

增加以下字段的 round-trip 测试：

- `share_project_name`
- `share_project_auto_fallback`
- `share_project_fallback_prefix`
- `share_project_sub_env_key`

### Cloudflare integration 测试

至少覆盖：

- 主项目 blocked 后创建 `sub-nodes-01`
- 分享项目 blocked 后创建 `sub-links-share-04`
- preview / production 的 `SUB` 都被改成最终 Pages 根 URL
- 两位数字后缀生成稳定
- 当前项目名已经是 `sub-nodes-99` 时，下一次 fallback 生成 `sub-nodes-100`
- 本地记录的最后使用后缀比 Cloudflare 现存后缀更大时，仍然从本地更大的编号继续递增
- cleanup 元数据记录正确

### Controller / backend_resume 测试

至少覆盖：

- fallback 主项目 deploy 结果能继续流入 verify
- 分享项目同步元数据会写进 `pipeline_report.json`
- blocked 源项目 cleanup 只有在 verify success 后才执行

### 端到端行为测试

至少覆盖：

- fake 主项目 blocked -> fallback success -> 分享项目同步 success
- fake 主项目 blocked -> fallback success -> 分享项目 blocked -> 分享项目 fallback success
- 旧 artifact 从 `deploy` retry -> 主项目 fallback success -> 分享项目同步 success
- 旧 artifact 从 `deploy` retry -> 主项目 fallback success -> 分享项目 blocked -> 分享项目 fallback success

## 迁移顺序

建议按以下顺序落地：

1. 把 `pages-fallback-auto-create` worktree 中的主项目 fallback 逻辑移回主线；
2. 先恢复主项目 blocked 自动 fallback；
3. 增加分享项目相关配置字段与 TOML 持久化；
4. 增加独立的分享项目同步 helper，把 `SUB` 改成最终 Pages 根 URL；
5. 在这个 helper 之上再补分享项目 blocked fallback；
6. 扩展 verify 与 cleanup 元数据；
7. 跑 focused tests，再跑全量回归。

## 推荐实现路线

推荐按下面的思路实现：

1. 先复用 `pages-fallback-auto-create` 中已有的主项目 fallback 代码；
2. 保持这部分逻辑低层、单一，只处理一个 Pages 项目；
3. 在其上增加独立的分享项目同步步骤；
4. 分享项目中只重写 `SUB`，并且只写最终 Pages 根 URL；
5. 所有 blocked 项目的 cleanup 都延后到 verify 成功之后。

这样能最大化复用已有工作，同时满足你要求的命名格式、`SUB` 语义和双重 fallback 行为。
