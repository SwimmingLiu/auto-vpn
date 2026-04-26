# Vmess Node Template and VMS-Nodes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pipeline render output use a fixed vmess worker template with `MainData` placeholder injection, align obfuscation flags with the sibling Cloudflare workflow, and switch default Pages deployment to `vms-nodes`.

**Architecture:** Freeze the worker logic inside a template copied from the sibling reference worker and inject only the node payload through a unique placeholder token. Keep the current pipeline stage boundaries, but harden render validation and update deploy defaults plus related tests.

**Tech Stack:** Python, pytest, TOML-backed profile defaults, Wrangler command assembly, JavaScript worker template.

---

## File map

- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js`
  - Replace the minimal worker body with the reference worker template and `__MAIN_DATA__` placeholder.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/render.py`
  - Replace loose regex substitution with strict placeholder replacement.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_render.py`
  - Add render success and invalid-template coverage.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/integrations/node_tools.py`
  - Align obfuscator flags with the sibling workflow.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/integrations/test_node_tools.py`
  - Assert the exact flag set.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
  - Change default Pages project/domain.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/default-profile.toml`
  - Change packaged default deploy target.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/integrations/test_cloudflare.py`
  - Update helper expectations for the new domain/project.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`
  - Update bootstrap default project assertions.
- Modify `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py`
  - Add or update default profile expectations if needed.

---

### Task 1: Lock rendering to a single `MainData` placeholder

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_render.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/templates/vmess_node.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/render.py`

- [ ] **Step 1: Write the failing render tests**

Add tests similar to:

```python
import pytest

from vpn_automation.pipeline.render import MAIN_DATA_PLACEHOLDER, replace_main_data


def test_replace_main_data_replaces_only_placeholder() -> None:
    template = "const MainData = `__MAIN_DATA__`;\nconst footer = 'keep';"

    rendered = replace_main_data(template, ["vmess://a", "vmess://b"])

    assert rendered == "const MainData = `vmess://a\nvmess://b`;\nconst footer = 'keep';"
    assert MAIN_DATA_PLACEHOLDER not in rendered


def test_replace_main_data_requires_single_placeholder() -> None:
    with pytest.raises(RuntimeError, match="exactly one MainData placeholder"):
        replace_main_data("const MainData = ``;", ["vmess://a"])
```

- [ ] **Step 2: Run red test**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/pipeline/test_render.py
```

Expected: FAIL because `replace_main_data()` still uses regex replacement and does not expose the placeholder contract.

- [ ] **Step 3: Write the minimal implementation**

Implement the strict renderer:

```python
MAIN_DATA_PLACEHOLDER = "__MAIN_DATA__"


def replace_main_data(template: str, links: list[str]) -> str:
    occurrences = template.count(MAIN_DATA_PLACEHOLDER)
    if occurrences != 1:
        raise RuntimeError("Template must contain exactly one MainData placeholder")
    return template.replace(MAIN_DATA_PLACEHOLDER, "\n".join(links), 1)
```

Replace the template file with the reference worker structure and embed ``const MainData = `__MAIN_DATA__`;``.

- [ ] **Step 4: Run green test**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/pipeline/test_render.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/pipeline/test_render.py templates/vmess_node.js src/vpn_automation/pipeline/render.py
git commit -m "feat: lock vmess render to main data placeholder"
```

---

### Task 2: Align obfuscator flags with the sibling workflow

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/integrations/test_node_tools.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/integrations/node_tools.py`

- [ ] **Step 1: Write the failing command-shape test**

Extend the test with explicit flag assertions:

```python
def test_build_obfuscate_command_matches_reference_workflow() -> None:
    command = build_obfuscate_command(Path("/tmp/input.js"), Path("/tmp/output.js"))

    assert command[:3] == ["npx", "javascript-obfuscator", "/tmp/input.js"]
    assert command[command.index("--compact") + 1] == "true"
    assert command[command.index("--control-flow-flattening-threshold") + 1] == "1"
    assert command[command.index("--dead-code-injection-threshold") + 1] == "1"
    assert command[command.index("--identifier-names-generator") + 1] == "hexadecimal"
    assert command[command.index("--string-array-encoding") + 1] == "rc4"
    assert command[command.index("--unicode-escape-sequence") + 1] == "true"
```

