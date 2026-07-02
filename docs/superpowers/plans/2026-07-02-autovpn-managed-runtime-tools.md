# AutoVPN Managed Runtime Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AutoVPN preflight, auto-install, verify, and use managed npm runtime tools from an AutoVPN user-level directory so obfuscate/deploy cannot hang on npm prompts.

**Architecture:** Add focused resolver modules for managed npm tools in Python and Node. The resolver owns user-level installation, verification, and fallback metadata; pipeline code receives absolute executable paths and never calls bare `npx javascript-obfuscator` or `npx wrangler`. Doctor/preflight reports managed tool status and fails early for unmanaged system dependencies.

**Tech Stack:** Python 3.12, pytest, Node.js/TypeScript, node:test, npm CLI, Cloudflare Wrangler, javascript-obfuscator.

---

## File Structure

- Create `src/vpn_automation/integrations/managed_tools.py`: Python managed npm tool resolver, installer, verifier, and safe error helpers.
- Modify `src/vpn_automation/integrations/node_tools.py`: use the Python resolver for `javascript-obfuscator`.
- Modify `src/vpn_automation/integrations/cloudflare.py`: use the Python resolver for Wrangler deploy commands.
- Modify `src/vpn_automation/doctor.py`: report managed npm tool status and install/verify when needed.
- Create `tests/integrations/test_managed_tools.py`: unit tests for resolver/install/verification behavior.
- Modify `tests/integrations/test_node_tools.py`: assert obfuscator command uses resolved absolute executable while preserving flags.
- Modify `tests/integrations/test_cloudflare.py`: assert deploy command uses resolved Wrangler executable.
- Modify `tests/backend/test_doctor_cli.py`: assert doctor reports managed tool states.
- Create `npm/autovpn-cli/src/runtime/managed-tools.ts`: Node managed npm tool resolver for Node-native deploy and doctor.
- Modify `npm/autovpn-cli/src/pipeline/deploy.ts`: use resolved Wrangler executable instead of `npx wrangler`.
- Modify `npm/autovpn-cli/src/doctor/checks.ts`: use managed resolver for `javascript-obfuscator` and `wrangler` checks.
- Create `npm/autovpn-cli/test/runtime/managed-tools.test.mjs`: Node resolver tests.
- Modify `npm/autovpn-cli/test/pipeline/deploy.test.mjs`: deploy command/resolver coverage.
- Update `docs/headless-agent/linux-headless-guide.md`: explain managed npm tools and unmanaged system dependency handling.

---

### Task 1: Python Managed Tool Resolver

**Files:**
- Create: `src/vpn_automation/integrations/managed_tools.py`
- Test: `tests/integrations/test_managed_tools.py`

- [ ] **Step 1: Write failing tests for existing managed install, project fallback, and install failure**

Add `tests/integrations/test_managed_tools.py`:

