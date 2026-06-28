from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def isolated_runtime_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    runtime_root = tmp_path / ".auto-vpn"
    monkeypatch.setenv("VPN_AUTOMATION_RUNTIME_ROOT", str(runtime_root))
    return runtime_root
