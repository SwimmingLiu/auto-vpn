# Pages Blocked Fallback and Share SUB Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Cloudflare Pages `deploy` 和旧 artifact `retry` 在主项目或分享项目被 `8000119` 封禁时，自动创建不重名的替代项目，并把分享项目 `SUB` 改成新的 Pages 根 URL。

**Architecture:** 先在 `src/vpn_automation/integrations/cloudflare.py` 集中实现 blocked 检测、项目命名、项目复制、分享项目 `SUB` patch 和双重 fallback；再让 `src/vpn_automation/pipeline/controller.py` 与 `src/vpn_automation/backend_resume.py` 用 deployment 元数据驱动 verify / cleanup / retry，避免继续依赖旧的 `profile.deploy` 值。配置新增字段只放进 `DeployConfig` 与 TOML store，Electron UI 本轮不新增可视编辑入口，继续依赖默认值和手工 profile 编辑。

**Tech Stack:** Python dataclasses, requests, Cloudflare Pages API, pytest, Node test runner

---

### Task 1: 扩展 deploy 配置模型与持久化

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/src/vpn_automation/config/models.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/src/vpn_automation/config/store.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/config/test_store.py`

- [ ] **Step 1: 先写失败测试，覆盖默认值和 round-trip**

```python
def test_create_default_profile_includes_pages_fallback_settings(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    assert profile.deploy.auto_create_project_on_blocked is True
    assert profile.deploy.fallback_project_prefix == ""
    assert profile.deploy.share_project_name == "sub-links-share-03"
    assert profile.deploy.share_project_auto_fallback is True
    assert profile.deploy.share_project_fallback_prefix == "sub-links-share"
    assert profile.deploy.share_project_sub_env_key == "SUB"
    assert profile.deploy.fallback_last_used_suffix == 0
    assert profile.deploy.share_project_fallback_last_used_suffix == 0


def test_profile_store_round_trip_pages_fallback_settings(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "profile.toml")
    profile = make_profile()
    profile.deploy.share_project_name = "sub-links-share-07"
    profile.deploy.fallback_last_used_suffix = 99
    profile.deploy.share_project_fallback_last_used_suffix = 12
    store.save(profile)

    loaded = store.load()

    assert loaded.deploy.share_project_name == "sub-links-share-07"
    assert loaded.deploy.fallback_last_used_suffix == 99
    assert loaded.deploy.share_project_fallback_last_used_suffix == 12
```

- [ ] **Step 2: 运行失败测试，确认现状未支持**

Run: `./.venv/bin/python -m pytest tests/config/test_store.py -k "fallback_settings" -v`

Expected: `DeployConfig` 缺少字段或 store 未落盘，测试失败。

- [ ] **Step 3: 在 DeployConfig、default profile、store 渲染中加字段**

```python
@dataclass
class DeployConfig:
    project_name: str
    subscription_url: str
    verify_subscription_url: str = "https://www.swimmingliu.xyz/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
    pages_project_url: str = "https://sub-nodes.pages.dev"
    secret_query: str = "serect_key=swimmingliu"
    account_id: str = "e743286b4304e96ee8795d62917052aa"
    use_wrangler: bool = True
    auto_create_project_on_blocked: bool = True
    fallback_project_prefix: str = ""
    share_project_name: str = "sub-links-share-03"
    share_project_auto_fallback: bool = True
    share_project_fallback_prefix: str = "sub-links-share"
    share_project_sub_env_key: str = "SUB"
    fallback_last_used_suffix: int = 0
    share_project_fallback_last_used_suffix: int = 0
```

- [ ] **Step 4: 重跑 store 测试，确认通过**

Run: `./.venv/bin/python -m pytest tests/config/test_store.py -k "fallback_settings or editable_defaults" -v`

Expected: PASS

### Task 2: 先用测试锁定命名、防重名与双重 fallback 行为

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/integrations/test_cloudflare.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/integrations/test_cloudflare.py`

- [ ] **Step 1: 追加失败测试，覆盖命名递增与 share fallback**

```python
def test_generate_fallback_project_name_respects_current_suffix_and_grows_width() -> None:
    name, suffix = generate_fallback_project_name(
        "sub-nodes",
        {"sub-nodes", "sub-nodes-99"},
        current_project_name="sub-nodes-99",
        last_used_suffix=99,
    )

    assert name == "sub-nodes-100"
    assert suffix == 100


def test_deploy_pages_bundle_syncs_share_project_sub_to_final_pages_url(monkeypatch, tmp_path) -> None:
    ...
    assert result["share_project_sync_ok"] is True
    assert result["share_project_sub_value"] == "https://sub-nodes-01.pages.dev"
    assert payload["deployment_configs"]["preview"]["env_vars"]["SUB"]["value"] == "https://sub-nodes-01.pages.dev"
    assert payload["deployment_configs"]["production"]["env_vars"]["SUB"]["value"] == "https://sub-nodes-01.pages.dev"


def test_deploy_pages_bundle_falls_back_share_project_when_share_project_is_blocked(monkeypatch, tmp_path) -> None:
    ...
    assert result["share_project_name"] == "sub-links-share-04"
    assert result["share_project_fallback_used"] is True
    assert result["share_project_cleanup_blocked_project"] == "sub-links-share-03"
```

- [ ] **Step 2: 跑定向红测**

Run: `./.venv/bin/python -m pytest tests/integrations/test_cloudflare.py -k "fallback_project_name or share_project" -v`

Expected: 失败，提示函数/返回字段/行为缺失。

- [ ] **Step 3: 记录期望 deployment 元数据字段**

```python
expected_keys = {
    "requested_project_name",
    "project_name",
    "pages_project_url",
    "fallback_used",
    "cleanup_blocked_project",
    "share_project_requested_name",
    "share_project_name",
    "share_project_fallback_used",
    "share_project_cleanup_blocked_project",
    "share_project_sub_value",
    "share_project_sync_ok",
    "share_project_sync_error",
}
```

- [ ] **Step 4: 暂不改实现，保持红测**

No command. 进入下一任务实现。

### Task 3: 在 cloudflare integration 层实现 blocked fallback、share SUB sync 和可观测性

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/src/vpn_automation/integrations/cloudflare.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/integrations/test_cloudflare.py`

- [ ] **Step 1: 实现 blocked 标记、项目 API、命名辅助与 share patch helper**

```python
BLOCKED_PAGES_MARKERS = (
    "8000119",
    "your pages project has been blocked",
    "pages project has been blocked",
)


def generate_fallback_project_name(
    base_name: str,
    existing_names: set[str],
    *,
    current_project_name: str = "",
    last_used_suffix: int = 0,
) -> tuple[str, int]:
    ...


def rewrite_share_project_sub_value(
    deployment_configs: dict[str, Any],
    *,
    env_key: str,
    sub_value: str,
    runtime_env: dict[str, str],
) -> dict[str, Any]:
    ...
```

- [ ] **Step 2: 实现 `deploy_pages_bundle()` 的双层 fallback**

```python
if blocked_on_primary:
    final_project_name, used_suffix = generate_fallback_project_name(...)
    client.create_pages_project(final_project_name)
    client.copy_pages_project_config(requested_project_name, final_project_name, runtime_env)
    result = rerun_deploy(...)

share_sync = sync_share_project_sub(
    client,
    deploy,
    runtime_env,
    final_pages_project_url,
)
```

- [ ] **Step 3: 统一把异常、候选名、share sync 状态写进 deployment dict**

```python
return {
    "returncode": final_returncode,
    "stderr": stderr,
    "fallback_candidate_names": fallback_candidate_names,
    "share_project_requested_name": share_requested_name,
    "share_project_name": share_final_name,
    "share_project_fallback_used": share_fallback_used,
    "share_project_cleanup_blocked_project": share_cleanup_name,
    "share_project_sub_value": final_pages_project_url,
    "share_project_sync_ok": share_sync_ok,
    "share_project_sync_error": share_sync_error,
    ...
}
```

- [ ] **Step 4: 重跑 integration tests，直到 green**

Run: `./.venv/bin/python -m pytest tests/integrations/test_cloudflare.py -v`

Expected: PASS

### Task 4: 让 controller / backend_resume 使用 deployment 元数据做 verify、cleanup 和 retry

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/src/vpn_automation/pipeline/controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/src/vpn_automation/backend_resume.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/pipeline/test_controller.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/backend/test_backend_resume.py`

- [ ] **Step 1: 先写红测，锁定 verify 使用最终 deployment 而不是旧 profile**

```python
def test_pipeline_controller_verify_uses_final_deployment_pages_project_url(monkeypatch, tmp_path: Path) -> None:
    ...
    assert seen_secret_urls == ["https://sub-nodes-01.pages.dev/?serect_key=swimmingliu"]


def test_retry_verify_deletes_blocked_projects_after_success(monkeypatch, tmp_path: Path) -> None:
    ...
    assert deleted == ["sub-nodes", "sub-links-share-03"]
```

- [ ] **Step 2: 运行红测**

Run: `./.venv/bin/python -m pytest tests/pipeline/test_controller.py tests/backend/test_backend_resume.py -k "deployment_pages_project_url or blocked_projects" -v`

Expected: 失败，说明 verify / cleanup 仍依赖旧配置。

- [ ] **Step 3: 增加合并 deployment 目标、cleanup helper，并在 retry 链路复用**

```python
def _merge_deploy_verification_target(deploy: Any, deployment: dict[str, Any]) -> Any:
    merged = dict(vars(deploy))
    merged.update({key: deployment[key] for key in ("project_name", "pages_project_url") if key in deployment})
    return SimpleNamespace(**merged)


def _cleanup_blocked_pages_projects(...):
    ...
```

- [ ] **Step 4: 跑 controller / backend_resume 相关测试**

Run: `./.venv/bin/python -m pytest tests/pipeline/test_controller.py tests/backend/test_backend_resume.py -v`

Expected: PASS

### Task 5: 保存 plan 文档、执行全量验证并准备交付

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/docs/superpowers/plans/2026-05-07-pages-blocked-fallback-and-share-sub-sync.md`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/config/test_store.py`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/integrations/test_cloudflare.py`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/pipeline/test_controller.py`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/backend/test_backend_resume.py`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/tests/e2e/test_controller_e2e.py`
- Verify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/pages-blocked-share-sub-sync/electron/tests/*.test.mjs`

- [ ] **Step 1: 运行 Python 全量测试**

Run: `./scripts/run_pytest.sh tests -v`

Expected: 全绿

- [ ] **Step 2: 运行 Electron 全量测试**

Run: `node --test electron/tests/*.test.mjs`

Expected: 全绿

- [ ] **Step 3: 如有变更，更新 plan 勾选状态并准备 PR**

```bash
git status --short
git diff --stat
```

- [ ] **Step 4: 提交前做本地 review**

Run: `git diff --check && git diff --stat`

Expected: 无空白错误，diff 范围符合 spec