```python
import os
from pathlib import Path

import pytest

from vpn_automation.integrations.managed_tools import (
    ManagedToolError,
    ManagedToolSpec,
    resolve_managed_npm_tool,
)


def _fake_bin(path: Path, name: str) -> Path:
    bin_dir = path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    exe = bin_dir / name
    exe.write_text("#!/bin/sh\nprintf 'ok\\n'\n", encoding="utf-8")
    exe.chmod(0o755)
    return exe


def test_resolve_uses_existing_user_managed_tool(tmp_path: Path) -> None:
    tool_root = tmp_path / "tools"
    exe = _fake_bin(tool_root / "npm" / "javascript-obfuscator" / "5.4.3", "javascript-obfuscator")

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(package="javascript-obfuscator", binary="javascript-obfuscator", version="5.4.3"),
        tools_root=tool_root,
        project_root=tmp_path / "project",
        install_missing=False,
        runner=lambda command, cwd=None, env=None, timeout_seconds=0: (0, "5.4.3", ""),
    )

    assert resolved.executable == exe
    assert resolved.source == "managed"
    assert resolved.version == "5.4.3"


def test_resolve_allows_project_fallback_for_development(tmp_path: Path) -> None:
    project_root = tmp_path / "project"
    exe = _fake_bin(project_root, "wrangler")

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
        tools_root=tmp_path / "tools",
        project_root=project_root,
        install_missing=False,
        allow_project_fallback=True,
        runner=lambda command, cwd=None, env=None, timeout_seconds=0: (0, "4.106.0", ""),
    )

    assert resolved.executable == exe
    assert resolved.source == "project"


def test_resolve_installs_missing_tool_into_user_tool_dir(tmp_path: Path) -> None:
    tool_root = tmp_path / "tools"
    calls: list[tuple[list[str], Path | None]] = []

    def runner(command, cwd=None, env=None, timeout_seconds=0):
        calls.append((command, cwd))
        if command[:2] == ["npm", "install"]:
            assert cwd == tool_root / "npm" / "wrangler" / "4.106.0"
            _fake_bin(cwd, "wrangler")
            return (0, "installed", "")
        return (0, "4.106.0", "")

    resolved = resolve_managed_npm_tool(
        ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
        tools_root=tool_root,
        project_root=tmp_path / "project",
        install_missing=True,
        runner=runner,
    )

    assert resolved.source == "managed"
    assert resolved.executable.exists()
    assert any(command[:2] == ["npm", "install"] for command, _cwd in calls)


def test_resolve_reports_install_failure_without_prompting(tmp_path: Path) -> None:
    def runner(command, cwd=None, env=None, timeout_seconds=0):
        return (1, "", "network unavailable")

    with pytest.raises(ManagedToolError, match="Failed to install wrangler"):
        resolve_managed_npm_tool(
            ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0"),
            tools_root=tmp_path / "tools",
            project_root=tmp_path / "project",
            install_missing=True,
            runner=runner,
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./scripts/run_pytest.sh tests/integrations/test_managed_tools.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'vpn_automation.integrations.managed_tools'`.

- [ ] **Step 3: Implement Python resolver**

Create `src/vpn_automation/integrations/managed_tools.py`:

```python
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from vpn_automation.config.runtime import resolve_user_runtime_root
from vpn_automation.integrations.commands import build_command_env


Runner = Callable[[list[str], Path | None, dict[str, str] | None, int], tuple[int, str, str]]


@dataclass(frozen=True)
class ManagedToolSpec:
    package: str
    binary: str
    version: str


@dataclass(frozen=True)
class ResolvedManagedTool:
    executable: Path
    source: str
    version: str
    install_dir: Path


class ManagedToolError(RuntimeError):
    pass


def default_tools_root() -> Path:
    return resolve_user_runtime_root() / "tools"


def _truncate(value: str, limit: int = 1200) -> str:
    normalized = value.strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[:limit] + "...<truncated>"


def _default_runner(command: list[str], cwd: Path | None, env: dict[str, str] | None, timeout_seconds: int) -> tuple[int, str, str]:
    completed = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        env=build_command_env(env),
        text=True,
        capture_output=True,
        check=False,
        timeout=timeout_seconds or None,
    )
    return completed.returncode, completed.stdout, completed.stderr


def _bin_path(install_dir: Path, binary: str) -> Path:
    suffix = ".cmd" if os.name == "nt" else ""
    return install_dir / "node_modules" / ".bin" / f"{binary}{suffix}"


def _verify(executable: Path, runner: Runner, timeout_seconds: int) -> str:
    code, stdout, stderr = runner([str(executable), "--version"], None, None, timeout_seconds)
    if code != 0:
        raise ManagedToolError(f"Managed tool verification failed for {executable}: {_truncate(stderr or stdout)}")
    return (stdout or stderr).strip().splitlines()[0] if (stdout or stderr).strip() else ""


def resolve_managed_npm_tool(
    spec: ManagedToolSpec,
    *,
    tools_root: Path | None = None,
    project_root: Path | None = None,
    install_missing: bool = True,
    allow_project_fallback: bool = True,
    runner: Runner = _default_runner,
    timeout_seconds: int = 120,
) -> ResolvedManagedTool:
    root = tools_root or default_tools_root()
    install_dir = root / "npm" / spec.package / spec.version
    managed_exe = _bin_path(install_dir, spec.binary)
    if managed_exe.exists():
        version = _verify(managed_exe, runner, timeout_seconds)
        return ResolvedManagedTool(managed_exe, "managed", version, install_dir)

    if install_missing:
        npm = shutil.which("npm")
        if not npm:
            raise ManagedToolError(f"npm is required to install {spec.package} but was not found")
        install_dir.mkdir(parents=True, exist_ok=True)
        package_spec = f"{spec.package}@{spec.version}"
        env = {"NPM_CONFIG_YES": "true", "npm_config_yes": "true"}
        code, stdout, stderr = runner([npm, "install", "--no-save", "--no-audit", "--no-fund", package_spec], install_dir, env, timeout_seconds)
        if code != 0:
            raise ManagedToolError(f"Failed to install {spec.package} into {install_dir}: {_truncate(stderr or stdout)}")
        if not managed_exe.exists():
            raise ManagedToolError(f"Installed {spec.package} but executable {managed_exe} was not created")
        version = _verify(managed_exe, runner, timeout_seconds)
        return ResolvedManagedTool(managed_exe, "managed", version, install_dir)

    if allow_project_fallback and project_root:
        project_exe = _bin_path(project_root, spec.binary)
        if project_exe.exists():
            version = _verify(project_exe, runner, timeout_seconds)
            return ResolvedManagedTool(project_exe, "project", version, project_root)

    raise ManagedToolError(f"{spec.package} is not available")
```

