# Node Availability Verification and Multi-Source Speed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add strict Gemini/ChatGPT/Claude homepage availability filtering after speed testing, keep multi-source speed averaging end to end, and update the Electron UI/config summary to reflect the new pipeline behavior.

**Architecture:** Split provider availability checks into a dedicated pipeline module fed by a shared Xray proxy runtime helper so speed tests and provider validation do not duplicate subprocess setup. Keep the pipeline stage boundary explicit by inserting `availability` between `speedtest` and `postprocess`, then surface new counts and copy through the existing Electron renderer.

**Tech Stack:** Python 3.12, pytest, requests, Electron, HTML/CSS/JavaScript, node:test, Playwright

---

### Task 1: Sync the updated profile and lock the new contracts with failing tests

**Files:**
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/state/profiles/default.json`
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_availability.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`

- [ ] **Step 1: Copy the user-updated profile into the worktree and extend `speed_test.urls` to three sources**

```json
"speed_test": {
  "min_download_mb_s": 1.0,
  "timeout_seconds": 20,
  "concurrency": 3,
  "urls": [
    "https://speed.cloudflare.com/__down?bytes=5000000",
    "https://proof.ovh.net/files/1Mb.dat",
    "https://cachefly.cachefly.net/1mb.test"
  ],
  "probe_url": "https://www.gstatic.com/generate_204",
  "max_download_bytes": 5000000,
  "startup_wait_seconds": 1.0
}
```

- [ ] **Step 2: Add a failing Python test for provider availability heuristics**

```python
from vpn_automation.pipeline.availability import ProviderTarget, ProviderCheckResult, evaluate_provider_response


def test_evaluate_provider_response_rejects_region_block_page() -> None:
    target = ProviderTarget(
        name="chatgpt",
        url="https://chatgpt.com/",
        allowed_hosts=("chatgpt.com", "chat.openai.com"),
        negative_phrases=("unsupported country",),
    )

    result = evaluate_provider_response(
        target,
        final_url="https://chatgpt.com/",
        status_code=200,
        title="ChatGPT",
        body="OpenAI services are not available in your unsupported country",
    )

    assert result.passed is False
    assert result.reason == "negative_phrase"
```

- [ ] **Step 3: Add a failing controller e2e test for all-pass filtering**

```python
def test_pipeline_controller_filters_links_when_any_provider_fails(tmp_path: Path) -> None:
    controller = PipelineController(
        extractor=lambda source_name, source, progress_callback=None: [vmess],
        speedtester=lambda links, config, xray_path="", progress_callback=None: [
            SpeedTestResult(link=links[0], reachable=True, average_download_mb_s=3.2, latency_ms=120)
        ],
        country_lookup=lambda host: "US",
        obfuscator=lambda input_path, output_path: output_path.write_text("obfuscated", encoding="utf-8"),
        deployer=lambda bundle_dir, deploy_config, api_token: {"returncode": 0, "stdout": "ok", "stderr": ""},
        verifier=lambda deploy_config, api_token: {"secret_ok": True, "subscription_ok": True},
        env_loader=lambda _candidate: {"CLOUDFLARE_API_TOKEN": "token"},
        availability_checker=lambda results, config, xray_path="", progress_callback=None: [
            AvailabilityResult(
                speed_result=results[0],
                provider_results={
                    "gemini": ProviderCheckResult("gemini", True, "ok"),
                    "chatgpt": ProviderCheckResult("chatgpt", False, "negative_phrase"),
                    "claude": ProviderCheckResult("claude", True, "ok"),
                },
            )
        ],
    )

    summary = controller.run(profile)

    assert summary.counts["speedtest_links"] == 1
    assert summary.counts["availability_links"] == 0
```

- [ ] **Step 4: Add failing Electron tests for the new stage and multi-source summary copy**

```javascript
assert.equal(getMessages('zh-CN').speedCardSubtitle, '阈值 / 并发 / 多站点平均');
assert.equal(getMessages('zh-CN').stageLabels.availability, '站点验证');
assert.match(speedSummary, /3 个测速站点/);
assert.match(speedSummary, /平均下载速度过滤/);
```

- [ ] **Step 5: Run the targeted tests and verify they fail**

Run:
- `python3 -m pytest tests/pipeline/test_availability.py tests/e2e/test_controller_e2e.py -q`
- `node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`

Expected:
- Python fails because `availability.py` and the new controller hook do not exist yet
- Electron fails because the speed summary and stage labels still describe the old UI

- [ ] **Step 6: Commit the red tests and synced profile**

```bash
git add state/profiles/default.json tests/pipeline/test_availability.py tests/e2e/test_controller_e2e.py electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs
git commit -m "test: define availability validation behavior"
```

### Task 2: Implement shared proxy runtime and provider availability checks

**Files:**
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/proxy_runtime.py`
- Create: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/availability.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/speedtest.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_speedtest_runtime.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_availability.py`

- [ ] **Step 1: Extract the Xray subprocess/session setup into a shared helper**

