# Sub-nodes Worker Build Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable Worker build/transform/bundle outputs, expose deploy target details in UI/logs, and close every remaining item in `TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md` without breaking the existing `sub-nodes` Pages deployment path.

**Architecture:** Keep `artifact_dir/_worker.js` and `artifact_dir/pages_bundle/_worker.js` as the canonical deployment artifacts, but introduce a structured Worker build layer before obfuscation and a richer Pages bundle writer after obfuscation. Flow new build metadata through `pipeline_report.json` into Electron so settings/results/logs can surface deploy target details without guessing.

**Tech Stack:** Python 3.12, pytest, Electron renderer JS, Playwright, TOML-backed profile store, Cloudflare Pages CLI deployment.

---

## File structure

### Create

- `src/vpn_automation/pipeline/worker_build.py`
- `tests/pipeline/test_worker_build.py`

### Modify

- `src/vpn_automation/config/models.py`
- `src/vpn_automation/config/store.py`
- `src/vpn_automation/pipeline/controller.py`
- `src/vpn_automation/pipeline/package.py`
- `src/vpn_automation/backend_resume.py`
- `src/vpn_automation/integrations/cloudflare.py`
- `src/vpn_automation/backend.py`
- `electron/runtime/default-profile.toml`
- `electron/renderer/app.js`
- `electron/renderer/views.js`
- `electron/tests/renderer-e2e.test.mjs`
- `electron/tests/renderer-visual.test.mjs`
- `electron/tests/ui-state.test.mjs`
- `tests/config/test_store.py`
- `tests/integrations/test_cloudflare.py`
- `tests/pipeline/test_controller.py`
- `tests/e2e/test_controller_e2e.py`
- `README.md`
- `docs/deploy-pages-sub-nodes.md`
- `docs/TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md`

## Task 1: Add `worker_build` profile config and configuration tests

**Files:**
- Create: `tests/pipeline/test_worker_build.py`
- Modify: `src/vpn_automation/config/models.py`
- Modify: `src/vpn_automation/config/store.py`
- Modify: `electron/runtime/default-profile.toml`
- Test: `tests/config/test_store.py`

- [ ] **Step 1: Write failing tests for default config, TOML persistence, and override parsing**

