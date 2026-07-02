# `sub-nodes` Pages deploy 说明（2026-04-29）

本文记录当前 `vpn-subscription-automation` 项目的 Pages 部署模型、设置页 deploy 配置规则、旧配置迁移规则，以及 2026-04-29 的真实环境验证结果。

## 1. 当前生产部署模型

当前正式 Pages 项目是：

- `project_name = "sub-nodes"`
- `pages_project_url = "https://sub-nodes.pages.dev"`

后端部署链路固定是：

1. render 输出：
   - `artifact_dir/vmess_node.js`
2. transform 输出：
   - `artifact_dir/worker_transformed.js`
3. obfuscate 输出：
   - `artifact_dir/_worker.js`
4. package 输出：
   - `artifact_dir/pages_bundle/_worker.js`
   - `artifact_dir/pages_bundle/modules/runtime.js`
   - `artifact_dir/pages_bundle/modules/guard.js`
   - `artifact_dir/pages_bundle/modules/noise.js`
   - `artifact_dir/pages_bundle/modules/payload.js`
   - `artifact_dir/pages_bundle/manifest.json`
5. wrangler 目录部署：
   - `npx wrangler pages deploy <artifact_dir/pages_bundle> --project-name <project_name> --branch main`

这里必须显式带上 `--branch main`。

原因：

- 不带 `--branch` 时，Wrangler 会按当前本地 git 分支创建 Preview 部署
- `https://sub-nodes.pages.dev` 只跟随 Production / `main`
- 当前工作分支不是 `main` 时，不显式指定分支会出现“命令成功，但正式地址还是旧内容”的假阳性

## 2. 设置页 deploy 配置规则

设置页 deploy 抽屉当前允许编辑：

- `project_name`
- `pages_project_url`
- `subscription_url`
- `verify_subscription_url`

联动规则：

1. 初始打开时，抽屉显示当前 profile 里的实际值
2. 当 `pages_project_url` 仍等于 `https://<project_name>.pages.dev` 这条自动推导值时：
   - 修改 `project_name`
   - `pages_project_url` 会自动联动
3. 当用户手动改过 `pages_project_url` 后：
   - 后续再改 `project_name`
   - 不再覆盖手动值
4. 保存 deploy 抽屉时：
   - 变更会写回 profile
   - 修改 `subscription_url` 时会刷新二维码使用的订阅 URL 派生结果
   - 修改 `verify_subscription_url` 时只影响 verify 阶段，不影响二维码展示
   - 保存成功 toast 会显式显示当前 `project_name` 与 `pages_project_url`

默认 verify 地址：

- `https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc`

如果 `verify_subscription_url` 为空，运行时会退回使用 `subscription_url`。

## 2.1 Worker build 配置规则

运行时 profile 现在新增 `[worker_build]` 段，负责控制 Worker 构建行为。当前默认字段包括：

- `environment_name`
- `entry_filename`
- `bundle_subdir`
- `modules_subdir`
- `manifest_filename`
- `variable_prefix`
- `comment_template`
- `random_noise_min_length`
- `random_noise_max_length`
- `enable_keyword_fragmentation`
- `enable_identifier_randomization`
- `emit_sidecar_modules`

这组配置当前不在设置页暴露，默认通过 `$HOME/.auto-vpn/profile.toml` 手工维护。可用 `VPN_AUTOMATION_RUNTIME_ROOT` 改到其他用户数据目录。

## 3. 旧配置迁移规则

首次加载运行时 profile 时，会自动迁移以下旧默认值组合，并立即持久化回 TOML：

- `vmessnodes` + `https://vmess2clash.pages.dev`
- `vms-nodes` + `https://vms-nodes.pages.dev`

迁移目标统一为：

- `project_name = "sub-nodes"`
- `pages_project_url = "https://sub-nodes.pages.dev"`

只有在“项目名 + Pages 地址”同时命中历史默认对时才会自动迁移，不会误改用户自定义配置。

## 4. seed profile 与版本控制约定

相关文件分工：

- 受版本控制：
  - `electron/runtime/default-profile.toml`
  - 作用：打包时没有 live profile 时的空白回退 seed
- 不纳入版本控制：
  - `electron/runtime/bundled-profile.toml`
  - 作用：打包前由 `electron/build/package.mjs` 复制生成的实际 seed

生成顺序：

1. 如果项目内 `state/profile.toml` 存在，复制它到 `bundled-profile.toml`
2. 否则复制 `default-profile.toml` 到 `bundled-profile.toml`

因此 `bundled-profile.toml` 是派生产物，不应作为源码提交。

