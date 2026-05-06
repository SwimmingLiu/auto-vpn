# Verify Subscription and Worker Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated verify subscription URL, restore stable emoji decoration with `US` fallback for invalid country codes, and refactor Worker generation so `_worker.js` stays functionally equivalent while becoming more auditable and maintainable.

**Architecture:** Extend the existing `DeployConfig` and Electron deploy drawer with a separate `verify_subscription_url`, then thread that value through both normal and retry verify paths. Keep postprocess as the single decoration point, but normalize invalid country codes to `US` before emoji rendering. Refactor the Worker at the template plus `worker_build.py` layer so the emitted transformed source uses neutral naming, explicit helper structure, and accurate audit comments while preserving the existing `_worker.js` deployment contract.

**Tech Stack:** Python 3.12, pytest, Electron renderer tests (`node --test`), Cloudflare Pages packaging flow, TOML profile persistence.

---

### Task 1: Add `verify_subscription_url` to config defaults and persistence

**Files:**
- Modify: `src/vpn_automation/config/models.py`
- Modify: `src/vpn_automation/config/store.py`
- Modify: `electron/runtime/default-profile.toml`
- Test: `tests/config/test_store.py`
- Test: `tests/config/test_runtime_paths.py`
- Test: `tests/pipeline/test_worker_build.py`

- [ ] **Step 1: Write the failing config tests**

```python
def test_create_default_profile_starts_with_editable_defaults(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")

    assert profile.deploy.subscription_url == "https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937"
    assert (
        profile.deploy.verify_subscription_url
        == "https://www.swimmingliu.xyz/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
    )


def test_profile_store_round_trip(tmp_path: Path) -> None:
    store = ProfileStore(tmp_path / "profile.toml")
    profile = make_profile()
    profile.deploy.verify_subscription_url = "https://verify.example/sub"
    store.save(profile)

    loaded = store.load()

    assert loaded.deploy.verify_subscription_url == "https://verify.example/sub"
```

- [ ] **Step 2: Run the config tests to verify they fail**

Run:

```bash
rtk pytest tests/config/test_store.py tests/config/test_runtime_paths.py tests/pipeline/test_worker_build.py -v
```

Expected: FAIL because `DeployConfig` does not yet expose `verify_subscription_url`, the default profile does not set it, and TOML persistence does not round-trip it.

- [ ] **Step 3: Implement the config field and defaults**

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
```

And persist it in `_render_profile_toml(...)` plus the packaged default profile:

```toml
[deploy]
project_name = "sub-nodes"
subscription_url = "https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937"
verify_subscription_url = "https://www.swimmingliu.xyz/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
pages_project_url = "https://sub-nodes.pages.dev"
```

- [ ] **Step 4: Run the config tests to verify they pass**

Run:

```bash
rtk pytest tests/config/test_store.py tests/config/test_runtime_paths.py tests/pipeline/test_worker_build.py -v
```

Expected: PASS with `verify_subscription_url` present in defaults, TOML save/load, and `AppProfile.from_dict(...)`.

- [ ] **Step 5: Commit the config slice**

```bash
rtk git add \
  src/vpn_automation/config/models.py \
  src/vpn_automation/config/store.py \
  electron/runtime/default-profile.toml \
  tests/config/test_store.py \
  tests/config/test_runtime_paths.py \
  tests/pipeline/test_worker_build.py
rtk git commit -m "feat: add verify subscription config"
```

### Task 2: Use the verify URL in pipeline and expose it in the deploy drawer

**Files:**
- Modify: `src/vpn_automation/pipeline/controller.py`
- Modify: `src/vpn_automation/backend_resume.py`
- Modify: `electron/renderer/views.js`
- Modify: `electron/renderer/app.js`
- Test: `tests/pipeline/test_controller.py`
- Test: `tests/backend/test_backend_resume.py`
- Test: `electron/tests/ui-state.test.mjs`
- Test: `electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Write failing tests for verify URL resolution and deploy drawer fields**

