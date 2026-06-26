# VPN Subscription Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local desktop GUI that orchestrates node extraction, deduplication, speed testing, vmess rendering, obfuscation, and Cloudflare Pages deployment with minimal user input.

**Architecture:** A standalone Python desktop application controls the existing sibling projects through adapters. Core business logic lives in testable Python modules; Node tooling is used only for obfuscation and Wrangler-based deployment. Artifacts are written per run for replay and verification.

**Tech Stack:** Python 3.12, tkinter/ttk, pytest, Node.js, javascript-obfuscator, Wrangler, Xray-core

---

### Task 1: Scaffold the standalone automation repository

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `.gitignore`
- Create: `src/vpn_automation/__init__.py`
- Create: `src/vpn_automation/app.py`
- Create: `src/vpn_automation/config/__init__.py`
- Create: `tests/test_smoke.py`

- [ ] **Step 1: Write the failing smoke test**

```python
from vpn_automation.app import build_app_metadata


def test_build_app_metadata_returns_name_and_version() -> None:
    metadata = build_app_metadata()
    assert metadata["name"] == "vpn-subscription-automation"
    assert metadata["version"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/test_smoke.py -v`
Expected: FAIL with `ModuleNotFoundError` or missing `build_app_metadata`

- [ ] **Step 3: Write minimal project files**

```toml
[build-system]
requires = ["setuptools>=69", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "vpn-subscription-automation"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = ["pytest>=8.0.0"]

[tool.pytest.ini_options]
pythonpath = ["src"]
```

```python
def build_app_metadata() -> dict[str, str]:
    return {
        "name": "vpn-subscription-automation",
        "version": "0.1.0",
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/test_smoke.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add pyproject.toml README.md .gitignore src/vpn_automation/__init__.py src/vpn_automation/app.py src/vpn_automation/config/__init__.py tests/test_smoke.py
git commit -m "chore: scaffold automation project"
```

### Task 2: Add profile models and persistence

**Files:**
- Create: `src/vpn_automation/config/models.py`
- Create: `src/vpn_automation/config/store.py`
- Create: `tests/config/test_store.py`

- [ ] **Step 1: Write the failing persistence test**

```python
from pathlib import Path

from vpn_automation.config.models import AppProfile, SourceConfig, SpeedTestConfig, DeployConfig
from vpn_automation.config.store import ProfileStore


def test_profile_store_round_trip(tmp_path: Path) -> None:
    profile = AppProfile(
        sources={"leiting": SourceConfig(url="https://a.example", key="k1", enabled=True)},
        speed_test=SpeedTestConfig(min_download_mb_s=1.0, timeout_seconds=15, concurrency=4, urls=["https://example.com/file"]),
        deploy=DeployConfig(project_name="vmessnodes", subscription_url="https://swimmingliu.online/test"),
    )
    store = ProfileStore(tmp_path / "default.json")
    store.save(profile)
    loaded = store.load()
    assert loaded.sources["leiting"].url == "https://a.example"
    assert loaded.deploy.project_name == "vmessnodes"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/config/test_store.py -v`
Expected: FAIL with import errors

- [ ] **Step 3: Write minimal implementation**

```python
from dataclasses import asdict, dataclass, field


@dataclass
class SourceConfig:
    url: str
    key: str
    enabled: bool = True


@dataclass
class SpeedTestConfig:
    min_download_mb_s: float
    timeout_seconds: int
    concurrency: int
    urls: list[str] = field(default_factory=list)


@dataclass
class DeployConfig:
    project_name: str
    subscription_url: str


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig

    def to_dict(self) -> dict:
        return asdict(self)
```

```python
import json
from pathlib import Path

from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(profile.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")

    def load(self) -> AppProfile:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return AppProfile(
            sources={name: SourceConfig(**value) for name, value in data["sources"].items()},
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/config/test_store.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/config/models.py src/vpn_automation/config/store.py tests/config/test_store.py
git commit -m "feat: add profile persistence"
```

### Task 3: Implement vmess parsing and deduplication

**Files:**
- Create: `src/vpn_automation/pipeline/__init__.py`
- Create: `src/vpn_automation/pipeline/models.py`
- Create: `src/vpn_automation/pipeline/vmess.py`
- Create: `src/vpn_automation/pipeline/dedupe.py`
- Create: `tests/pipeline/test_dedupe.py`

- [ ] **Step 1: Write the failing dedupe test**

```python
from vpn_automation.pipeline.dedupe import dedupe_vmess_links


def test_dedupe_vmess_links_removes_same_endpoint_with_different_ps() -> None:
    same_node_a = "vmess://eyJ2IjoiMiIsInBzIjoiQSIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    same_node_b = "vmess://eyJ2IjoiMiIsInBzIjoiQiIsImFkZCI6IjEuMS4xLjEiLCJwb3J0IjoiNDQzIiwiaWQiOiJ1dWlkIiwibmV0Ijoid3MiLCJob3N0IjoiMS4xLjEuMSIsInBhdGgiOiIvd3MiLCJ0bHMiOiJ0bHMiLCJzbmkiOiIifQ=="
    deduped = dedupe_vmess_links([same_node_a, same_node_b])
    assert len(deduped) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_dedupe.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
from dataclasses import dataclass


@dataclass(frozen=True)
class CanonicalNodeKey:
    add: str
    port: str
    node_id: str
    net: str
    host: str
    path: str
    tls: str
    sni: str
```