## 5. `edgetunnel` 正常对齐结论

对比目录：

- 当前项目：`/Users/swimmingliu/data/VPN/vpn-subscription-automation`
- 参考实现：`/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`

本次只保留“正常对齐”结论：

### 已对齐

- Pages 静态目录部署模型：
  - 上传目录里使用 `_worker.js`
- Worker bundle 结构：
  - 继续以 `_worker.js` 作为部署入口
  - 同时额外输出 `modules/*.js` 与 `manifest.json`
- Worker 模板注入形态：
  - 当前项目仍以 `templates/vmess_node.js` 的 `__MAIN_DATA__` 占位替换为准
  - 实际模板变量名已收敛为中性命名 `SUBSCRIPTION_PAYLOAD`
- obfuscate 构建入口：
  - 仍由 `src/vpn_automation/integrations/node_tools.py` 统一生成 Wrangler / obfuscator 命令

### 可以安全保留的差异

- 当前项目的 Worker 模板是最小订阅导出 Worker，不直接照搬 `edgetunnel/pages/_worker.js`
- 当前项目部署目标是 `sub-nodes.pages.dev`，不是参考仓库里的 Worker / Pages 路由集合
- 当前项目的运行入口是 Python pipeline + Electron，不是 `edgetunnel` 的单 Worker 仓库结构

### 不建议迁移

- 任何以规避识别、规避审查、反逆向为目的的构建技巧
- 与当前最小订阅导出 Worker 无关的上游复杂路由逻辑
- 会改变现有 profile / subscription / verify 语义的上游变量体系

## 5.1 postprocess 区域降级规则

postprocess 仍负责最终节点名上的国家码和国旗装饰。当前规则是：

- 有效国家码保持原样
- `ZZ`
- 非法国家码
- GeoIP 查询失败

以上情况统一降级到：

- `US`
- 最终显示为 `🇺🇸 US ...`

这样可以保证最终节点列表始终落到稳定分组，不会再出现“像是没有加国旗”的视觉误判。

## 6. 2026-04-29 真实环境验证

### 6.1 Cloudflare 项目存在性

使用真实 `.env` 中的 `CLOUDFLARE_API_TOKEN` 调用 Cloudflare API，确认：

- `project_name = "sub-nodes"`
- `subdomain = "sub-nodes.pages.dev"`
- `production_branch = "main"`

### 6.2 部署链路验证

先用真实环境跑了一次不带 `--branch main` 的目录部署，观察到：

- 命令返回成功
- 但生成的是 Preview 部署
- 分支落在当前本地 git 分支 `codex/logo-v2-brand`
- `https://sub-nodes.pages.dev` 仍指向旧的 Production 内容

随后切换为显式 Production 部署命令：

```bash
npx wrangler pages deploy <pages_bundle> --project-name sub-nodes --branch main
```

验证结果：

- render 成功
- obfuscate 成功
- `pages_bundle/_worker.js` 成功生成
- Pages deploy 成功
- `https://sub-nodes.pages.dev/` 返回 `200`
- `build_secret_url()` 返回的正式校验地址：
  - `https://sub-nodes.pages.dev/?serect_key=swimmingliu`
- 正式地址响应内容与本次部署的样例 payload 完全匹配

本次验证产物目录：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/artifacts/manual-runs/sub-nodes-verify-main-20260429-213525`

Deployment 列表中对应的新 Production 记录：

- `8c797fca-edd3-4e45-be55-028aee440b55`

### 6.3 旧 profile 自动迁移与持久化

使用临时目录模拟旧 profile：

- 初始值：`vms-nodes` + `https://vms-nodes.pages.dev`
- 调用 `ProfileStore.load_or_create()` 首次加载

结果：

- 运行时返回值被迁移到 `sub-nodes`
- TOML 文件内容也同步持久化为 `sub-nodes`

## 7. 验证命令摘要

### 生产项目存在性

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
rtk proxy ./.venv/bin/python - <<'PY'
# load_runtime_env + CloudflareClient.get_pages_project("sub-nodes")
PY
```

### Production 部署验证

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
rtk proxy ./.venv/bin/python - <<'PY'
# replace_main_data -> build_worker_artifacts -> obfuscate_javascript -> build_pages_bundle -> deploy_pages_bundle
# verify secret URL payload matches
PY
```

### 部署列表检查

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
rtk proxy npx wrangler pages deployment list --project-name sub-nodes
```

### 迁移持久化检查

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
rtk proxy ./.venv/bin/python - <<'PY'
# temporary legacy profile -> ProfileStore.load_or_create()
PY
```