- [ ] **Step 4: Run resolver tests**

Run: `./scripts/run_pytest.sh tests/integrations/test_managed_tools.py -v`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/vpn_automation/integrations/managed_tools.py tests/integrations/test_managed_tools.py
git commit -m "feat: add managed runtime tool resolver"
```

---

### Task 2: Python Obfuscator Uses Managed Executable

**Files:**
- Modify: `src/vpn_automation/integrations/node_tools.py`
- Modify: `tests/integrations/test_node_tools.py`

- [ ] **Step 1: Update failing test for absolute obfuscator executable**

Replace `tests/integrations/test_node_tools.py` with:

```python
from pathlib import Path

from vpn_automation.integrations.node_tools import build_obfuscate_command


def test_build_obfuscate_command_targets_expected_output() -> None:
    command = build_obfuscate_command(
        Path("/tmp/input.js"),
        Path("/tmp/output.js"),
        obfuscator_executable=Path("/home/user/.auto-vpn/tools/npm/javascript-obfuscator/5.4.3/node_modules/.bin/javascript-obfuscator"),
    )

    assert command[:2] == [
        "/home/user/.auto-vpn/tools/npm/javascript-obfuscator/5.4.3/node_modules/.bin/javascript-obfuscator",
        "/tmp/input.js",
    ]
    assert "--output" in command
    assert "/tmp/output.js" in command
    assert command[command.index("--compact") + 1] == "true"
    assert command[command.index("--control-flow-flattening") + 1] == "true"
    assert command[command.index("--control-flow-flattening-threshold") + 1] == "1"
    assert command[command.index("--dead-code-injection") + 1] == "true"
    assert command[command.index("--dead-code-injection-threshold") + 1] == "1"
    assert command[command.index("--identifier-names-generator") + 1] == "hexadecimal"
    assert command[command.index("--rename-globals") + 1] == "true"
    assert command[command.index("--string-array") + 1] == "true"
    assert command[command.index("--string-array-encoding") + 1] == "rc4"
    assert command[command.index("--string-array-threshold") + 1] == "1"
    assert command[command.index("--transform-object-keys") + 1] == "true"
    assert command[command.index("--unicode-escape-sequence") + 1] == "true"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/run_pytest.sh tests/integrations/test_node_tools.py -v`

Expected: FAIL with unexpected `obfuscator_executable` argument.

- [ ] **Step 3: Implement managed obfuscator command**

Modify `src/vpn_automation/integrations/node_tools.py`:

```python
from pathlib import Path

