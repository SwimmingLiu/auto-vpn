import os
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "autovpn.sh"


def _make_fake_repo(tmp_path: Path) -> tuple[Path, Path]:
    repo_root = tmp_path / "repo"
    script_dir = repo_root / "scripts"
    bin_dir = repo_root / ".venv" / "bin"
    script_dir.mkdir(parents=True)
    bin_dir.mkdir(parents=True)

    script_copy = script_dir / "autovpn.sh"
    script_copy.write_text(SCRIPT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    script_copy.chmod(0o755)

    fake_autovpn = bin_dir / "autovpn"
    fake_autovpn.write_text(
        "#!/usr/bin/env bash\n"
        "printf 'cwd=%s\\n' \"$PWD\"\n"
        "printf 'path_has_local=%s\\n' \"$([[ \":$PATH:\" == *\":$HOME/.local/bin:\"* ]] && printf yes || printf no)\"\n"
        "printf 'args='\n"
        "printf '<%s>' \"$@\"\n"
        "printf '\\n'\n",
        encoding="utf-8",
    )
    fake_autovpn.chmod(0o755)
    return repo_root, script_copy


def test_autovpn_script_injects_environment_and_project_root(tmp_path: Path) -> None:
    repo_root, script_path = _make_fake_repo(tmp_path)

    result = subprocess.run(
        [str(script_path), "doctor", "--output", "json"],
        env={**os.environ, "HOME": str(tmp_path / "home")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"cwd={repo_root}" in result.stdout
    assert "path_has_local=yes" in result.stdout
    assert f"args=<doctor><--output><json><--project-root><{repo_root}>" in result.stdout


def test_autovpn_script_preserves_explicit_project_root(tmp_path: Path) -> None:
    repo_root, script_path = _make_fake_repo(tmp_path)
    explicit_root = tmp_path / "explicit"

    result = subprocess.run(
        [str(script_path), "status", "--project-root", str(explicit_root), "--json"],
        env={**os.environ, "HOME": str(tmp_path / "home")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert f"cwd={repo_root}" in result.stdout
    assert f"args=<status><--project-root><{explicit_root}><--json>" in result.stdout


def test_autovpn_script_reports_missing_local_cli(tmp_path: Path) -> None:
    repo_root = tmp_path / "repo"
    script_dir = repo_root / "scripts"
    script_dir.mkdir(parents=True)
    script_path = script_dir / "autovpn.sh"
    script_path.write_text(SCRIPT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    script_path.chmod(0o755)

    result = subprocess.run(
        [str(script_path), "doctor"],
        env={**os.environ, "HOME": str(tmp_path / "home")},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 127
    assert ".venv/bin/autovpn" in result.stderr
