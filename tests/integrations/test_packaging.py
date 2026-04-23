from pathlib import Path
import json

from vpn_automation.integrations.packaging import build_electron_package_command


def test_build_electron_package_command_uses_npm_package_script() -> None:
    command = build_electron_package_command(Path("/tmp/project"))

    assert command == ["npm", "run", "package:electron"]


def test_package_manifest_ships_backend_runtime_files() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    package_json = json.loads((repo_root / "package.json").read_text(encoding="utf-8"))
    build = package_json["build"]

    assert package_json["scripts"]["package:electron"] == "node electron/build/package.mjs"
    assert "electron/**/*" in build["files"]
    assert "src/**/*" in build["files"]
    assert "pyproject.toml" in build["files"]
    assert build["asar"] is False