from vpn_automation.integrations.commands import run_command
from vpn_automation.integrations.managed_tools import ManagedToolSpec, resolve_managed_npm_tool


JAVASCRIPT_OBFUSCATOR = ManagedToolSpec(
    package="javascript-obfuscator",
    binary="javascript-obfuscator",
    version="5.4.3",
)


def build_obfuscate_command(
    input_path: Path,
    output_path: Path,
    *,
    obfuscator_executable: Path | None = None,
) -> list[str]:
    executable = obfuscator_executable
    if executable is None:
        executable = resolve_managed_npm_tool(JAVASCRIPT_OBFUSCATOR, project_root=Path.cwd()).executable
    return [
        str(executable),
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


def obfuscate_javascript(input_path: Path, output_path: Path) -> dict[str, str | int]:
    result = run_command(build_obfuscate_command(input_path, output_path), cwd=str(input_path.parent))
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)
    return {
        "stdout": result.stdout,
        "stderr": result.stderr,
        "returncode": result.returncode,
    }
```

- [ ] **Step 4: Run Python integration tests**

Run: `./scripts/run_pytest.sh tests/integrations/test_node_tools.py tests/integrations/test_managed_tools.py -v`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/vpn_automation/integrations/node_tools.py tests/integrations/test_node_tools.py
git commit -m "fix: use managed obfuscator executable"
```

---

### Task 3: Python Wrangler Uses Managed Executable

**Files:**
- Modify: `src/vpn_automation/integrations/cloudflare.py`
- Modify: `tests/integrations/test_cloudflare.py`

- [ ] **Step 1: Add failing Cloudflare command test**

Append to `tests/integrations/test_cloudflare.py`:

```python
def test_build_pages_deploy_command_uses_resolved_wrangler() -> None:
    command = build_pages_deploy_command(
        Path("/tmp/pages_bundle"),
        "sub-nodes",
        wrangler_executable=Path("/home/user/.auto-vpn/tools/npm/wrangler/4.106.0/node_modules/.bin/wrangler"),
    )

    assert command[:4] == [
        "/home/user/.auto-vpn/tools/npm/wrangler/4.106.0/node_modules/.bin/wrangler",
        "pages",
        "deploy",
        "/tmp/pages_bundle",
    ]
    assert "--project-name" in command
    assert "sub-nodes" in command
```

Ensure the file imports `build_pages_deploy_command` if it does not already.

- [ ] **Step 2: Run test to verify it fails**

Run: `./scripts/run_pytest.sh tests/integrations/test_cloudflare.py::test_build_pages_deploy_command_uses_resolved_wrangler -v`

Expected: FAIL with unexpected `wrangler_executable` argument.

- [ ] **Step 3: Modify Cloudflare command builder**

Modify the top of `src/vpn_automation/integrations/cloudflare.py` to import resolver pieces:

```python
from vpn_automation.integrations.managed_tools import ManagedToolSpec, resolve_managed_npm_tool
```

Add near constants:

```python
WRANGLER = ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0")
```

Replace `build_pages_deploy_command`:

```python
def build_pages_deploy_command(
    bundle_dir: Path,
    project_name: str,
    *,
    wrangler_executable: Path | None = None,
) -> list[str]:
    executable = wrangler_executable
    if executable is None:
        executable = resolve_managed_npm_tool(WRANGLER, project_root=resolve_repo_anchor()).executable
    return [
        str(executable),
        "pages",
        "deploy",
        str(bundle_dir),
        "--project-name",
        project_name,
        "--branch",
        PAGES_PRODUCTION_BRANCH,
    ]
```

- [ ] **Step 4: Run Cloudflare tests**