```python
import base64
import json

from vpn_automation.pipeline.models import CanonicalNodeKey


def parse_vmess_link(link: str) -> dict:
    encoded = link.removeprefix("vmess://")
    padded = encoded + "=" * (-len(encoded) % 4)
    return json.loads(base64.b64decode(padded).decode("utf-8"))


def canonical_key(payload: dict) -> CanonicalNodeKey:
    return CanonicalNodeKey(
        add=str(payload.get("add", "")),
        port=str(payload.get("port", "")),
        node_id=str(payload.get("id", "")),
        net=str(payload.get("net", "")),
        host=str(payload.get("host", "")),
        path=str(payload.get("path", "")),
        tls=str(payload.get("tls", "")),
        sni=str(payload.get("sni", "")),
    )
```

```python
from vpn_automation.pipeline.vmess import canonical_key, parse_vmess_link


def dedupe_vmess_links(links: list[str]) -> list[str]:
    seen = set()
    result: list[str] = []
    for link in links:
        key = canonical_key(parse_vmess_link(link))
        if key in seen:
            continue
        seen.add(key)
        result.append(link)
    return result
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_dedupe.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/pipeline/__init__.py src/vpn_automation/pipeline/models.py src/vpn_automation/pipeline/vmess.py src/vpn_automation/pipeline/dedupe.py tests/pipeline/test_dedupe.py
git commit -m "feat: add vmess dedupe pipeline"
```

### Task 4: Add source runner adapters around the existing sibling projects

**Files:**
- Create: `src/vpn_automation/pipeline/extract.py`
- Create: `tests/pipeline/test_extract.py`

- [ ] **Step 1: Write the failing source runner test**

```python
from pathlib import Path

from vpn_automation.pipeline.extract import build_source_script_path


def test_build_source_script_path_points_to_existing_run_script() -> None:
    sibling_root = Path("/Users/swimmingliu/data/VPN/vpn-catch-nodes")
    script_path = build_source_script_path(sibling_root, "leiting")
    assert script_path == sibling_root / "run" / "leiting.py"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_extract.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
from pathlib import Path


def build_source_script_path(sibling_root: Path, source_name: str) -> Path:
    return sibling_root / "run" / f"{source_name}.py"
```

```python
import json
from pathlib import Path


def write_vpn_api_config(config_path: Path, payload: dict) -> None:
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_extract.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/pipeline/extract.py tests/pipeline/test_extract.py
git commit -m "feat: add source runner adapters"
```

### Task 5: Add speed test result model and node post-process pipeline

**Files:**
- Create: `src/vpn_automation/pipeline/speedtest.py`
- Create: `src/vpn_automation/pipeline/postprocess.py`
- Create: `tests/pipeline/test_postprocess.py`

- [ ] **Step 1: Write the failing post-process test**

```python
from vpn_automation.pipeline.postprocess import decorate_node_name


def test_decorate_node_name_prefixes_emoji_and_country() -> None:
    updated = decorate_node_name("Node-1", "US", "🇺🇸")
    assert updated == "🇺🇸 US Node-1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_postprocess.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
from dataclasses import dataclass


@dataclass
class SpeedTestResult:
    link: str
    reachable: bool
    average_download_mb_s: float
    latency_ms: int
```

```python
def decorate_node_name(original_name: str, country_code: str, emoji: str) -> str:
    return f"{emoji} {country_code} {original_name}".strip()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_postprocess.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/pipeline/speedtest.py src/vpn_automation/pipeline/postprocess.py tests/pipeline/test_postprocess.py
git commit -m "feat: add speedtest and node postprocess models"
```

### Task 6: Implement rendering and packaging for Pages deployment

**Files:**
- Create: `src/vpn_automation/pipeline/render.py`
- Create: `src/vpn_automation/pipeline/package.py`
- Create: `tests/pipeline/test_render.py`

- [ ] **Step 1: Write the failing render test**

```python
from vpn_automation.pipeline.render import replace_main_data


def test_replace_main_data_swaps_template_block() -> None:
    template = "const MainData = `old`;\\nconsole.log(MainData);"
    rendered = replace_main_data(template, ["vmess://a", "vmess://b"])
    assert "vmess://a\\nvmess://b" in rendered
    assert "`old`" not in rendered
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_render.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
import re


def replace_main_data(template: str, links: list[str]) -> str:
    replacement = "const MainData = `\\n" + "\\n".join(links) + "\\n`"
    return re.sub(r"const MainData = `.*?`", replacement, template, count=1, flags=re.S)
```

