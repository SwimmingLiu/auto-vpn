# VPN Subscription Automation TODO（2026-04-29）

## 目标

围绕当前 `vpn-subscription-automation` 项目，整理一份完整的后续工作清单，覆盖：

- Cloudflare Pages 部署目标从 `vms-nodes` 切换到 `sub-nodes`
- 设置页支持自定义部署项目名称与 Pages 地址
- Worker 产物命名与当前 Pages 目录部署链路对齐
- 与 `edgetunnel` 参考实现的正常对齐项
- Worker 构建产物的混淆与反检测优化

---

## 当前已完成基线

- [x] 默认 Pages 项目从 `vms-nodes` 切换为 `sub-nodes`
- [x] 默认 Pages 地址从 `https://vms-nodes.pages.dev` 切换为 `https://sub-nodes.pages.dev`
- [x] 设置页新增"部署配置"卡片
- [x] 设置页部署弹窗支持编辑：
  - [x] `project_name`
  - [x] `pages_project_url`
- [x] 在部署弹窗中，修改 `project_name` 时默认自动联动 `pages_project_url`
- [x] 如果用户手动修改过 `pages_project_url`，后续再改 `project_name` 时不再覆盖手动值
- [x] 混淆后中间产物命名统一为 `_worker.js`
- [x] 继续沿用 Cloudflare Pages 静态资源目录部署，不生成 `_worker.zip`
- [x] retry / resume / deploy 相关链路已同步改为读取 `_worker.js`
- [x] 旧默认值迁移已覆盖：
  - [x] `vmessnodes` -> `sub-nodes`
  - [x] `vms-nodes` -> `sub-nodes`

---

## TODO

### P0：部署链路确认

- [x] 用真实运行环境验证 `sub-nodes` 项目是否已存在且可正常发布
- [x] 用真实 `.env` 配置验证以下链路：
  - [x] render
  - [x] obfuscate
  - [x] `pages_bundle/_worker.js` 生成
  - [x] `wrangler pages deploy <pages_bundle> --project-name sub-nodes --branch main`
  - [x] deploy 后 URL 可访问
- [x] 验证 `build_secret_url()` 在 `sub-nodes.pages.dev` 下返回值正确
- [x] 验证旧 profile 文件首次加载后会自动迁移并持久化

### P0：设置页行为确认

- [x] 手工验证设置页部署配置弹窗：
  - [x] 初始值显示正确
  - [x] 修改 `project_name` 后，`pages_project_url` 自动联动
  - [x] 手动覆盖 `pages_project_url` 后，联动停止
  - [x] 保存后重启应用，配置仍然保留
- [x] 验证 deploy 配置修改后不会影响二维码和订阅页已有逻辑

### P1：`edgetunnel` 正常对齐项

- [x] 逐项对比 `/Users/swimmingliu/data/VPN/cloudflarevpn/edgetunnel`
- [x] 确认当前项目仍需对齐的"正常"项目，仅限以下范围：
  - [x] Worker 模板结构
  - [x] 正常混淆参数
  - [x] 非规避性质的构建步骤
- [x] 如果后续要继续对齐，补一份明确的差异清单：
  - [x] 当前项目实现
  - [x] `edgetunnel` 参考实现
  - [x] 可以安全迁移的部分
  - [x] 不应迁移的部分

### P1：构建流程增强

- [x] 抽象构建脚本中的常量和字符串为外部配置，支持多环境部署
- [x] 增强构建工具的代码生成能力，支持自定义变量命名规则和注释模板
- [x] 改进 Worker 打包输出结构，按功能模块拆分输出文件
- [x] 引入代码转换器（Transformer），在构建时自动优化代码结构（如提取重复逻辑、简化条件判断）

### P1：文档补齐

- [x] 更新 README 或单独补一份 deploy 说明文档
- [x] 写清楚当前部署模型：
  - [x] 产物路径：`artifact_dir/_worker.js`
  - [x] 上传目录：`artifact_dir/pages_bundle/_worker.js`
  - [x] 部署命令：`wrangler pages deploy <目录> --project-name <project_name> --branch main`
- [x] 写清楚设置页 deploy 配置含义：
  - [x] `project_name`
  - [x] `pages_project_url`
  - [x] 自动联动规则
- [x] 写清楚旧配置迁移规则，避免后续误判为数据异常

### P1：发布前核对

- [x] 检查未跟踪文件是否应纳入版本控制：
  - [x] `electron/runtime/bundled-profile.toml`（结论：为打包派生产物，继续忽略）
- [x] 检查无关工作区变更是否需要单独处理：
  - [x] `capture_screenshots.mjs` 当前为删除状态（结论：不纳入本次改动）
- [x] 提交前重新运行完整验证：
  - [x] `rtk npm run test:all`

### P2：后续可选增强

- [x] 在设置页 deploy 卡片增加辅助说明文案，减少误操作
- [x] 在 deploy 配置保存后增加更明确的成功提示
- [x] 在运行结果页展示本次 deploy 所使用的 `project_name`
- [x] 在日志中增加 deploy 目标项目名的显式输出，便于排查问题
- [x] 考虑引入自动化测试覆盖部署配置联动逻辑

---

## 验收清单

- [x] 新用户首次打开应用时，默认 deploy 目标为 `sub-nodes`
- [x] 老用户已有 `vmessnodes` 或 `vms-nodes` 配置时，会自动迁移到 `sub-nodes`
- [x] 设置页能正常编辑并保存 deploy 配置
- [x] `project_name` 自动带出默认 `pages_project_url`
- [x] 手动改过的 `pages_project_url` 不会被再次自动覆盖
- [x] obfuscate 后产物文件名为 `_worker.js`
- [x] Pages 上传仍基于静态资源目录，而不是 zip
- [x] Worker 产物已做基础的关键词混淆与随机化处理
- [x] 全量测试通过

---

## 建议执行顺序

1. 先做真实环境 deploy 验证（P0）
2. 再做设置页手工回归（P0）
3. 然后补 deploy / migrate 文档（P1）
4. 接着实施 Worker 产物优化（P1）
5. 最后再决定是否继续做 `edgetunnel` 的正常对齐