```python
from pathlib import Path

from vpn_automation.config.models import AppProfile, create_default_profile
from vpn_automation.config.store import ProfileStore


def test_worker_build_defaults_are_present(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    assert profile.worker_build.environment_name == "production"
    assert profile.worker_build.entry_filename == "_worker.js"
    assert profile.worker_build.modules_subdir == "modules"
    assert profile.worker_build.enable_keyword_fragmentation is True
    assert profile.worker_build.enable_identifier_randomization is True


def test_worker_build_round_trips_through_store(tmp_path: Path) -> None:
    profile_path = tmp_path / "state" / "profile.toml"
    profile_path.parent.mkdir(parents=True)
    store = ProfileStore(profile_path)

    profile = create_default_profile(tmp_path / "vpn-subscription-automation")
    profile.worker_build.environment_name = "staging"
    profile.worker_build.variable_prefix = "edge"
    profile.worker_build.comment_template = "generated ({environment_name})"
    profile.worker_build.random_noise_min_length = 12
    profile.worker_build.random_noise_max_length = 24
    store.save(profile)

    reloaded = store.load_or_create(tmp_path / "vpn-subscription-automation")
    assert reloaded.worker_build.environment_name == "staging"
    assert reloaded.worker_build.variable_prefix == "edge"
    assert reloaded.worker_build.random_noise_max_length == 24


def test_app_profile_from_dict_accepts_worker_build_payload() -> None:
    profile = AppProfile.from_dict(
        {
            "sources": {},
            "speed_test": {"min_download_mb_s": 1, "timeout_seconds": 20, "concurrency": 3, "urls": []},
            "deploy": {
                "project_name": "sub-nodes",
                "subscription_url": "https://vpn.example/sub",
                "pages_project_url": "https://sub-nodes.pages.dev",
            },
            "worker_build": {
                "environment_name": "review",
                "variable_prefix": "rv",
                "emit_sidecar_modules": False,
            },
        }
    )

    assert profile.worker_build.environment_name == "review"
    assert profile.worker_build.variable_prefix == "rv"
    assert profile.worker_build.emit_sidecar_modules is False
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run: `./scripts/run_pytest.sh tests/config/test_store.py tests/pipeline/test_worker_build.py -v`

Expected: FAIL with missing `worker_build` attribute and/or `AppProfile.from_dict()` not accepting the new section yet.

- [ ] **Step 3: Implement the `WorkerBuildConfig` dataclass and TOML serialization**

```python
@dataclass
class WorkerBuildConfig:
    environment_name: str = "production"
    entry_filename: str = "_worker.js"
    bundle_subdir: str = "pages_bundle"
    modules_subdir: str = "modules"
    manifest_filename: str = "manifest.json"
    variable_prefix: str = "sg"
    comment_template: str = "generated by vpn-subscription-automation ({environment_name})"
    random_noise_min_length: int = 24
    random_noise_max_length: int = 96
    enable_keyword_fragmentation: bool = True
    enable_identifier_randomization: bool = True
    emit_sidecar_modules: bool = True


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig
    worker_build: WorkerBuildConfig = field(default_factory=WorkerBuildConfig)
    availability_targets: dict[str, AvailabilityTargetConfig] = field(default_factory=dict)
    filters: FilterConfig = field(default_factory=FilterConfig)

    @classmethod
    def from_dict(cls, data: dict) -> "AppProfile":
        sources = default_sources()
        for name, value in data.get("sources", {}).items():
            sources[name] = _normalize_source_config(name, value)
        if "availability_targets" in data:
            availability_targets = {
                name: _normalize_availability_target_config(name, value)
                for name, value in data.get("availability_targets", {}).items()
            }
        else:
            availability_targets = default_availability_targets()
        profile = cls(
            sources=sources,
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
            worker_build=WorkerBuildConfig(**data.get("worker_build", {})),
            availability_targets=availability_targets,
            filters=FilterConfig(**data.get("filters", {})),
        )
        return profile
```

```python
def _render_profile_toml(profile: AppProfile) -> str:
    doc = document()
    worker_build_table = table()
    worker_build_table.add("environment_name", profile.worker_build.environment_name)
    worker_build_table.add("entry_filename", profile.worker_build.entry_filename)
    worker_build_table.add("bundle_subdir", profile.worker_build.bundle_subdir)
    worker_build_table.add("modules_subdir", profile.worker_build.modules_subdir)
    worker_build_table.add("manifest_filename", profile.worker_build.manifest_filename)
    worker_build_table.add("variable_prefix", profile.worker_build.variable_prefix)
    worker_build_table.add("comment_template", profile.worker_build.comment_template)
    worker_build_table.add("random_noise_min_length", profile.worker_build.random_noise_min_length)
    worker_build_table.add("random_noise_max_length", profile.worker_build.random_noise_max_length)
    worker_build_table.add("enable_keyword_fragmentation", profile.worker_build.enable_keyword_fragmentation)
    worker_build_table.add("enable_identifier_randomization", profile.worker_build.enable_identifier_randomization)
    worker_build_table.add("emit_sidecar_modules", profile.worker_build.emit_sidecar_modules)
    doc.add("worker_build", worker_build_table)
    return doc.as_string()
```

```toml
[worker_build]
environment_name = "production"
entry_filename = "_worker.js"
bundle_subdir = "pages_bundle"
modules_subdir = "modules"
manifest_filename = "manifest.json"
variable_prefix = "sg"
comment_template = "generated by vpn-subscription-automation ({environment_name})"
random_noise_min_length = 24
random_noise_max_length = 96
enable_keyword_fragmentation = true
enable_identifier_randomization = true
emit_sidecar_modules = true
```

- [ ] **Step 4: Re-run the config tests until they pass**

Run: `./scripts/run_pytest.sh tests/config/test_store.py tests/pipeline/test_worker_build.py -v`

Expected: PASS with all `worker_build` defaults persisted and reloaded.

- [ ] **Step 5: Commit the config foundation**

```bash
git add \
  src/vpn_automation/config/models.py \
  src/vpn_automation/config/store.py \
  electron/runtime/default-profile.toml \
  tests/config/test_store.py \
  tests/pipeline/test_worker_build.py