Run: `./scripts/run_pytest.sh tests/integrations/test_cloudflare.py -v`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/vpn_automation/integrations/cloudflare.py tests/integrations/test_cloudflare.py
git commit -m "fix: use managed wrangler executable"
```

---

### Task 4: Python Doctor Reports Managed Runtime Tools

**Files:**
- Modify: `src/vpn_automation/doctor.py`
- Modify: `tests/backend/test_doctor_cli.py`

- [ ] **Step 1: Add failing doctor tests for managed tool status**

Add tests in `tests/backend/test_doctor_cli.py` that monkeypatch resolver calls:

```python
def test_doctor_reports_managed_obfuscator(monkeypatch, tmp_path):
    from vpn_automation.integrations.managed_tools import ResolvedManagedTool

    def fake_resolve(spec, **kwargs):
        return ResolvedManagedTool(tmp_path / spec.binary, "managed", spec.version, tmp_path)

    monkeypatch.setattr("vpn_automation.doctor.resolve_managed_npm_tool", fake_resolve)
    payload = run_doctor_json(tmp_path)
    checks = {item["name"]: item for item in payload["checks"]}

    assert checks["javascript_obfuscator"]["status"] == "pass"
    assert checks["javascript_obfuscator"]["source"] == "managed"


def test_doctor_reports_wrangler_when_deploy_required(monkeypatch, tmp_path):
    from vpn_automation.integrations.managed_tools import ResolvedManagedTool

    def fake_resolve(spec, **kwargs):
        return ResolvedManagedTool(tmp_path / spec.binary, "managed", spec.version, tmp_path)

    monkeypatch.setattr("vpn_automation.doctor.resolve_managed_npm_tool", fake_resolve)
    payload = run_doctor_json(tmp_path, deploy=True)
    checks = {item["name"]: item for item in payload["checks"]}

    assert checks["wrangler"]["status"] in {"pass", "fail", "warn"}
    assert "source" in checks["wrangler"] or checks["wrangler"]["status"] != "pass"
```

Use the helper names already present in `tests/backend/test_doctor_cli.py`; if they differ, adapt the call sites to the existing helpers rather than adding duplicate CLI runners.

- [ ] **Step 2: Run doctor tests to verify failure**

Run: `./scripts/run_pytest.sh tests/backend/test_doctor_cli.py -v`

Expected: FAIL because doctor does not import/use `resolve_managed_npm_tool`.

- [ ] **Step 3: Update doctor checks**

Modify `src/vpn_automation/doctor.py`:

```python
from vpn_automation.integrations.managed_tools import (
    ManagedToolError,
    ManagedToolSpec,
    resolve_managed_npm_tool,
)
```

Add specs:

```python
JAVASCRIPT_OBFUSCATOR = ManagedToolSpec("javascript-obfuscator", "javascript-obfuscator", "5.4.3")
WRANGLER = ManagedToolSpec("wrangler", "wrangler", "4.106.0")
```

Replace the `npx javascript-obfuscator --version` check in `_check_node_tools` with:

```python
    try:
        resolved = resolve_managed_npm_tool(JAVASCRIPT_OBFUSCATOR, project_root=project_root)
        checks.append(
            _check(
                "javascript_obfuscator",
                "pass",
                "javascript-obfuscator is available",
                source=resolved.source,
                version=resolved.version,
                path=str(resolved.executable),
            )
        )
    except ManagedToolError as exc:
        checks.append(_check("javascript_obfuscator", "fail", str(exc)))
```

Replace the Wrangler `npx` check in `_check_cloudflare` with:

```python
    try:
        resolved = resolve_managed_npm_tool(WRANGLER, project_root=resolve_repo_anchor())
        checks.append(
            _check(
                "wrangler",
                "pass",
                "Wrangler is available",
                source=resolved.source,
                version=resolved.version,
                path=str(resolved.executable),
                deploy_required=deploy,
            )
        )
    except ManagedToolError as exc:
        checks.append(_check("wrangler", "fail" if deploy else "warn", str(exc), deploy_required=deploy))
```

- [ ] **Step 4: Run doctor tests**

Run: `./scripts/run_pytest.sh tests/backend/test_doctor_cli.py -v`

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/vpn_automation/doctor.py tests/backend/test_doctor_cli.py
git commit -m "feat: report managed runtime tools in doctor"
```

