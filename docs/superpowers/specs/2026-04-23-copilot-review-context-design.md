# Copilot Review Context Design

**Goal:** 让 GitHub Copilot 在 PR review 时理解仓库目标、当前变更意图、重点风险区，并强制每个 PR 提供足够的审查上下文。

**Architecture:** 采用三层上下文注入。第一层是仓库级固定上下文，写入 `.github/copilot-instructions.md`。第二层是路径级审查规则，按 Python backend、Electron UI、GitHub Actions 三类文件分别设置 `.github/instructions/*.instructions.md`。第三层是 PR 级动态上下文，通过 `PULL_REQUEST_TEMPLATE.md` 和 PR body 校验工作流强制提交需求背景、安全影响、edge case 与验证证据。

**Tech Stack:** GitHub Copilot custom instructions, PR templates, GitHub Actions PR body validation.

---

## Scope

This phase covers:

- repository-wide Copilot review context
- path-specific review instructions
- PR template fields for feature intent and risk
- automation that rejects PRs with empty or placeholder review context

This phase does **not** replace human review. It makes Copilot review less blind and more project-aware.

## Recommended Approach

1. **Repository context**
   - Explain what the product does.
   - Explain what correctness means in this repo.
   - Tell Copilot to look for security, edge cases, state handling, deployment mistakes, and test coverage gaps.

2. **Path-specific review rules**
   - Python files: focus on pipeline correctness, secrets, subprocess, timeout, network failures.
   - Electron files: focus on IPC boundaries, preload exposure, renderer regressions, locale state, and visual consistency.
   - GitHub workflow files: focus on secret handling, permissions, cache poisoning, release integrity, and missing verification.

3. **PR context enforcement**
   - Every PR must state goal, feature mapping, risk, security review, edge cases, and verification evidence.
   - The PR body validator should fail if any required section is empty.

## Risk Notes

- Static repository instructions cannot carry per-PR feature intent by themselves.
- Dynamic context therefore has to come from the PR body and linked design / plan docs.
- Overly broad instructions reduce signal, so path-specific files should stay focused and concrete.