git commit -m "feat: add worker build profile config"
```

## Task 2: Build structured Worker artifacts before obfuscation

**Files:**
- Create: `src/vpn_automation/pipeline/worker_build.py`
- Modify: `src/vpn_automation/pipeline/controller.py`
- Modify: `src/vpn_automation/backend_resume.py`
- Test: `tests/pipeline/test_worker_build.py`
- Test: `tests/pipeline/test_controller.py`

- [ ] **Step 1: Write failing tests for keyword fragmentation, randomized identifiers, and transformed source output**

```python
from vpn_automation.config.models import WorkerBuildConfig
from vpn_automation.pipeline.worker_build import build_worker_artifacts


def test_build_worker_artifacts_fragments_secret_literals() -> None:
    config = WorkerBuildConfig(variable_prefix="edge", random_noise_min_length=8, random_noise_max_length=12)
    rendered = """const MainData = `alpha`; export default { async fetch(request) { return request.url; } };"""

    artifacts = build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    assert "['ser', 'ect', '_key'].join('')" in artifacts.transformed_source
    assert "['swim', 'ming', 'liu'].join('')" in artifacts.transformed_source
    assert "const edge_" in artifacts.transformed_source
    assert "generated by vpn-subscription-automation" in artifacts.transformed_source


def test_build_worker_artifacts_emits_sidecar_modules_and_manifest() -> None:
    config = WorkerBuildConfig(environment_name="staging", variable_prefix="vf")
    rendered = "const MainData = `payload`;"

    artifacts = build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    assert sorted(artifacts.modules) == [
        "modules/guard.js",
        "modules/noise.js",
        "modules/payload.js",
        "modules/runtime.js",
    ]
    assert artifacts.manifest["environment_name"] == "staging"
    assert artifacts.manifest["entry_filename"] == "_worker.js"
    assert artifacts.manifest["variable_prefix"] == "vf"
```

- [ ] **Step 2: Run the new Worker build tests and confirm they fail**

Run: `./scripts/run_pytest.sh tests/pipeline/test_worker_build.py tests/pipeline/test_controller.py -v`

Expected: FAIL because `build_worker_artifacts()` and transformed source handling do not exist yet.

- [ ] **Step 3: Implement `WorkerBuildArtifacts`, string fragmentation, identifier generation, and transformed source writing**

```python
@dataclass
class WorkerBuildArtifacts:
    transformed_source: str
    modules: dict[str, str]
    manifest: dict[str, Any]


def build_worker_artifacts(rendered_source: str, config: WorkerBuildConfig, secret_query: str) -> WorkerBuildArtifacts:
    secret_key, secret_value = secret_query.split("=", 1)
    key_expr = _fragment_literal(secret_key, config.enable_keyword_fragmentation)
    value_expr = _fragment_literal(secret_value, config.enable_keyword_fragmentation)
    prefix = _stable_identifier_prefix(config.variable_prefix)
    payload_name = f"{prefix}_payload"
    key_name = f"{prefix}_secret_key"
    value_name = f"{prefix}_secret_value"
    noise_name = f"{prefix}_noise"
    comment = config.comment_template.format(environment_name=config.environment_name)

    modules = {
        "modules/runtime.js": f"export const {payload_name} = {json.dumps(rendered_source)};\n",
        "modules/guard.js": f"export const {key_name} = {key_expr};\nexport const {value_name} = {value_expr};\n",
        "modules/noise.js": _build_noise_module(noise_name, config),
        "modules/payload.js": f"export function decodePayload() {{ return {payload_name}; }}\n",
    }
    transformed_source = _build_worker_entry(rendered_source, payload_name, key_name, value_name, noise_name, comment)
    manifest = {
        "environment_name": config.environment_name,
        "entry_filename": config.entry_filename,
        "modules": sorted(modules),
        "variable_prefix": config.variable_prefix,
        "enable_keyword_fragmentation": config.enable_keyword_fragmentation,
        "enable_identifier_randomization": config.enable_identifier_randomization,
    }
    return WorkerBuildArtifacts(transformed_source=transformed_source, modules=modules, manifest=manifest)