---

### Task 5: Node Managed Tool Resolver

**Files:**
- Create: `npm/autovpn-cli/src/runtime/managed-tools.ts`
- Create: `npm/autovpn-cli/test/runtime/managed-tools.test.mjs`

- [ ] **Step 1: Write failing Node resolver tests**

Create `npm/autovpn-cli/test/runtime/managed-tools.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveManagedNpmTool } from '../../dist/runtime/managed-tools.js';

function fakeBin(root, name) {
  const binDir = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  const exe = path.join(binDir, name);
  fs.writeFileSync(exe, '#!/bin/sh\nprintf "ok\\n"\n');
  fs.chmodSync(exe, 0o755);
  return exe;
}

test('resolveManagedNpmTool uses existing managed install', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-tool-'));
  const toolsRoot = path.join(tmp, 'tools');
  const exe = fakeBin(path.join(toolsRoot, 'npm', 'wrangler', '4.106.0'), 'wrangler');

  const resolved = await resolveManagedNpmTool({
    packageName: 'wrangler',
    binaryName: 'wrangler',
    version: '4.106.0',
    toolsRoot,
    projectRoot: path.join(tmp, 'project'),
    installMissing: false,
    runCommand: async () => ({ returncode: 0, stdout: '4.106.0\n', stderr: '' })
  });

  assert.equal(resolved.executable, exe);
  assert.equal(resolved.source, 'managed');
});

test('resolveManagedNpmTool installs missing tool non-interactively', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autovpn-tool-'));
  const toolsRoot = path.join(tmp, 'tools');
  const calls = [];

  const resolved = await resolveManagedNpmTool({
    packageName: 'javascript-obfuscator',
    binaryName: 'javascript-obfuscator',
    version: '5.4.3',
    toolsRoot,
    projectRoot: path.join(tmp, 'project'),
    installMissing: true,
    runCommand: async (command, options) => {
      calls.push({ command, options });
      if (command[0] === 'npm' && command[1] === 'install') {
        fakeBin(path.join(toolsRoot, 'npm', 'javascript-obfuscator', '5.4.3'), 'javascript-obfuscator');
        return { returncode: 0, stdout: 'installed', stderr: '' };
      }
      return { returncode: 0, stdout: '5.4.3\n', stderr: '' };
    }
  });

  assert.equal(resolved.source, 'managed');
  assert.ok(calls.some((call) => call.command.includes('javascript-obfuscator@5.4.3')));
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm test --prefix npm/autovpn-cli -- runtime/managed-tools.test.mjs`

Expected: FAIL because `dist/runtime/managed-tools.js` does not exist.

- [ ] **Step 3: Implement Node resolver**

Create `npm/autovpn-cli/src/runtime/managed-tools.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface ManagedNpmToolOptions {
  packageName: string;
  binaryName: string;
  version: string;
  toolsRoot?: string;
  projectRoot?: string;
  installMissing?: boolean;
  allowProjectFallback?: boolean;
  runCommand?: (command: string[], options: { cwd?: string; env?: Record<string, string> }) => Promise<{ returncode: number; stdout: string; stderr: string }>;
}

export interface ResolvedManagedTool {
  executable: string;
  source: 'managed' | 'project';
  version: string;
  installDir: string;
}

export class ManagedToolError extends Error {}

export function defaultToolsRoot(): string {
  return path.join(os.homedir(), '.auto-vpn', 'tools');
}

function executablePath(installDir: string, binaryName: string): string {
  return path.join(installDir, 'node_modules', '.bin', process.platform === 'win32' ? `${binaryName}.cmd` : binaryName);
}

function truncate(value: string, limit = 1200): string {
  const normalized = value.trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}...<truncated>`;
}

async function defaultRunCommand(command: string[], options: { cwd?: string; env?: Record<string, string> }): Promise<{ returncode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => resolve({ returncode: code ?? 1, stdout, stderr }));
  });
}