```python
def test_pipeline_controller_prefers_verify_subscription_url(tmp_path: Path) -> None:
    seen = {}

    project_root = tmp_path / "vpn-subscription-automation"
    template_root = project_root / "templates"
    template_root.mkdir(parents=True)
    (template_root / "vmess_node.js").write_text("const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;", encoding="utf-8")

    controller = PipelineController(
        runtime_root_resolver=lambda _candidate: project_root,
        artifacts_root_resolver=lambda root: root / "artifacts",
        template_path_resolver=lambda root: root / "templates" / "vmess_node.js",
        extractor=lambda source_name, source, progress_callback=None: [VMESS_LINK],
        speedtester=lambda links, config, runtime_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=2.5, latency_ms=50)
        ],
        availability_checker=lambda results, config, runtime_path="", progress_callback=None, targets=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={"gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok")},
            )
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text(
            input_path.read_text(encoding="utf-8"),
            encoding="utf-8",
        ),
        verifier=lambda deploy_config, api_token: (
            seen.update({"url": deploy_config.verify_subscription_url}),
            {"secret_ok": True, "subscription_ok": True},
        )[1],
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
    )
    profile = create_default_profile(project_root)
    profile.deploy.verify_subscription_url = "https://verify.example/sub"

    controller.run(profile)

    assert seen["url"] == "https://verify.example/sub"
```

```js
test('settings page renders deploy drawer subscription and verify fields', () => {
  const markup = buildPageMarkup('settings', vm, messages, 'zh-CN');

  assert.match(markup, /deploy\.subscription_url/);
  assert.match(markup, /deploy\.verify_subscription_url/);
  assert.match(markup, /verify 订阅地址/);
});
```

- [ ] **Step 2: Run the focused backend/UI tests to verify they fail**

Run:

```bash
rtk pytest tests/pipeline/test_controller.py tests/backend/test_backend_resume.py -v
rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs
```

Expected: FAIL because verify still reads `subscription_url` only and the deploy drawer does not render a dedicated verify field.

- [ ] **Step 3: Implement verify resolution and UI wiring**

Add a shared helper in both controller paths:

```python
def _resolve_verify_subscription_url(deploy: Any) -> str:
    return str(getattr(deploy, "verify_subscription_url", "") or deploy.subscription_url)
```

Use it from the default verifier:

```python
subscription_ok = client.verify_url(_resolve_verify_subscription_url(deploy))
```

And extend the deploy drawer:

```js
if (section === 'deploy') {
  return `
    <div class="form-grid compact-form-grid">
      ${renderDrawerField('项目名称', 'text', draft.project_name, 'deploy.project_name')}
      ${renderDrawerField('Pages 地址', 'text', draft.pages_project_url, 'deploy.pages_project_url')}
      ${renderDrawerField('订阅地址', 'text', draft.subscription_url, 'deploy.subscription_url')}
      ${renderDrawerField('verify 订阅地址', 'text', draft.verify_subscription_url, 'deploy.verify_subscription_url')}
    </div>
  `;
}
```

- [ ] **Step 4: Re-run the focused backend/UI tests**

Run:

```bash
rtk pytest tests/pipeline/test_controller.py tests/backend/test_backend_resume.py -v
rtk node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs
```

Expected: PASS with verify using the dedicated URL and the settings UI persisting both fields while QR refresh still depends only on `subscription_url`.

- [ ] **Step 5: Commit the verify/UI slice**

```bash
rtk git add \
  src/vpn_automation/pipeline/controller.py \
  src/vpn_automation/backend_resume.py \
  electron/renderer/views.js \
  electron/renderer/app.js \
  tests/pipeline/test_controller.py \
  tests/backend/test_backend_resume.py \
  electron/tests/ui-state.test.mjs \
  electron/tests/renderer-e2e.test.mjs
rtk git commit -m "feat: add dedicated verify subscription url"
```

### Task 3: Normalize invalid country codes to `US` before emoji decoration