```

```python
build_artifacts = build_worker_artifacts(
    rendered_path.read_text(encoding="utf-8"),
    profile.worker_build,
    profile.deploy.secret_query,
)
transformed_path = artifact_dir / "worker_transformed.js"
transformed_path.write_text(build_artifacts.transformed_source, encoding="utf-8")
obfuscated_path = artifact_dir / profile.worker_build.entry_filename
self.obfuscator(transformed_path, obfuscated_path)
summary.counts["worker_modules"] = len(build_artifacts.modules)
```

```python
build_artifacts = build_worker_artifacts(
    rendered_path.read_text(encoding="utf-8"),
    profile.worker_build,
    profile.deploy.secret_query,
)
transformed_path = retry_artifact_dir / "worker_transformed.js"
transformed_path.write_text(build_artifacts.transformed_source, encoding="utf-8")
controller.obfuscator(transformed_path, obfuscated_path)
```

- [ ] **Step 4: Re-run Worker build and controller tests until they pass**

Run: `./scripts/run_pytest.sh tests/pipeline/test_worker_build.py tests/pipeline/test_controller.py -v`

Expected: PASS with transformed worker source created before obfuscation and sidecar module metadata available.

- [ ] **Step 5: Commit the Worker build layer**

```bash
git add \
  src/vpn_automation/pipeline/worker_build.py \
  src/vpn_automation/pipeline/controller.py \
  src/vpn_automation/backend_resume.py \
  tests/pipeline/test_worker_build.py \
  tests/pipeline/test_controller.py
git commit -m "feat: build structured worker artifacts before obfuscation"
```

## Task 3: Write richer Pages bundles and deployment metadata

**Files:**
- Modify: `src/vpn_automation/pipeline/package.py`
- Modify: `src/vpn_automation/integrations/cloudflare.py`
- Modify: `src/vpn_automation/pipeline/controller.py`
- Modify: `src/vpn_automation/backend_resume.py`
- Modify: `src/vpn_automation/backend.py`
- Test: `tests/integrations/test_cloudflare.py`
- Test: `tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Add failing tests for `pages_bundle/modules/*`, `manifest.json`, and deployment summary metadata**

```python
from pathlib import Path

from vpn_automation.config.models import DeployConfig, WorkerBuildConfig
from vpn_automation.pipeline.package import build_pages_bundle
from vpn_automation.pipeline.worker_build import build_worker_artifacts


def test_build_pages_bundle_writes_modules_and_manifest(tmp_path: Path) -> None:
    config = WorkerBuildConfig()
    artifacts = build_worker_artifacts("const MainData = `payload`;", config, "serect_key=swimmingliu")

    bundle_dir = build_pages_bundle("obfuscated", tmp_path / "pages_bundle", artifacts, config)

    assert (bundle_dir / "_worker.js").read_text(encoding="utf-8") == "obfuscated"
    assert (bundle_dir / "modules" / "guard.js").exists()
    assert (bundle_dir / "modules" / "payload.js").exists()
    assert (bundle_dir / "manifest.json").exists()


def test_deploy_pages_bundle_returns_target_metadata(monkeypatch, tmp_path: Path) -> None:
    bundle_dir = tmp_path / "pages_bundle"
    bundle_dir.mkdir()
    (bundle_dir / "_worker.js").write_text("ok", encoding="utf-8")
    (bundle_dir / "manifest.json").write_text("{}", encoding="utf-8")
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://vpn.example/sub",
        pages_project_url="https://sub-nodes.pages.dev",
    )

    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["project_name"] == "sub-nodes"
    assert result["pages_project_url"] == "https://sub-nodes.pages.dev"
    assert result["bundle_dir"] == str(bundle_dir)
    assert result["worker_entry"] == str(bundle_dir / "_worker.js")
    assert result["module_manifest_path"] == str(bundle_dir / "manifest.json")
```

