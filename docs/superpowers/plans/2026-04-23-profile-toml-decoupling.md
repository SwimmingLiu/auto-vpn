# Profile TOML Decoupling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the runtime profile with a TOML file that is easy to edit, remove old-project path dependencies, and keep Electron and Python aligned on the new storage model.

**Architecture:** Move all user-editable settings into a single `state/profile.toml`, derive runtime paths from the current project root, centralize TOML serialization in the Python backend, and keep Electron using JSON objects over IPC. Store the worker template inside this repository so pipeline rendering never touches sibling repositories.

**Tech Stack:** Python 3.12, pytest, Electron, Node.js built-in test runner, TOML via Python library.

---

### Task 1: Replace JSON profile storage with TOML and remove workspace paths

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/pyproject.toml`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/store.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/runtime.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_store.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`

- [ ] **Step 1: Write the failing config-storage regression tests**

```python
def test_profile_store_bootstraps_toml_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    store = ProfileStore(project_root / "state" / "profile.toml")

    profile = store.load_or_create(project_root)

    assert store.path.name == "profile.toml"
    assert "workspace" not in profile.to_dict()
    assert profile.sources["leiting"].enabled is True


def test_resolve_profile_path_prefers_repo_anchor_toml_when_running_from_worktree(tmp_path: Path) -> None:
    repo_root = tmp_path / "vpn-subscription-automation"
    worktree_root = repo_root / ".worktrees" / "cleanup"
    anchor_profile = repo_root / "state" / "profile.toml"

    repo_root.mkdir(parents=True)
    worktree_root.mkdir(parents=True)
    (repo_root / "pyproject.toml").write_text("", encoding="utf-8")

    assert resolve_profile_path(worktree_root) == anchor_profile


def test_ensure_profile_json_omits_workspace_block(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    payload = json.loads(ensure_profile_json(project_root))

    assert "workspace" not in payload
    assert payload["deploy"]["project_name"] == "vmessnodes"
```

- [ ] **Step 2: Run the targeted tests to verify red**

Run:

```bash
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/profile-toml-decouple/.venv/bin/python -m pytest tests/config/test_store.py tests/config/test_runtime_paths.py tests/backend/test_backend_cli.py -q
```

Expected:

- failures because code still resolves `state/profiles/default.json`
- failures because `workspace` is still present in the serialized profile

- [ ] **Step 3: Implement minimal TOML-backed profile storage**

```python
@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig
    filters: FilterConfig = field(default_factory=FilterConfig)


def resolve_profile_path(project_root: Path) -> Path:
    candidate_root = Path(project_root).resolve()
    repo_root = resolve_repo_anchor(candidate_root)
    return repo_root / "state" / "profile.toml"
```

Implementation details:

- add TOML dependency to `pyproject.toml`
- remove `WorkspaceConfig`
- keep default values in Python code
- make `ProfileStore.save()` write TOML instead of JSON
- make `ProfileStore.load()` parse TOML into `AppProfile`
- keep `ensure_profile_json()` returning JSON for Electron
- keep `.env` resolution anchored to repo root, not config file contents

- [ ] **Step 4: Run the targeted tests to verify green**

Run:

```bash
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/profile-toml-decouple/.venv/bin/python -m pytest tests/config/test_store.py tests/config/test_runtime_paths.py tests/backend/test_backend_cli.py -q
```

Expected:

- all selected tests pass
- generated file path is `state/profile.toml`

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml src/vpn_automation/config/models.py src/vpn_automation/config/store.py src/vpn_automation/config/runtime.py tests/config/test_store.py tests/config/test_runtime_paths.py tests/backend/test_backend_cli.py
git commit -m "refactor: move runtime profile to toml"
```

### Task 2: Move template ownership into this repository and route save/load through backend

**Files:**
- Add: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/backend.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/ipc.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/paths.js`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/backend.test.mjs`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Write the failing runtime-decoupling tests**

```python
def test_pipeline_controller_uses_project_template_path(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const MainData = `old`;", encoding="utf-8")

    profile = create_default_profile(project_root)
    controller = PipelineController(...)

    summary = controller.run(profile)

    assert (Path(summary.artifact_dir) / "vmess_node.js").exists()


test('resolveStateProfilePath uses state/profile.toml for worktrees', () => {
  const worktreeRoot = path.join(repoRoot, '.worktrees', 'cleanup');
  const anchorProfile = path.join(repoRoot, 'state', 'profile.toml');
  assert.equal(resolveStateProfilePath(worktreeRoot), anchorProfile);
});
```

- [ ] **Step 2: Run the targeted tests to verify red**

Run:

```bash
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/profile-toml-decouple/.venv/bin/python -m pytest tests/e2e/test_controller_e2e.py -q
node --test electron/tests/backend.test.mjs
```

Expected:

- e2e tests fail because controller still reads `edgetunnel_root`
- Electron backend path test fails because it still points at `default.json`

- [ ] **Step 3: Implement minimal decoupling code**

```python
def resolve_template_path(project_root: Path) -> Path:
    repo_root = resolve_repo_anchor(project_root)
    return repo_root / "templates" / "vmess_node.js"


def save_profile_json(project_root: Path, payload: dict[str, Any]) -> None:
    store = ProfileStore(resolve_profile_path(project_root))
    store.save(AppProfile.from_dict(payload))
```

```javascript
ipcMain.handle('profile:save', async (_event, payload) => {
  const invocation = buildBackendInvocation(projectRoot, 'profile-save');
  await runCommand(invocation.commands, invocation.args, projectRoot, JSON.stringify(payload));
  return { ok: true };
});
```

Implementation details:

- add new backend subcommand for save
- make Electron save call backend instead of direct filesystem JSON write
- keep `profile:load` unchanged at IPC boundary
- update `resolveStateProfilePath()` to return `state/profile.toml`
- add repository-owned `templates/vmess_node.js`
- change controller render stage to use derived template path, not profile workspace paths

- [ ] **Step 4: Run the targeted tests to verify green**

Run:

```bash
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/profile-toml-decouple/.venv/bin/python -m pytest tests/e2e/test_controller_e2e.py tests/pipeline/test_render.py tests/pipeline/test_extract.py -q
node --test electron/tests/backend.test.mjs
```

Expected:

- e2e tests pass using in-repo template path
- Electron backend tests pass with TOML path and backend save routing

- [ ] **Step 5: Commit**

```bash
git add templates/vmess_node.js src/vpn_automation/backend.py src/vpn_automation/pipeline/controller.py electron/ipc.js electron/paths.js electron/tests/backend.test.mjs tests/e2e/test_controller_e2e.py tests/pipeline/test_render.py tests/pipeline/test_extract.py
git commit -m "refactor: internalize runtime resources"
```

### Task 3: Update docs and run full verification before PR

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/README.md`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/docs/superpowers/specs/2026-04-23-profile-toml-decoupling-design.md`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/docs/superpowers/plans/2026-04-23-profile-toml-decoupling.md`

- [ ] **Step 1: Update the user-facing docs**

```markdown
## Canonical Runtime Profile

桌面端当前唯一主配置文件：

- `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profile.toml`

说明：

- 该文件为 TOML，可直接人工编辑
- 兄弟项目目录不再作为配置或模板来源
- `state/profiles/default.json` 已废弃
```

- [ ] **Step 2: Run the full relevant verification stack**

Run:

```bash
/Users/swimmingliu/data/VPN/vpn-subscription-automation/.worktrees/profile-toml-decouple/.venv/bin/python -m pytest tests -q
node --test electron/tests/*.test.mjs
```

If Electron visual tests require Playwright browser install, run:

```bash
npx playwright install chromium
```

Then rerun:

```bash
node --test electron/tests/*.test.mjs
```

- [ ] **Step 3: Manual UI verification**

Run:

```bash
npm run electron:dev
```

Manual checks:

- app loads profile from `state/profile.toml`
- edit one source URL or key in UI and save
- close and relaunch app
- confirm edited value persists

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-04-23-profile-toml-decoupling-design.md docs/superpowers/plans/2026-04-23-profile-toml-decoupling.md
git commit -m "docs: document toml profile reset"
```
