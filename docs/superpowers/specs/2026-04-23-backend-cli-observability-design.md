# Backend CLI Observability Design

## Goal

把真实后端链路先独立于 Electron 跑通，并补齐 CLI 级别的可观测性，让一次人工触发的运行能够稳定输出：

- 阶段状态（running / success / failed / skipped）
- 提取阶段每个来源的实时进度
- 请求成功/失败、解密成功/失败等关键细节
- 测速和可用性校验的逐节点进度摘要
- 完整的结构化事件落盘，供监控脚本和后续前端复用

本轮只覆盖 Python 后端与 shell 脚本，不改 Electron。

## Scope

### In scope

- `vpn_automation.backend` 增加真实 CLI 运行选项
- pipeline controller 支持跳过 `deploy` / `verify`
- extract / speedtest / availability 发出结构化运行事件
- 每次手动运行保存独立 session 目录
- 提供一个手动启动脚本和一个实时监控脚本
- 单元测试 / e2e / shell 脚本测试覆盖新增行为

### Out of scope

- Electron 页面接入
- Rich / Textual TUI
- Cloudflare deploy/verify 的生产流程增强

## Proposed runtime shape

一次手动运行分成两个目录：

1. `artifacts/<timestamp>/`
   - pipeline 产物目录
   - 继续由 `PipelineController` 负责
2. `artifacts/manual-runs/<session-id>/`
   - 手动运行 session 目录
   - 保存 `events.jsonl`、`human.log`、`session.json`

两者通过 `summary` / `run_started` 事件里的 `artifact_dir` 关联。

## Event model

stdout 仍然保留现有事件输出能力，但后端增加稳定的结构化事件流，并允许单独落盘到 `events.jsonl`。

### Core events

- `run_started`
- `stage`
- `log`
- `summary`
- `run_failed`

### Extract events

- `extract_source_started`
- `extract_request_result`
- `extract_decrypt_result`
- `extract_iteration`
- `extract_source_completed`

### Speedtest events

- `speedtest_probe_result`
- `speedtest_selected`
- `speedtest_result`

### Availability events

- `availability_link_result`

## Stage policy

默认真实运行到：

- `doctor`
- `extract`
- `dedupe`
- `speedtest`
- `availability`
- `postprocess`
- `render`
- `obfuscate`

`deploy` 和 `verify` 需要支持显式跳过。被跳过的阶段状态记为 `skipped`，而不是直接省略。

## CLI contract

后端 `run` 子命令增加：

- `--skip-deploy`
- `--skip-verify`
- `--output {jsonl,human}`
- `--event-log <path>`
- `--human-log <path>`

默认仍兼容现有 JSONL stdout 使用方式；手动脚本会调用 `--output human` 并同时写 `events.jsonl`。

## Manual scripts

### `scripts/run_backend_pipeline.sh`

职责：

- 自动解析 Python 可执行文件
- 创建 `artifacts/manual-runs/<session-id>/`
- 生成 `session.json`
- 以推荐参数启动后端真实链路
- 默认跳过 `deploy/verify`
- 在终端输出本次 session 路径、日志路径、监控命令

### `scripts/monitor_run.sh`

职责：

- 读取最近一次或指定 session 的 `events.jsonl`
- 展示阶段状态
- 展示每个 source 的提取进度和累计统计
- 展示请求/解密成功失败次数
- 展示测速和 availability 进度摘要
- 展示最近日志与错误

## Failure handling

controller 需要在阶段异常时：

- 将当前阶段记为 `failed`
- 写回 `pipeline_report.json`
- 发出 `run_failed`
- 保留已经完成阶段的统计数据，便于监控和复盘

## Verification plan

- Python 单元测试覆盖结构化事件、跳过阶段、失败落盘
- e2e 测试覆盖真实 controller 编排行为
- shell 脚本测试覆盖监控输出与启动脚本 dry-run 行为
- 本轮只改后端，因此不要求 Electron / Playwright 验证