- [ ] **Step 2: Run the packaging/deploy tests to verify the missing outputs**

Run: `./scripts/run_pytest.sh tests/integrations/test_cloudflare.py tests/e2e/test_controller_e2e.py tests/pipeline/test_worker_build.py -v`

Expected: FAIL because `build_pages_bundle()` still only writes `_worker.js`, and deploy summaries still omit target metadata.

- [ ] **Step 3: Extend bundle writing, deployment metadata, and deploy logs**

```python
def build_pages_bundle(
    worker_js: str,
    output_dir: Path,
    build_artifacts: WorkerBuildArtifacts | None = None,
    config: WorkerBuildConfig | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "_worker.js"
    target.write_text(worker_js, encoding="utf-8")

    if build_artifacts and config and config.emit_sidecar_modules:
        for relative_path, content in build_artifacts.modules.items():
            module_path = output_dir / relative_path
            module_path.parent.mkdir(parents=True, exist_ok=True)
            module_path.write_text(content, encoding="utf-8")
        manifest_path = output_dir / config.manifest_filename
        manifest_path.write_text(json.dumps(build_artifacts.manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return output_dir
```

```python
log(
    f"[deploy] project={profile.deploy.project_name} "
    f"bundle={bundle_dir} url={profile.deploy.pages_project_url}"
)
deployment = self.deployer(bundle_dir, profile.deploy, api_token)
summary.deployment = deployment
log(
    f"[deploy] returncode={deployment.get('returncode')} "
    f"attempts={','.join(item['mode'] for item in deployment.get('attempts', []))}"
)
```

```python
return {
    "command": command,
    "returncode": result.returncode,
    "stdout": result.stdout,
    "stderr": result.stderr,
    "attempts": attempt_log,
    "project_name": deploy.project_name,
    "pages_project_url": deploy.pages_project_url,
    "bundle_dir": str(bundle_dir),
    "worker_entry": str(bundle_dir / "_worker.js"),
    "module_manifest_path": str(bundle_dir / "manifest.json"),
}
```

- [ ] **Step 4: Re-run integration and e2e tests until bundle outputs and deployment metadata pass**

Run: `./scripts/run_pytest.sh tests/integrations/test_cloudflare.py tests/e2e/test_controller_e2e.py -v`

Expected: PASS with `pages_bundle/modules/*`, `manifest.json`, and deploy target metadata visible in summaries.

- [ ] **Step 5: Commit the package/deploy metadata work**

```bash
git add \
  src/vpn_automation/pipeline/package.py \
  src/vpn_automation/integrations/cloudflare.py \
  src/vpn_automation/pipeline/controller.py \
  src/vpn_automation/backend_resume.py \
  src/vpn_automation/backend.py \
  tests/integrations/test_cloudflare.py \
  tests/e2e/test_controller_e2e.py
git commit -m "feat: emit worker bundle modules and deploy metadata"
```

## Task 4: Surface deploy target details in Electron settings, results, and logs