```python
@dataclass
class ProxyRuntime:
    process: subprocess.Popen[str]
    session: requests.Session
    proxies: dict[str, str]
    config_path: Path


@contextmanager
def open_proxy_runtime(link: str, *, probe_url: str, timeout_seconds: int, xray_path: str = ""):
    payload = parse_vmess_link(link)
    binary = resolve_xray_binary(xray_path)
    http_port = _find_free_port()
    socks_port = _find_free_port()
    runtime_config = build_xray_runtime_config(payload, http_port=http_port, socks_port=socks_port)
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        config_path = Path(handle.name)
        handle.write(json.dumps(runtime_config, ensure_ascii=False))

    process = subprocess.Popen(
        [binary, "run", "-config", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    session = requests.Session()
    session.trust_env = False
    proxies = {
        "http": f"http://127.0.0.1:{http_port}",
        "https": f"http://127.0.0.1:{http_port}",
    }
    yield ProxyRuntime(process=process, session=session, proxies=proxies, config_path=config_path)
```

- [ ] **Step 2: Update `speedtest.py` to use the shared runtime without changing average-speed semantics**

```python
with open_proxy_runtime(link, probe_url=config.probe_url, timeout_seconds=config.timeout_seconds, xray_path=xray_path) as runtime:
    latency_started = time.perf_counter()
    probe = runtime.session.get(
        config.probe_url,
        proxies=runtime.proxies,
        timeout=config.timeout_seconds,
        verify=False,
    )
    for url in config.urls:
        speed_values.append(
            _download_speed_mb_s(
                runtime.session,
                url,
                runtime.proxies,
                max_bytes=config.max_download_bytes,
                timeout=config.timeout_seconds,
            )
        )
```

- [ ] **Step 3: Implement provider target registry and all-pass evaluation**

```python
PROVIDER_TARGETS = (
    ProviderTarget(
        name="gemini",
        url="https://gemini.google.com/",
        allowed_hosts=("gemini.google.com", "accounts.google.com"),
        negative_phrases=(
            "not available in your country",
            "not available in your country or territory",
            "isn't available in your country",
            "not available in your region",
        ),
    ),
    ProviderTarget(
        name="chatgpt",
        url="https://chatgpt.com/",
        allowed_hosts=("chatgpt.com", "chat.openai.com", "auth.openai.com", "login.openai.com"),
        negative_phrases=(
            "unsupported country",
            "unsupported region",
            "country, region, or territory",
            "not available in your country",
        ),
    ),
    ProviderTarget(
        name="claude",
        url="https://claude.ai/",
        allowed_hosts=("claude.ai", "support.anthropic.com"),
        negative_phrases=(
            "unavailable in your region",
            "supported regions",
            "physically located in one of our supported regions",
            "outside of our supported locations",
        ),
    ),
)


def check_link_availability(speed_result: SpeedTestResult, timeout_seconds: int, *, xray_path: str = "") -> AvailabilityResult:
    with open_proxy_runtime(speed_result.link, probe_url="", timeout_seconds=timeout_seconds, xray_path=xray_path) as runtime:
        provider_results = {
            target.name: fetch_provider_result(runtime.session, runtime.proxies, target, timeout_seconds)
            for target in PROVIDER_TARGETS
        }
    return AvailabilityResult(speed_result=speed_result, provider_results=provider_results)
```

- [ ] **Step 4: Run the targeted Python tests and verify they pass**

Run: `python3 -m pytest tests/pipeline/test_speedtest_runtime.py tests/pipeline/test_availability.py -q`
Expected: PASS with shared runtime extraction and provider heuristics green

- [ ] **Step 5: Commit the runtime and availability modules**

```bash
git add src/vpn_automation/pipeline/proxy_runtime.py src/vpn_automation/pipeline/availability.py src/vpn_automation/pipeline/speedtest.py tests/pipeline/test_speedtest_runtime.py tests/pipeline/test_availability.py
git commit -m "feat: add provider availability validation runtime"
```

### Task 3: Insert the new stage into the pipeline summary and artifact flow

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/controller.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Add the `availability` stage and controller dependency**

```python
from vpn_automation.pipeline.availability import check_link_availability_batch


class PipelineController:
    def __init__(
        self,
        *,
        extractor: Callable = fetch_source_links,
        speedtester: Callable = speedtest_links,
        availability_checker: Callable = check_link_availability_batch,
        country_lookup: Callable[[str], str] = lookup_country_code,
        obfuscator: Callable[[Path, Path], Any] = obfuscate_javascript,
        deployer: Callable[[Path, Any, str], dict[str, Any]] = deploy_pages_bundle,
        verifier: Callable[[Any, str], dict[str, bool]] | None = None,
        env_loader: Callable[[Path], dict[str, str]] = load_runtime_env,
        now_factory: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.availability_checker = availability_checker

    def stage_names(self) -> list[str]:
        return [
            "doctor",
            "extract",
            "dedupe",
            "speedtest",
            "availability",
            "postprocess",
            "render",
            "obfuscate",
            "deploy",
            "verify",
        ]
```