- [ ] **Step 2: Run red test**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/integrations/test_node_tools.py
```

Expected: FAIL if any argument ordering or value drifts from the expected workflow profile.

- [ ] **Step 3: Write the minimal implementation**

Keep `build_obfuscate_command()` as a flat list, but order and value every flag exactly like the sibling workflow:

```python
[
    "npx",
    "javascript-obfuscator",
    str(input_path),
    "--output",
    str(output_path),
    "--compact",
    "true",
    "--control-flow-flattening",
    "true",
    "--control-flow-flattening-threshold",
    "1",
    "--dead-code-injection",
    "true",
    "--dead-code-injection-threshold",
    "1",
    "--identifier-names-generator",
    "hexadecimal",
    "--rename-globals",
    "true",
    "--string-array",
    "true",
    "--string-array-encoding",
    "rc4",
    "--string-array-threshold",
    "1",
    "--transform-object-keys",
    "true",
    "--unicode-escape-sequence",
    "true",
]
```

- [ ] **Step 4: Run green test**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/integrations/test_node_tools.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integrations/test_node_tools.py src/vpn_automation/integrations/node_tools.py
git commit -m "fix: align vmess obfuscator flags with reference workflow"
```

---

### Task 3: Switch default Pages target to `vms-nodes`

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/integrations/test_cloudflare.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_backend_cli.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/runtime/default-profile.toml`

- [ ] **Step 1: Write the failing default-value tests**

Update existing assertions to the new target and add a default-profile assertion if missing:

```python
def test_ensure_profile_json_bootstraps_missing_profile(tmp_path: Path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    payload = json.loads(ensure_profile_json(project_root))
    assert payload["deploy"]["project_name"] == "vms-nodes"


def test_build_secret_url_uses_pages_project_url_and_query() -> None:
    deploy = DeployConfig(
        project_name="vms-nodes",
        subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
        pages_project_url="https://vms-nodes.pages.dev",
        secret_query="serect_key=swimmingliu",
    )
    assert build_secret_url(deploy) == "https://vms-nodes.pages.dev/?serect_key=swimmingliu"
```

- [ ] **Step 2: Run red tests**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/integrations/test_cloudflare.py tests/backend/test_backend_cli.py tests/config/test_runtime_paths.py
```

Expected: FAIL because defaults still reference `vmessnodes` and `vmess2clash.pages.dev`.

- [ ] **Step 3: Write the minimal implementation**

Change the defaults in `DeployConfig`, `create_default_profile()`, and `electron/runtime/default-profile.toml`:

```python
pages_project_url: str = "https://vms-nodes.pages.dev"
...
deploy=DeployConfig(
    project_name="vms-nodes",
    subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
)
```

And in TOML:

```toml
[deploy]
project_name = "vms-nodes"
pages_project_url = "https://vms-nodes.pages.dev"
```

- [ ] **Step 4: Run green tests**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest tests/integrations/test_cloudflare.py tests/backend/test_backend_cli.py tests/config/test_runtime_paths.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/integrations/test_cloudflare.py tests/backend/test_backend_cli.py tests/config/test_runtime_paths.py src/vpn_automation/config/models.py electron/runtime/default-profile.toml
git commit -m "feat: retarget default pages deploy to vms-nodes"
```

---

### Task 4: Run integrated verification for the pipeline slice

**Files:**
- Verify only: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_controller.py`
- Verify only: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/e2e/test_controller_e2e.py`

- [ ] **Step 1: Run the focused Python verification suite**

Run:

```bash
PYTHONPATH=src /Users/swimmingliu/data/VPN/vpn-subscription-automation/.venv/bin/pytest \
  tests/pipeline/test_render.py \
  tests/integrations/test_node_tools.py \
  tests/integrations/test_cloudflare.py \
  tests/backend/test_backend_cli.py \
  tests/config/test_runtime_paths.py \
  tests/pipeline/test_controller.py \
  tests/e2e/test_controller_e2e.py
```

Expected: PASS.

- [ ] **Step 2: Run any required frontend or visual checks if renderer-facing files changed**

Run only if Electron UI files changed:

```bash
npm test
npx playwright test
```

Expected: PASS or not needed for this backend/template-only change.

- [ ] **Step 3: Commit the verification-only state if additional fixes were required**

```bash
git add -A
git commit -m "test: verify vmess template deploy flow"
```