**Files:**
- Modify: `electron/renderer/app.js`
- Modify: `electron/renderer/views.js`
- Modify: `electron/tests/renderer-e2e.test.mjs`
- Modify: `electron/tests/ui-state.test.mjs`
- Modify: `electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Write failing Electron tests for deploy helper copy, save toast, results deploy card, and deploy logs**

```javascript
test('deploy drawer explains project/url linkage and save toast includes target details', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    window.vpnAutomation = {
      loadProfile: async () => ({
        sources: { leiting: { url: 'https://capture.example/api', key: 'demo', enabled: true, max_iterations: 40 } },
        speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
        availability_targets: {},
        deploy: {
          project_name: 'sub-nodes',
          pages_project_url: 'https://sub-nodes.pages.dev',
          subscription_url: 'https://vpn.example.top/sub',
        },
        paths: { project_root: '/Users/user/vpn-sub', artifacts_root: '/Users/user/vpn-sub/artifacts' },
      }),
      latestArtifact: async () => ({ ok: false, artifact_dir: '' }),
      artifactList: async () => ({ ok: true, items: [] }),
      saveProfile: async () => ({ ok: true }),
      generateQr: async () => ({ ok: true, dataUrl: 'data:image/mock;base64,toast' }),
      onPipelineEvent: () => () => {},
    };
  });
  await page.goto(`${server.origin}/index.html`);
  await page.locator('#navSettings').click();
  await page.locator('[data-settings-card="deploy"]').click();
  await page.waitForSelector('#settingsDrawer');

  const drawerText = await page.locator('#settingsDrawer').innerText();
  assert.match(drawerText, /项目名变化会自动联动/);
  assert.match(drawerText, /手动修改 URL 后不再覆盖/);

  await page.locator('[data-drawer-path="deploy.project_name"]').fill('review-sub-nodes');
  await page.locator('[data-drawer-save="save"]').click();
  await page.waitForSelector('[data-toast]');
  assert.match(await page.locator('[data-toast]').innerText(), /review-sub-nodes/);
  assert.match(await page.locator('[data-toast]').innerText(), /https:\/\/review-sub-nodes\.pages\.dev/);
  await browser.close();
  await server.close();
});


test('results page shows deployment target metadata from latest artifact', async () => {
  const server = await startStaticServer(path.join(__dirname, '..', 'renderer'));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.addInitScript(() => {
    window.vpnAutomation = {
      loadProfile: async () => ({
        sources: { leiting: { url: 'https://capture.example/api', key: 'demo', enabled: true, max_iterations: 40 } },
        speed_test: { min_download_mb_s: 1, timeout_seconds: 20, concurrency: 3 },
        availability_targets: {},
        deploy: {
          project_name: 'sub-nodes',
          pages_project_url: 'https://sub-nodes.pages.dev',
          subscription_url: 'https://vpn.example.top/sub',
        },
        paths: { project_root: '/Users/user/vpn-sub', artifacts_root: '/Users/user/vpn-sub/artifacts' },
      }),
      latestArtifact: async () => ({
        ok: true,
        artifact_dir: '/Users/user/vpn-sub/artifacts/20260429-220000',
        deployment: {
          project_name: 'sub-nodes',
          pages_project_url: 'https://sub-nodes.pages.dev',
          worker_entry: '/Users/user/vpn-sub/artifacts/20260429-220000/pages_bundle/_worker.js',
          module_manifest_path: '/Users/user/vpn-sub/artifacts/20260429-220000/pages_bundle/manifest.json',
        },
        counts: { raw_links: 2, deduped_links: 2, speedtest_links: 2, availability_links: 2 },
        source_counts: {},
        outputFiles: [],
        nodeRows: [],
      }),
      artifactList: async () => ({ ok: true, items: [] }),
      previewArtifact: async () => ({ ok: true, outputFiles: [], nodeRows: [] }),
      generateQr: async () => ({ ok: true, dataUrl: 'data:image/mock;base64,results' }),
      onPipelineEvent: () => () => {},
    };
  });
  await page.goto(`${server.origin}/index.html`);
  await page.locator('#navResults').click();
  const resultsText = await page.locator('#resultsWorkspace').innerText();
  assert.match(resultsText, /本次 deploy 目标/);
  assert.match(resultsText, /sub-nodes/);
  assert.match(resultsText, /https:\/\/sub-nodes\.pages\.dev/);
  await browser.close();
  await server.close();
});
```

- [ ] **Step 2: Run the Electron tests and confirm the UI expectations fail**

Run: `node --test electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs`

Expected: FAIL because the deploy helper copy, toast details, and results deploy card do not exist yet.

- [ ] **Step 3: Thread deployment state through the renderer and render the new UI blocks**

```javascript
const state = {
  profile: null,
  savedProfile: null,
  unsubscribe: null,
  stageStatus: {},
  counts: {},
  sourceCounts: {},
  deployment: {},
};