async function verify(executable: string, runCommand: NonNullable<ManagedNpmToolOptions['runCommand']>): Promise<string> {
  const result = await runCommand([executable, '--version'], {});
  if (result.returncode !== 0) {
    throw new ManagedToolError(`Managed tool verification failed for ${executable}: ${truncate(result.stderr || result.stdout)}`);
  }
  return (result.stdout || result.stderr).trim().split(/\r?\n/)[0] ?? '';
}

export async function resolveManagedNpmTool(options: ManagedNpmToolOptions): Promise<ResolvedManagedTool> {
  const toolsRoot = options.toolsRoot ?? defaultToolsRoot();
  const installDir = path.join(toolsRoot, 'npm', options.packageName, options.version);
  const managedExecutable = executablePath(installDir, options.binaryName);
  const runCommand = options.runCommand ?? defaultRunCommand;

  if (fs.existsSync(managedExecutable)) {
    const version = await verify(managedExecutable, runCommand);
    return { executable: managedExecutable, source: 'managed', version, installDir };
  }

  if (options.installMissing ?? true) {
    fs.mkdirSync(installDir, { recursive: true });
    const result = await runCommand(['npm', 'install', '--no-save', '--no-audit', '--no-fund', `${options.packageName}@${options.version}`], {
      cwd: installDir,
      env: { NPM_CONFIG_YES: 'true', npm_config_yes: 'true' }
    });
    if (result.returncode !== 0) {
      throw new ManagedToolError(`Failed to install ${options.packageName} into ${installDir}: ${truncate(result.stderr || result.stdout)}`);
    }
    if (!fs.existsSync(managedExecutable)) {
      throw new ManagedToolError(`Installed ${options.packageName} but executable ${managedExecutable} was not created`);
    }
    const version = await verify(managedExecutable, runCommand);
    return { executable: managedExecutable, source: 'managed', version, installDir };
  }

  if ((options.allowProjectFallback ?? true) && options.projectRoot) {
    const projectExecutable = executablePath(options.projectRoot, options.binaryName);
    if (fs.existsSync(projectExecutable)) {
      const version = await verify(projectExecutable, runCommand);
      return { executable: projectExecutable, source: 'project', version, installDir: options.projectRoot };
    }
  }

  throw new ManagedToolError(`${options.packageName} is not available`);
}
```

- [ ] **Step 4: Build and run Node resolver tests**

Run: `npm test --prefix npm/autovpn-cli -- runtime/managed-tools.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add npm/autovpn-cli/src/runtime/managed-tools.ts npm/autovpn-cli/test/runtime/managed-tools.test.mjs
git commit -m "feat: add node managed runtime tool resolver"
```

---

### Task 6: Node Deploy And Doctor Use Managed Wrangler

**Files:**
- Modify: `npm/autovpn-cli/src/pipeline/deploy.ts`
- Modify: `npm/autovpn-cli/src/doctor/checks.ts`
- Modify: `npm/autovpn-cli/test/pipeline/deploy.test.mjs`

- [ ] **Step 1: Add failing deploy command test**

In `npm/autovpn-cli/test/pipeline/deploy.test.mjs`, add:

```javascript
test('buildPagesDeployCommand accepts resolved wrangler executable', () => {
  const command = buildPagesDeployCommand('/tmp/pages_bundle', 'sub-nodes', '/home/user/.auto-vpn/tools/npm/wrangler/4.106.0/node_modules/.bin/wrangler');
  assert.deepEqual(command.slice(0, 4), [
    '/home/user/.auto-vpn/tools/npm/wrangler/4.106.0/node_modules/.bin/wrangler',
    'pages',
    'deploy',
    '/tmp/pages_bundle'
  ]);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm test --prefix npm/autovpn-cli -- pipeline/deploy.test.mjs`

Expected: FAIL because `buildPagesDeployCommand` does not accept a Wrangler executable.

- [ ] **Step 3: Modify Node deploy command builder**

In `npm/autovpn-cli/src/pipeline/deploy.ts`, import:

```typescript
import { resolveManagedNpmTool } from '../runtime/managed-tools.js';
```

Replace command builder:

```typescript
export function buildPagesDeployCommand(bundleDir: string, projectName: string, wranglerExecutable = 'wrangler'): string[] {
  return [wranglerExecutable, 'pages', 'deploy', bundleDir, '--project-name', projectName, '--branch', PAGES_PRODUCTION_BRANCH];
}
```

At the call site that runs deploy, resolve first:

```typescript
const wrangler = await resolveManagedNpmTool({
  packageName: 'wrangler',
  binaryName: 'wrangler',
  version: '4.106.0',
  projectRoot: input.projectRoot
});
const command = buildPagesDeployCommand(input.bundleDir, projectName, wrangler.executable);
```

- [ ] **Step 4: Modify Node doctor checks**

In `npm/autovpn-cli/src/doctor/checks.ts`, import `resolveManagedNpmTool` and replace `npx javascript-obfuscator --version` / `npx wrangler pages deploy --help` checks with managed resolver calls. Preserve status naming:

```typescript
const obfuscator = await resolveManagedNpmTool({
  packageName: 'javascript-obfuscator',
  binaryName: 'javascript-obfuscator',
  version: '5.4.3',
  projectRoot
});
```

If `checkNodeTools` is currently synchronous, split the task into a small async conversion: make doctor command await the checks and update tests accordingly.

- [ ] **Step 5: Run Node tests**

Run: `npm test --prefix npm/autovpn-cli`

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add npm/autovpn-cli/src/pipeline/deploy.ts npm/autovpn-cli/src/doctor/checks.ts npm/autovpn-cli/test/pipeline/deploy.test.mjs
git commit -m "fix: use managed wrangler in node pipeline"
```

---

### Task 7: Documentation And Verification

**Files:**
- Modify: `docs/headless-agent/linux-headless-guide.md`
- Modify as needed: `README.md`

- [ ] **Step 1: Update dependency docs**

Replace text that tells users to run `npm ci` or `npx wrangler` for these managed npm tools with:

```markdown
AutoVPN manages npm runtime tools such as `javascript-obfuscator` and `wrangler` under `~/.auto-vpn/tools/npm/`. Doctor/preflight installs and verifies these tools before a run when Node.js and npm are available. AutoVPN does not silently install OS-level dependencies such as Node.js, npm, or Mihomo; doctor reports those as missing with installation guidance.
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
./scripts/run_pytest.sh tests/integrations/test_managed_tools.py tests/integrations/test_node_tools.py tests/integrations/test_cloudflare.py tests/backend/test_doctor_cli.py -v
npm test --prefix npm/autovpn-cli
```

Expected: PASS.

- [ ] **Step 3: Run behavior verification**

Use an existing artifact and retry from `obfuscate`:

```bash
autovpn retry-stage --project-root "$PWD" --artifact-dir /home/swimmingliu/.auto-vpn/artifacts/20260702-080556 --stage obfuscate --output human
```

Expected:

- no npm prompt
- `_worker.js` exists
- `pages_bundle/_worker.js` exists
- deploy/verify either succeed or fail with a clear non-interactive error

- [ ] **Step 4: Run full project tests required by AGENTS.md**

Run:

```bash
./scripts/run_pytest.sh tests -v
npm run test:electron
npm test --prefix npm/autovpn-cli
```

If no UI files changed, record that browser H5/manual/pixel verification is not applicable because this is runtime CLI behavior only. If any Electron UI file changed, run the required Playwright/browser/pixel checks before completion.

- [ ] **Step 5: Commit Task 7**

```bash
git add docs/headless-agent/linux-headless-guide.md README.md
git commit -m "docs: explain managed runtime tools"
```

---

## Self-Review Notes

- Spec coverage: managed npm tools, Wrangler, obfuscator, system dependencies, doctor/preflight reporting, non-interactive behavior, and tests are covered.
- Scope: this plan intentionally does not silently install OS-level dependencies such as Node.js, npm, or Mihomo.
- Risk: Node doctor checks may require async conversion; keep that change isolated in Task 6 and preserve existing JSON output shape.