```python
from pathlib import Path


def build_pages_bundle(worker_js: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "_worker.js"
    target.write_text(worker_js, encoding="utf-8")
    return output_dir
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/pipeline/test_render.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/pipeline/render.py src/vpn_automation/pipeline/package.py tests/pipeline/test_render.py
git commit -m "feat: add vmess rendering and pages packaging"
```

### Task 7: Add command adapters for obfuscation and Cloudflare deployment

**Files:**
- Create: `src/vpn_automation/integrations/__init__.py`
- Create: `src/vpn_automation/integrations/commands.py`
- Create: `src/vpn_automation/integrations/cloudflare.py`
- Create: `tests/integrations/test_cloudflare.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Write the failing command test**

```python
from pathlib import Path

from vpn_automation.integrations.cloudflare import build_pages_deploy_command


def test_build_pages_deploy_command_contains_project_name() -> None:
    command = build_pages_deploy_command(Path("/tmp/pages_bundle"), "vmessnodes")
    assert command[:4] == ["npx", "wrangler", "pages", "deploy"]
    assert "--project-name" in command
    assert "vmessnodes" in command
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/integrations/test_cloudflare.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
from pathlib import Path


def build_pages_deploy_command(bundle_dir: Path, project_name: str) -> list[str]:
    return [
        "npx",
        "wrangler",
        "pages",
        "deploy",
        str(bundle_dir),
        "--project-name",
        project_name,
    ]
```

```python
import subprocess


def run_command(command: list[str], cwd: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/integrations/test_cloudflare.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/integrations/__init__.py src/vpn_automation/integrations/commands.py src/vpn_automation/integrations/cloudflare.py tests/integrations/test_cloudflare.py pyproject.toml
git commit -m "feat: add deployment command adapters"
```

### Task 8: Build the GUI shell and pipeline controller

**Files:**
- Create: `src/vpn_automation/gui/__init__.py`
- Create: `src/vpn_automation/gui/main_window.py`
- Create: `src/vpn_automation/pipeline/controller.py`
- Modify: `src/vpn_automation/app.py`
- Create: `tests/gui/test_app_metadata.py`

- [ ] **Step 1: Write the failing controller test**

```python
from vpn_automation.pipeline.controller import PipelineController


def test_pipeline_controller_exposes_named_stages() -> None:
    controller = PipelineController()
    assert controller.stage_names()[0] == "doctor"
    assert "deploy" in controller.stage_names()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/gui/test_app_metadata.py -v`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```python
class PipelineController:
    def stage_names(self) -> list[str]:
        return [
            "doctor",
            "extract",
            "dedupe",
            "speedtest",
            "postprocess",
            "render",
            "obfuscate",
            "deploy",
            "verify",
        ]
```

```python
import tkinter as tk
from tkinter import ttk

from vpn_automation.app import build_app_metadata
from vpn_automation.pipeline.controller import PipelineController


def create_main_window() -> tk.Tk:
    metadata = build_app_metadata()
    window = tk.Tk()
    window.title(metadata["name"])
    ttk.Label(window, text="VPN Subscription Automation").pack(padx=12, pady=12)
    ttk.Label(window, text="Stages: " + ", ".join(PipelineController().stage_names())).pack(padx=12, pady=12)
    return window
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && python3 -m pytest tests/gui/test_app_metadata.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add src/vpn_automation/gui/__init__.py src/vpn_automation/gui/main_window.py src/vpn_automation/pipeline/controller.py src/vpn_automation/app.py tests/gui/test_app_metadata.py
git commit -m "feat: add gui shell and pipeline stages"
```

### Task 9: Add first-run repository setup and publish to GitHub

**Files:**
- Modify: `README.md`
- Modify: `.gitignore`

- [ ] **Step 1: Initialize git repository**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && git init`
Expected: prints initialized repository path

- [ ] **Step 2: Add remote creation command**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && gh repo create SwimmingLiu/vpn-subscription-automation --private --source=. --remote=origin --push`
Expected: creates remote private repository and pushes default branch

- [ ] **Step 3: Verify remote is correct**

Run: `cd /Users/swimmingliu/data/VPN/vpn-subscription-automation && git remote -v`
Expected: `origin` points to `git@github.com:SwimmingLiu/vpn-subscription-automation.git`

- [ ] **Step 4: Record bootstrap instructions**

```markdown
## Bootstrap

1. `python3 -m venv .venv`
2. `source .venv/bin/activate`
3. `pip install -e .`
4. `npm install`
5. `npx wrangler login`
6. Install Xray-core and place binary on `PATH`
```

- [ ] **Step 5: Commit**

```bash
cd /Users/swimmingliu/data/VPN/vpn-subscription-automation
git add README.md .gitignore
git commit -m "docs: add bootstrap and publishing instructions"
```