**Files:**
- Modify: `src/vpn_automation/pipeline/postprocess.py`
- Test: `tests/pipeline/test_postprocess.py`
- Test: `tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Write failing tests for `ZZ` and malformed-country fallback**

```python
def test_lookup_country_code_returns_us_when_both_geoip_services_fail(monkeypatch) -> None:
    primary_calls: list[str] = []
    secondary_calls: list[str] = []
    sleep_calls: list[float] = []

    class PrimaryResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("429")
            error.response = SimpleNamespace(status_code=429, headers={"Retry-After": "300"})
            raise error

        def json(self) -> dict[str, str]:
            return {}

    class SecondaryResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("503")
            error.response = SimpleNamespace(status_code=503, headers={})
            raise error

        def json(self) -> dict[str, str]:
            return {}

    class FakeSession:
        def __init__(self) -> None:
            self.trust_env = True

        def get(self, url: str, timeout: int) -> PrimaryResponse | SecondaryResponse:
            assert timeout == 20
            if url == "https://ipwho.is/23.224.112.135":
                primary_calls.append(url)
                return PrimaryResponse()
            if url == "https://ipapi.co/23.224.112.135/json/":
                secondary_calls.append(url)
                return SecondaryResponse()
            raise AssertionError(f"unexpected url: {url}")

    cache_clear = getattr(lookup_country_code, "cache_clear", None)
    if callable(cache_clear):
        cache_clear()
    monkeypatch.setattr("vpn_automation.pipeline.postprocess._PRIMARY_GEOIP_BLOCKED_UNTIL", 0.0, raising=False)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.requests.Session", FakeSession)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.time.sleep", sleep_calls.append)

    assert lookup_country_code("23.224.112.135") == "US"
    assert primary_calls == ["https://ipwho.is/23.224.112.135"] * 4
    assert secondary_calls == ["https://ipapi.co/23.224.112.135/json/"]
    assert sleep_calls == [0.5, 1.0, 2.0]


def test_decorate_link_with_country_normalizes_invalid_codes_to_us() -> None:
    updated = decorate_link_with_country(VMESS_LINK, "ZZ")
    assert parse_vmess_link(updated)["ps"].startswith("🇺🇸 US ")
```

- [ ] **Step 2: Run the postprocess tests to verify they fail**

Run:

```bash
rtk pytest tests/pipeline/test_postprocess.py tests/e2e/test_controller_e2e.py -v
```

Expected: FAIL because lookup currently returns `ZZ` and final decoration can still surface unknown/blank-looking flags.

- [ ] **Step 3: Implement stable `US` fallback**

```python
UNKNOWN_COUNTRY_CODE = "US"


def normalize_country_code(country_code: str) -> str:
    normalized = str(country_code or "").strip().upper()
    if len(normalized) != 2 or not normalized.isalpha() or normalized == "ZZ":
        return UNKNOWN_COUNTRY_CODE
    return normalized
```

And always normalize before decoration:

```python
def decorate_link_with_country(link: str, country_code: str) -> str:
    normalized_country = normalize_country_code(country_code)
    payload = parse_vmess_link(link)
    payload["ps"] = decorate_node_name(
        str(payload.get("ps", "")),
        normalized_country,
        country_to_emoji(normalized_country),
    )
    return generate_vmess_link(payload)
```

- [ ] **Step 4: Re-run the postprocess tests**

Run:

```bash
rtk pytest tests/pipeline/test_postprocess.py tests/e2e/test_controller_e2e.py -v
```

Expected: PASS with invalid, missing, and `ZZ` country codes all degrading to a `🇺🇸 US ` name prefix.

- [ ] **Step 5: Commit the postprocess slice**

```bash
rtk git add \
  src/vpn_automation/pipeline/postprocess.py \
  tests/pipeline/test_postprocess.py \
  tests/e2e/test_controller_e2e.py
rtk git commit -m "fix: normalize undecorated country codes to us"
```

### Task 4: Refactor Worker template and build transform for auditability

**Files:**
- Modify: `templates/vmess_node.js`
- Modify: `src/vpn_automation/pipeline/worker_build.py`
- Modify: `src/vpn_automation/pipeline/render.py`
- Test: `tests/pipeline/test_worker_build.py`
- Test: `tests/pipeline/test_controller.py`
- Test: `tests/e2e/test_controller_e2e.py`
- Test: `tests/integrations/test_cloudflare.py`
- Test: `tests/backend/test_backend_resume.py`

- [ ] **Step 1: Write failing tests for the new neutral Worker shape**

```python
def test_build_worker_artifacts_uses_audit_friendly_worker_names() -> None:
    artifacts = build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    assert "SUBSCRIPTION_PAYLOAD" in artifacts.transformed_source
    assert "handleSubscriptionRequest" in artifacts.transformed_source
    assert "secretToken" in artifacts.transformed_source
    assert "responsePayload" in artifacts.transformed_source
    assert "subscription worker" in artifacts.transformed_source.lower()
```

And update fixture expectations that still hardcode `const MainData = \`__MAIN_DATA__\`;`:

```python
(template_root / "vmess_node.js").write_text(
    "const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;",
    encoding="utf-8",
)
```

- [ ] **Step 2: Run the Worker-related tests to verify they fail**

Run:

```bash
rtk pytest \
  tests/pipeline/test_worker_build.py \
  tests/pipeline/test_controller.py \
  tests/e2e/test_controller_e2e.py \
  tests/integrations/test_cloudflare.py \
  tests/backend/test_backend_resume.py -v
```

Expected: FAIL because the template, transform logic, and render error message still assume the old `MainData` / `url_tag` / `req_data` structure.

- [ ] **Step 3: Implement the Worker refactor without changing behavior**

Template target:

```javascript
const SUBSCRIPTION_PAYLOAD = `__MAIN_DATA__`;

function buildRandomPayload() {
  const randomBytes = new Uint8Array(Math.floor(Math.random() * 100));
  crypto.getRandomValues(randomBytes);
  return String.fromCharCode.apply(null, randomBytes);
}

async function handleSubscriptionRequest(request) {
  try {
    const url = new URL(request.url);
    const secretToken = url.searchParams.get("serect_key");
    const responsePayload = secretToken === "swimmingliu"
      ? SUBSCRIPTION_PAYLOAD
      : buildRandomPayload();
    return new Response(btoa(responsePayload));
  } catch (error) {
    console.log(error);
    return new Response(error.toString());
  }
}
```

Build transform target:

```python
replacements = {
    "secretToken": f"{prefix}_secret_token",
    "responsePayload": f"{prefix}_response_payload",
    "randomBytes": f"{prefix}_random_bytes",
    "error": f"{prefix}_error",
}
comment = "subscription worker: returns encoded payload on secret match, random bytes otherwise"
```

- [ ] **Step 4: Re-run the Worker-related tests**

Run:

```bash
rtk pytest \
  tests/pipeline/test_worker_build.py \
  tests/pipeline/test_controller.py \
  tests/e2e/test_controller_e2e.py \
  tests/integrations/test_cloudflare.py \
  tests/backend/test_backend_resume.py -v
```

Expected: PASS with the same artifact paths and deploy contract, but cleaner transformed source and updated fixtures.

- [ ] **Step 5: Commit the Worker refactor slice**

```bash
rtk git add \
  templates/vmess_node.js \
  src/vpn_automation/pipeline/worker_build.py \
  src/vpn_automation/pipeline/render.py \
  tests/pipeline/test_worker_build.py \
  tests/pipeline/test_controller.py \
  tests/e2e/test_controller_e2e.py \
  tests/integrations/test_cloudflare.py \
  tests/backend/test_backend_resume.py
rtk git commit -m "refactor: audit worker generation path"
```

### Task 5: Update docs, run full validation, and package the app

**Files:**
- Modify: `README.md`
- Modify: `docs/deploy-pages-sub-nodes.md`
- Test: `electron/tests/renderer-visual.test.mjs` (hash updates if UI markup changes)

- [ ] **Step 1: Update docs and expected UI copy**

Document:

- `deploy.verify_subscription_url`
- `US` fallback for invalid country grouping
- Worker refactor intent and auditability notes

Example doc snippet:

```toml
[deploy]
subscription_url = "https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937"
verify_subscription_url = "https://www.swimmingliu.xyz/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
```

- [ ] **Step 2: Run the full regression suite**

Run:

```bash
rtk npm run test:all
```

Expected: PASS with updated UI tests, visual hashes, backend tests, and Worker/output expectations.

- [ ] **Step 3: Re-run UI verification after the settings change**

Run:

```bash
rtk node --test electron/tests/renderer-e2e.test.mjs electron/tests/renderer-visual.test.mjs
```

Expected: PASS with deploy drawer showing both subscription fields and no visual regressions beyond the intended hash update.

- [ ] **Step 4: Package the Electron app**

Run:

```bash
rtk npm run package:electron
```

Expected: PASS with the app artifact under:

```text
dist-electron/mac-arm64/VPN Subscription Automation.app
```

- [ ] **Step 5: Commit docs and validation updates**

```bash
rtk git add \
  README.md \
  docs/deploy-pages-sub-nodes.md \
  electron/tests/renderer-visual.test.mjs
rtk git commit -m "docs: document verify url and worker audit updates"
```