if (event.type === 'summary') {
  state.stageStatus = event.stage_status ?? {};
  state.counts = normalizeCounts(event.counts ?? {});
  state.sourceCounts = normalizeSourceCounts(event.source_counts ?? state.sourceCounts);
  state.deployment = event.deployment ?? {};
}

async function hydrateLatestArtifact() {
  const result = await window.vpnAutomation.latestArtifact();
  state.deployment = result.deployment ?? {};
}

async function hydrateArtifactPreview() {
  const result = await window.vpnAutomation.previewArtifact(state.artifactDir);
  if (result?.deployment) {
    state.deployment = result.deployment;
  }
}
```

```javascript
async function saveSettingsDrawer() {
  const { section, draft } = state.settingsDrawer;
  state.profile[section] = resolveSettingsDraftPayload(section, draft);
  state.settingsDrawer = null;
  state.modalTransform = '';
  if (section === 'deploy') {
    await refreshQrCode();
    showToast({
      tone: 'success',
      message: `部署配置已保存：${state.profile.deploy.project_name} · ${state.profile.deploy.pages_project_url}`,
      durationMs: 3200,
    });
    appendLog(
      `[settings] deploy saved project=${state.profile.deploy.project_name} url=${state.profile.deploy.pages_project_url}`
    );
  }
}
```

```javascript
const deployment = vm.deployment?.project_name
  ? vm.deployment
  : {
      project_name: vm.profile.deploy.project_name,
      pages_project_url: vm.profile.deploy.pages_project_url,
    };

return `
  <article class="panel wide-panel">
    <div class="panel-headline"><h3>本次 deploy 目标</h3><span class="panel-subcopy">部署摘要</span></div>
    <div class="key-value-list">
      <div class="key-value-row"><span>项目名称</span><strong>${escapeHtml(deployment.project_name || '—')}</strong></div>
      <div class="key-value-row"><span>Pages 地址</span><strong class="mono">${escapeHtml(deployment.pages_project_url || '—')}</strong></div>
      <div class="key-value-row"><span>入口文件</span><strong class="mono">${escapeHtml(deployment.worker_entry || '_worker.js')}</strong></div>
      <div class="key-value-row"><span>Manifest</span><strong class="mono">${escapeHtml(deployment.module_manifest_path || '—')}</strong></div>
    </div>
  </article>
`;
```

```javascript
return `
  <div class="notice-card subtle">
    <strong>部署配置说明</strong>
    <p>项目名变化会自动联动默认 Pages 地址；手动修改 URL 后，后续不再自动覆盖。</p>
  </div>
  <div class="form-grid compact-form-grid">
    ${renderDrawerField('项目名称', 'text', draft.project_name, 'deploy.project_name')}
    ${renderDrawerField('Pages 地址', 'text', draft.pages_project_url, 'deploy.pages_project_url')}
  </div>
`;
```

- [ ] **Step 4: Re-run Electron e2e/state tests and update visual hashes**

Run: `node --test electron/tests/renderer-e2e.test.mjs electron/tests/ui-state.test.mjs electron/tests/renderer-visual.test.mjs`

Expected: PASS after updating the mocked `latestArtifact` payloads to include `deployment` and replacing `EXPECTED_DIGESTS` with the new hash set from the modified UI.

- [ ] **Step 5: Commit the Electron deploy-target UX updates**

```bash
git add \
  electron/renderer/app.js \
  electron/renderer/views.js \
  electron/tests/renderer-e2e.test.mjs \
  electron/tests/ui-state.test.mjs \
  electron/tests/renderer-visual.test.mjs
