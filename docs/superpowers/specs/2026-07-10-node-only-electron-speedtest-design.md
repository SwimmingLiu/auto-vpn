# Node-only Electron 与测速可靠性设计

## 目标

AutoVPN 仓库只保留 NodeJS 业务内核。Electron、Web 与 npm CLI 使用同一套 NodeJS 流水线、事件协议、配置和运行记录格式；删除 Python 内核、兼容适配器、测试、打包与发布路径。同时修复 Electron 实时全局去重计数，并降低测速对瞬时网络错误的误判率，不放宽既有速度和可用性门槛。

## 当前问题与证据

Electron 当前由 `electron/lib/backend.js` 启动 `python -m vpn_automation.backend`，打包仍携带 `src/**/*`、`pyproject.toml` 和 Python vendor。Python `extract_iteration` 事件没有 Node 事件中经过规范化、哈希后的 `new_item_fingerprints`，导致 Electron 在运行中只能累加各源节点数，结束时才由 summary 校正全局去重数。stdout 又按任意 chunk 直接拆行，跨 chunk 的 JSON 事件可能丢失。

运行记录 `20260710-151700` 含 222 个全局唯一节点。109 个首次 HTTP 探针返回 502，19 个在唯一下载端点失败，94 个完成下载，其中 88 个低于 1 MB/s，只有 6 个达到速度阈值，最终 1 个通过全部可用性检查。节点质量确实偏低，但单次 HTTP 探针、单下载端点、20 并发且无重试也扩大了误判不确定性。该次运行最后还因 Python managed-tool 安装路径错误失败，与节点质量无关。

## 架构

Electron 继续使用独立子进程以保留崩溃隔离和进程组停止能力，但子进程改为仓库/安装包内的 `@swimmingliu/autovpn` Node CLI。开发态通过当前 Node 可执行文件启动 CLI；打包态通过 Electron 可执行文件配合 `ELECTRON_RUN_AS_NODE=1` 启动。Electron 命令适配器只负责把 UI 操作映射为公开 CLI 命令，不复制业务逻辑。

Electron 后端输出通过有状态 NDJSON 解码器处理。解码器跨 chunk 保留半行，只将完整行交给事件解析；进程关闭时冲刷剩余内容。Node extract 已生成与全局 VMess canonical key 一致的不可逆哈希指纹，renderer 使用这些指纹实时计算全局去重数量。

Node 流水线测速统一为两阶段：先对所有全局去重节点执行轻量探针，瞬时状态/网络错误进行有限重试；再按延迟排序并应用 `max_download_candidates`，只对候选节点下载测速。下载使用配置端点，至少提供两个默认端点并只聚合成功样本；所有端点均失败仍判失败。速度阈值与 availability 全通过规则保持不变。

## Python 清理边界

删除 `src/vpn_automation`、Python `tests`、`pyproject.toml`、Python 专用 shell 脚本、Electron Python vendor 构建、PyPI 发布任务。删除 npm CLI 中 `python-backend.ts`、Python installer/cache、各 stage 的嵌入式 Python helper、Python backend 类型和回退注入点。环境变量选择 Python 时不再保留兼容执行路径；文档明确 Node-only。

历史设计文档作为项目记录可以提及过去的 Python 实现，但活动代码、构建、测试、运行说明和发布流程不能依赖 Python。CI 中仅用于无关通用文本处理的 Python 命令也改为 Node 或 shell，确保项目构建和测试不要求安装 Python。

## 兼容性与安全

公开 CLI 命令、profile TOML、artifact 目录、SQLite schema、事件字段和 Electron UI 操作保持兼容。删除回退代码前以 Node 测试覆盖现有命令与流水线行为。Electron 不读取或输出原始节点指纹、source key、token 或完整订阅地址；事件只包含哈希指纹。旧 artifact 仍可预览、重试支持范围由 Node artifact reader 决定。

## 验证

TDD 覆盖 Node 命令映射、分片 NDJSON、跨源 canonical 去重、探针重试、候选上限、备用下载端点和失败分类。完成后依次执行 npm CLI 全量测试、H5 Playwright 自动化与人工浏览、Electron 原生启动、Electron e2e、视觉哈希、打包测试和实际安装包冒烟。最后扫描活动代码与 CI，证明不存在 Python 内核运行、打包或发布路径；创建 PR，进行独立代码审查并处理全部 Critical/Important 反馈后合并和打包。
