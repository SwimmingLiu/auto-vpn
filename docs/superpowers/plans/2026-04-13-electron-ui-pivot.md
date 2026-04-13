# Electron GUI Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python desktop GUI with an Electron application that keeps the existing Python automation pipeline as a backend.

**Architecture:** Electron provides the desktop shell and UI, Python provides the runtime pipeline, and the two communicate over JSONL stdout events from a spawned backend CLI.

**Tech Stack:** Electron, HTML, CSS, JavaScript, Python 3.12, pytest, node:test, Playwright, Xray-core, Wrangler

---

### Task 1: Add Python backend CLI

- [ ] Add backend module and tests
- [ ] Stream logs and stage events as JSON
- [ ] Expose profile bootstrap command

### Task 2: Build Electron shell

- [ ] Add `package.json`
- [ ] Add Electron main / preload / IPC files
- [ ] Add modern renderer HTML / CSS / JS

### Task 3: Validate UI behavior

- [ ] Add node tests for backend bridge and renderer state helpers
- [ ] Add Playwright renderer e2e test
- [ ] Add Playwright renderer visual hash test

### Task 4: Package Electron app

- [ ] Add packaging script
- [ ] Produce `.app` output
- [ ] Verify packaged app launches