git commit -m "feat: surface deploy target details in electron ui"
```

## Task 5: Update docs and close the TODO checklist

**Files:**
- Modify: `README.md`
- Modify: `docs/deploy-pages-sub-nodes.md`
- Modify: `docs/TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md`

- [ ] **Step 1: Write the doc changes directly against the remaining unchecked TODO items**

````markdown
## Worker build configuration

`profile.toml` now includes a `[worker_build]` section:

```toml
[worker_build]
environment_name = "production"
variable_prefix = "sg"
comment_template = "generated by vpn-subscription-automation ({environment_name})"
enable_keyword_fragmentation = true
enable_identifier_randomization = true
emit_sidecar_modules = true
```

Build outputs:

- `artifact_dir/worker_transformed.js`
- `artifact_dir/_worker.js`
- `artifact_dir/pages_bundle/_worker.js`
- `artifact_dir/pages_bundle/modules/*.js`
- `artifact_dir/pages_bundle/manifest.json`
````

````markdown
- [x] 抽象构建脚本中的常量和字符串为外部配置，支持多环境部署
- [x] 增强构建工具的代码生成能力，支持自定义变量命名规则和注释模板
- [x] 改进 Worker 打包输出结构，按功能模块拆分输出文件
- [x] 引入代码转换器（Transformer），在构建时自动优化代码结构（如提取重复逻辑、简化条件判断）
- [x] 在设置页 deploy 卡片增加辅助说明文案，减少误操作
- [x] 在 deploy 配置保存后增加更明确的成功提示
- [x] 在运行结果页展示本次 deploy 所使用的 `project_name`
- [x] 在日志中增加 deploy 目标项目名的显式输出，便于排查问题
- [x] 考虑引入自动化测试覆盖部署配置联动逻辑
- [x] Worker 产物已做基础的关键词混淆与随机化处理
````

- [ ] **Step 2: Verify the docs mention the new bundle structure and no unchecked items remain**

Run: `rtk rg -n "\[ \]" README.md docs/deploy-pages-sub-nodes.md docs/TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md`

Expected: Only unrelated TODO docs may contain unchecked boxes; the target TODO file should no longer have remaining unchecked entries.

- [ ] **Step 3: Commit the docs and checklist updates**

```bash
git add \
  README.md \
  docs/deploy-pages-sub-nodes.md \
  docs/TODO-2026-04-29-sub-nodes-deploy-and-worker-alignment.md
git commit -m "docs: document worker build alignment outputs"
```

## Task 6: Run the full verification workflow and local review

**Files:**
- Modify if needed after fixes: any of the files above
- Test: `tests/**/*`
- Test: `electron/tests/*.test.mjs`

- [ ] **Step 1: Run the full automated test suite**

Run: `rtk npm run test:all`

Expected: PASS with pytest and all Electron tests green.

- [ ] **Step 2: Verify the updated UI behavior with Playwright/Computer Use**

Run:

```bash
rtk npm run electron:dev
```

Manual checks to perform:

- Open 设置 → 部署配置 and confirm helper copy is visible
- Change `project_name`, confirm `pages_project_url` auto-links before manual override
- Save deploy config and confirm the success toast contains the project name and URL
- Open 结果 page and confirm “本次 deploy 目标” shows `project_name` and `pages_project_url`
- Open 日志 page after a run/retry and confirm deploy target logs are visible

Expected: All checks pass without breaking QR code generation or subscription card URLs.

- [ ] **Step 3: Run a local code review against the diff**

Run:

```bash
rtk git diff -- src/vpn_automation electron README.md docs
```

Review checklist:

- `_worker.js` path semantics unchanged
- `pages_bundle/_worker.js` still deploys by directory upload
- `manifest.json` and sidecar modules are additive, not a new runtime dependency
- UI changes only surface existing data and do not change subscription URL semantics

- [ ] **Step 4: If review finds issues, fix them and rerun the affected tests**

Run the smallest relevant command first, for example:

```bash
./scripts/run_pytest.sh tests/pipeline/test_worker_build.py tests/e2e/test_controller_e2e.py -v
node --test electron/tests/renderer-e2e.test.mjs
```

Expected: PASS after each targeted fix before re-running the full suite.

- [ ] **Step 5: Final commit after verification**

```bash
git add src/vpn_automation electron README.md docs tests
git commit -m "feat: finish sub-nodes worker build alignment"
```