- [ ] **Step 2: Filter speed results through all-pass provider validation and write artifacts**

```python
set_stage("availability", "running")
availability_results = self.availability_checker(
    fast_results,
    profile.speed_test,
    progress_callback=log,
)
available_results = [item.speed_result for item in availability_results if item.all_passed]
available_links = [item.link for item in available_results]
self._write_lines(artifact_dir / "vpn_node_availability.txt", available_links)
(artifact_dir / "vpn_node_availability_report.json").write_text(
    json.dumps([item.to_dict() for item in availability_results], ensure_ascii=False, indent=2),
    encoding="utf-8",
)
summary.counts["availability_links"] = len(available_links)
set_stage("availability", "success")
```

- [ ] **Step 3: Feed postprocess from availability-passed results instead of raw speedtest results**

```python
ranked_links: list[tuple[str, Any, str]] = []
for result in available_results:
    country_code = self.country_lookup(parse_vmess_link(result.link)["add"])
    ranked_links.append((result.link, result, country_code))
```

- [ ] **Step 4: Run the controller e2e tests and verify they pass**

Run: `python3 -m pytest tests/e2e/test_controller_e2e.py -q`
Expected: PASS with `availability_links` populated and failing providers filtered out

- [ ] **Step 5: Commit the pipeline stage integration**

```bash
git add src/vpn_automation/pipeline/controller.py tests/e2e/test_controller_e2e.py
git commit -m "feat: filter nodes by provider availability"
```

### Task 4: Update Electron copy, stage order, and compact summaries

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/state.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/i18n.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/ui-state.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-e2e.test.mjs`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/renderer-visual.test.mjs`

- [ ] **Step 1: Add the new stage to renderer state and translation tables**

```javascript
export const STAGE_ORDER = [
  'doctor',
  'extract',
  'dedupe',
  'speedtest',
  'availability',
  'postprocess',
  'render',
  'obfuscate',
  'deploy',
  'verify'
];
```

```javascript
speedCardSubtitle: '阈值 / 并发 / 多站点平均',
summarySpeed: '阈值 {speed} MB/s · 并发 {concurrency}',
summarySpeedSources: '{count} 个测速站点，按平均下载速度过滤',
summaryAvailabilityPassed: '三站验证通过 {count}',
stageLabels: {
  availability: '站点验证'
}
```

- [ ] **Step 2: Render the compact speed summary and availability count**

```javascript
elements.speedSummary.innerHTML = [
  createSummaryLine(formatMessage(m.summarySpeed, {
    speed: state.profile.speed_test.min_download_mb_s,
    concurrency: state.profile.speed_test.concurrency
  })),
  createSummaryLine(formatMessage(m.summarySpeedSources, {
    count: state.profile.speed_test.urls.length
  }))
].join('');

elements.metricsSummary.innerHTML = [
  createSummaryLine(formatMessage(m.summaryRawLinks, { count: state.counts.raw_links ?? 0 })),
  createSummaryLine(formatMessage(m.summarySpeedPassed, { count: state.counts.speedtest_links ?? 0 })),
  createSummaryLine(formatMessage(m.summaryAvailabilityPassed, { count: state.counts.availability_links ?? 0 })),
  createSummaryLine(formatMessage(m.summaryVerifyState, {
    status: m.statusLabels[state.stageStatus.verify ?? 'pending'] ?? m.statusLabels.pending
  }))
].join('');
```

- [ ] **Step 3: Run the Electron unit/e2e tests and update the visual hash if needed**

Run:
- `node --test electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs`
- `node --test electron/tests/renderer-visual.test.mjs`

Expected:
- unit/e2e PASS after copy/stage updates
- visual test may FAIL once with a new SHA256 hash; update the assertion, then re-run to PASS

- [ ] **Step 4: Commit the renderer changes**

```bash
git add electron/renderer/state.js electron/renderer/i18n.js electron/renderer/app.js electron/tests/ui-state.test.mjs electron/tests/renderer-e2e.test.mjs electron/tests/renderer-visual.test.mjs
git commit -m "feat: surface availability validation in electron ui"
```

### Task 5: Run full verification and refresh the local preview

**Files:**
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/**/*.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/tests/*.test.mjs`

- [ ] **Step 1: Run the targeted Python regression layers**

Run: `python3 -m pytest tests/config/test_store.py tests/pipeline/test_speedtest_runtime.py tests/pipeline/test_availability.py tests/e2e/test_controller_e2e.py -q`
Expected: PASS

- [ ] **Step 2: Run the Electron regression suite**

Run: `npm run test:electron`
Expected: PASS

- [ ] **Step 3: Start the Electron app and capture a fresh preview**

Run: `npm run electron:dev`
Expected: Electron launches with the compact half-screen window, multi-source speed summary, and the new availability stage

- [ ] **Step 4: Commit any remaining regression baseline updates**

```bash
git add electron/tests/renderer-visual.test.mjs
git commit -m "test: refresh availability dashboard regression baselines"
```
