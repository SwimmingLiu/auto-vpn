# `sub-nodes` Worker Build Alignment Design

## 背景

`/Users/swimmingliu/data/VPN/vpn-subscription-automation` 已完成 `sub-nodes` Pages 默认部署目标切换、设置页 deploy 配置编辑、旧配置迁移、`_worker.js` 产物命名统一，以及真实环境 deploy 验证。当前 TODO 剩余项集中在 Worker 构建流程增强与少量 UI/可观测性补齐。

本设计覆盖 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/docs/TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md` 中全部未完成任务，包括：

- P1 构建流程增强
- P2 可选增强
- 验收清单中“Worker 产物已做基础的关键词混淆与随机化处理”

## 目标

在不破坏现有 `sub-nodes` Pages 部署链路的前提下，引入结构化的 Worker 构建配置、代码生成、Transformer 与模块化 bundle 输出，同时补齐设置页说明、保存反馈、结果页 deploy 展示、日志可观测性和自动化测试覆盖。

## 非目标

本次不做以下事项：

- 不引入全新的 JS bundler 体系（例如 esbuild、rollup）
- 不重构为独立的 Worker 仓库结构
- 不扩展设置页为完整的高级构建配置面板
- 不迁移 `edgetunnel` 中与当前最小订阅导出 Worker 无关的复杂路由
- 不实现规避性质、反逆向性质的构建技巧

## 现状约束

当前主链路已经稳定依赖以下产物与行为：

1. render 输出 `artifact_dir/vmess_node.js`
2. obfuscate 输出 `artifact_dir/_worker.js`
3. package 输出 `artifact_dir/pages_bundle/_worker.js`
4. deploy 执行 `wrangler pages deploy <pages_bundle> --project-name <project_name> --branch main`
5. retry / resume / verify 相关链路都假定 `_worker.js` 仍然存在

因此任何构建增强都必须保持以上语义不变。

## 总体方案

采用“保留现有单文件兼容主线 + 增加结构化构建层”的方案：

- 保留 `artifact_dir/_worker.js` 作为 pipeline 主产物
- 保留 `artifact_dir/pages_bundle/_worker.js` 作为 Pages 部署入口
- 在 `pages_bundle` 下增加模块化 sidecar 输出，供调试、审查和后续扩展使用
- 把当前散落在模板、obfuscate、package 阶段中的常量与字符串抽成显式构建配置
- 在 obfuscate 前增加一个安全范围内的 Transformer 阶段，负责结构优化与基础随机化
- 在 UI 与日志中补足 deploy 目标信息，降低误操作与排障成本

## 架构设计

### 1. Worker 构建配置层

新增一个独立的构建配置模型，负责描述 Worker 生成与打包行为。该配置不替代 `DeployConfig`，而是与 deploy 配置并列存在。

配置需要覆盖：

- 构建环境名，例如 `default`、`production`、`staging`
- Worker 文件名与模块目录名
- secret query 键名与允许的响应模式
- 变量命名策略
- 注释模板
- 基础噪声长度范围
- 是否启用关键词拆分与随机化
- 是否输出模块化 sidecar 文件

配置优先级采用：

1. 代码内默认值
2. 外部构建配置文件
3. 运行时环境变量覆盖

本次不把这些高级构建项暴露到设置页，避免扩大 UI 配置面。

### 2. Worker 生成器

把当前基于 `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js` 的直接文本替换，升级为“模板 + 生成器”的组合：

- 模板继续作为逻辑骨架
- 生成器负责填充常量、变量名、注释、噪声逻辑与 payload 包装
- 生成器输出一份结构化的中间表示，供后续 Transformer 和 bundle 输出复用

生成器需要保证：

- 默认输出行为与当前 Worker 功能一致
- 生成结果仍能直接落为单文件 `_worker.js`
- 中间表示可以拆分成多个逻辑模块

### 3. Transformer

在 obfuscate 之前增加一个“可解释、非规避性质”的代码转换阶段。这个阶段只做正常工程优化，不做任何以绕过识别为目的的技巧。

Transformer 负责：

- 提取重复逻辑到小函数
- 简化明显重复或冗余的条件判断
- 把固定字符串整理为常量片段
- 按命名规则生成关键内部变量名
- 根据配置附加统一注释头
- 对基础噪声、片段顺序和部分非语义标识符做受控随机化

随机化必须满足两个约束：

- 默认逻辑输出保持稳定可验证
- 同一轮构建的所有输出文件使用同一份构建上下文，避免模块之间命名不一致

### 4. Pages bundle 输出

`pages_bundle` 继续保留 `_worker.js` 入口文件，但同时输出模块化 sidecar 文件，例如：

- `pages_bundle/_worker.js`
- `pages_bundle/modules/runtime.js`
- `pages_bundle/modules/payload.js`
- `pages_bundle/modules/noise.js`
- `pages_bundle/modules/guard.js`
- `pages_bundle/manifest.json`

这些 sidecar 文件本次主要承担三类职责：

- 让构建结果更可读、可审查
- 记录本次构建使用的配置与模块映射
- 为后续扩大 Worker 能力预留清晰边界

部署仍然只依赖 `_worker.js`，因此不会改变 Cloudflare Pages 当前的入口行为。

## 运行时与数据流

新链路保持以下顺序：

1. render 生成 `vmess_node.js`
2. Worker 生成器读取 render 产物和构建配置，生成结构化 Worker 中间表示
3. Transformer 对中间表示做结构化优化与基础随机化
4. 单文件写出为 `artifact_dir/_worker.js`
5. package 阶段把主入口复制到 `artifact_dir/pages_bundle/_worker.js`
6. package 阶段按模块写出 `pages_bundle/modules/*`
7. package 阶段写出 `pages_bundle/manifest.json`
8. deploy 仍对 `pages_bundle` 目录执行 `wrangler pages deploy`

retry / resume 行为保持不变：

- retry from `obfuscate` 仍只要求 `_worker.js` 可重建或可继续
- retry from `deploy` 仍从 `pages_bundle/_worker.js` 继续
- sidecar 文件缺失不应导致老的 retry 入口失效；必要时可在 deploy 前重新构建 bundle

## UI 与交互设计

### 设置页

在 deploy 卡片与 deploy 抽屉中补充辅助说明文案，明确：

- `project_name` 是 Cloudflare Pages 项目名
- `pages_project_url` 是正式访问地址
- 当 URL 仍为自动推导值时，项目名变化会联动 URL
- 手动修改 URL 后，后续不再自动覆盖

保存 deploy 配置后，toast 文案升级为显式反馈，例如包含：

- 保存成功
- 当前 `project_name`
- 当前 `pages_project_url`

### 结果页

结果页新增“本次 deploy 目标”信息块，展示：

- `project_name`
- `pages_project_url`
- deploy 阶段状态
- verify 阶段状态

该信息优先读取当前 run 的 `deployment` 摘要；如果当前 run 没有 deploy 结果，则回退显示当前 profile 的 deploy 配置。

### 日志中心

deploy 阶段增加显式日志：

- 开始部署到哪个 Pages 项目
- 使用哪个 bundle 目录
- 正式 URL 是什么
- deploy 成功后返回码与尝试模式摘要

这样“按阶段”查看日志时，可以直接确认 deploy 目标，而不必去翻 profile 或命令输出。

## 数据模型与持久化设计

### PipelineSummary / report

扩展现有 `summary.deployment` 结构，使其除已有 `command`、`returncode`、`attempts` 之外，还稳定包含：

- `project_name`
- `pages_project_url`
- `bundle_dir`
- `worker_entry`
- `module_manifest_path`

这样前端结果页无需再猜测部署目标。

### 构建 manifest

在 `pages_bundle/manifest.json` 中记录：

- 环境名
- 主入口文件名
- 模块文件清单
- 变量命名策略
- 是否启用随机化

manifest 仅用于可观测性与调试，不作为运行时必需输入。

## 与 `edgetunnel` 的对齐边界

本次只做“正常对齐”，即：

- 学习其 Worker 文件组织方式
- 学习其合理的构建拆分边界
- 学习其普通工程化结构

不会迁移：

- 与当前订阅输出 Worker 无关的路由逻辑
- 会改变 `subscription_url` / verify 语义的变量体系
- 任何规避性质的技巧

## 错误处理

构建增强后需要新增以下保护：

- 构建配置非法时，尽早在 package / transform 前失败，并给出明确错误
- Transformer 输出为空或缺少主入口时，直接中止并标记 `obfuscate` 失败
- sidecar 模块写出失败时，整体 package 失败，不允许产生部分可部署状态
- 若 `manifest.json` 缺失但 `_worker.js` 存在，deploy 前重新生成 bundle，而不是继续使用不完整目录

## 测试策略

### Python 单元测试

新增或扩展测试覆盖：

- 构建配置默认值与覆盖优先级
- 变量命名规则生成
- 注释模板生成
- Transformer 的重复逻辑提取与条件简化输出
- 基础关键词拆分与随机化输出
- `pages_bundle` 模块化目录结构与 manifest 生成
- deploy 返回摘要中包含 deploy 目标字段

### Python e2e / pipeline 测试

确保现有 controller / resume / retry 流程继续通过，并额外验证：

- `artifact_dir/_worker.js` 仍存在
- `artifact_dir/pages_bundle/_worker.js` 仍存在
- `pages_bundle/modules/*` 已生成
- 结果摘要中可读取 deploy 目标元数据

### Electron 测试

补充或更新：

- deploy 卡片辅助说明
- deploy 保存成功 toast
- 结果页 deploy 目标展示
- 日志中心 deploy 目标日志
- deploy 配置联动逻辑自动化测试

### Visual regression

由于设置页、结果页和日志页文案会变化，需要更新对应页面视觉快照 hash。

### 手工验证

完成后用 Playwright 或 Computer Use 手工验证：

- 设置页 deploy 抽屉说明与保存反馈
- 结果页 deploy 目标显示
- 日志页 deploy 目标日志
- 不影响二维码与订阅页现有逻辑

## 受影响文件范围

预计主要涉及：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/integrations/node_tools.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/integrations/cloudflare.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/package.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend_resume.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/integrations/test_cloudflare.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_controller.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/README.md`
- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/docs/deploy-pages-sub-nodes.md`

另外会新增若干聚焦职责的小文件，用于承载构建配置、生成器与 Transformer。

## 风险与取舍

### 风险

- 新增构建抽象后，`controller` 和 `backend_resume` 的路径依赖更复杂
- 模块化输出会扩大测试面
- 视觉回归 hash 必然变化

### 取舍

- 不引入 bundler，避免把本次任务升级成构建系统迁移
- 不把高级构建配置暴露到设置页，避免 UI 复杂度失控
- 仍以 `_worker.js` 为唯一部署真相，sidecar 模块以可观测性和后续演进为主

## 验收标准

完成后应满足：

- 现有 `sub-nodes` deploy 主链路不变且可继续通过
- `artifact_dir/_worker.js` 与 `artifact_dir/pages_bundle/_worker.js` 继续稳定生成
- `pages_bundle` 额外生成模块化 sidecar 文件与 manifest
- Worker 产物具备基础关键词拆分与受控随机化
- 设置页 deploy 卡片有更清晰说明
- deploy 配置保存后有更明确成功提示
- 结果页能展示本次 deploy 所使用的 `project_name`
- 日志中显式输出 deploy 目标项目名
- 部署配置联动逻辑具备自动化测试覆盖
- `rtk npm run test:all` 通过
- Playwright / visual / 手工 UI 验证通过
