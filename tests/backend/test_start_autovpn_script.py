import os
import subprocess
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = PROJECT_ROOT / "scripts" / "start_autovpn.sh"


def _make_fake_repo(tmp_path: Path, fake_cli: str) -> tuple[Path, Path, Path]:
    repo_root = tmp_path / "repo"
    script_dir = repo_root / "scripts"
    bin_dir = repo_root / ".venv" / "bin"
    logs_dir = tmp_path / "logs"
    script_dir.mkdir(parents=True)
    bin_dir.mkdir(parents=True)

    script_copy = script_dir / "start_autovpn.sh"
    script_copy.write_text(SCRIPT_PATH.read_text(encoding="utf-8"), encoding="utf-8")
    script_copy.chmod(0o755)

    fake_autovpn = bin_dir / "autovpn"
    fake_autovpn.write_text(fake_cli, encoding="utf-8")
    fake_autovpn.chmod(0o755)

    return repo_root, script_copy, logs_dir


def test_start_script_checks_then_runs_full_deploy_verify_by_default(tmp_path: Path) -> None:
    repo_root, script_path, logs_dir = _make_fake_repo(
        tmp_path,
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$AUTOVPN_FAKE_COMMAND_LOG\"\n"
        "case \"$1\" in\n"
        "  doctor) printf '{\"ok\":true,\"deploy\":false}\\n' ;;\n"
        "  profile) printf '{\"ok\":true,\"sources\":{},\"deploy\":{}}\\n' ;;\n"
        "  jobs) printf '{\"ok\":true,\"jobs\":[]}\\n' ;;\n"
        "  run) printf '{\"type\":\"stage\",\"stage\":\"extract\",\"status\":\"running\"}\\n' ;;\n"
        "  *) printf '{}\\n' ;;\n"
        "esac\n",
    )
    command_log = tmp_path / "commands.log"

    result = subprocess.run(
        [str(script_path), "--logs-dir", str(logs_dir), "--run-id", "run-001"],
        env={**os.environ, "AUTOVPN_FAKE_COMMAND_LOG": str(command_log)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    commands = command_log.read_text(encoding="utf-8").splitlines()
    assert commands == [
        f"doctor --project-root {repo_root} --output json",
        f"doctor --project-root {repo_root} --deploy --strict --output json",
        f"profile summary --project-root {repo_root} --json",
        f"jobs list --project-root {repo_root} --json",
        f"run --project-root {repo_root} --output jsonl",
    ]
    run_dir = logs_dir / "run-001"
    assert (run_dir / "doctor.json").exists()
    assert (run_dir / "profile-summary.json").exists()
    assert (run_dir / "jobs-before.json").exists()
    assert (run_dir / "run.jsonl").read_text(encoding="utf-8").strip().endswith('"running"}')
    assert "Run log:" in result.stdout


def test_start_script_default_mode_requires_strict_deploy_check(tmp_path: Path) -> None:
    repo_root, script_path, logs_dir = _make_fake_repo(
        tmp_path,
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$AUTOVPN_FAKE_COMMAND_LOG\"\n"
        "if [[ \"$1\" == \"doctor\" && \"$*\" == *\"--deploy --strict\"* ]]; then\n"
        "  printf '{\"ok\":false,\"deploy\":true}\\n'\n"
        "  exit 1\n"
        "fi\n"
        "printf '{\"ok\":true}\\n'\n",
    )
    command_log = tmp_path / "commands.log"

    result = subprocess.run(
        [str(script_path), "--logs-dir", str(logs_dir), "--run-id", "run-002"],
        env={**os.environ, "AUTOVPN_FAKE_COMMAND_LOG": str(command_log)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 1
    commands = command_log.read_text(encoding="utf-8").splitlines()
    assert commands == [
        f"doctor --project-root {repo_root} --output json",
        f"doctor --project-root {repo_root} --deploy --strict --output json",
    ]
    assert "Deploy preflight failed" in result.stderr
    assert not (logs_dir / "run-002" / "run.jsonl").exists()


def test_start_script_local_option_skips_deploy_and_verify(tmp_path: Path) -> None:
    repo_root, script_path, logs_dir = _make_fake_repo(
        tmp_path,
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$AUTOVPN_FAKE_COMMAND_LOG\"\n"
        "printf '{\"ok\":true}\\n'\n",
    )
    command_log = tmp_path / "commands.log"

    result = subprocess.run(
        [str(script_path), "--local", "--logs-dir", str(logs_dir), "--run-id", "run-003"],
        env={**os.environ, "AUTOVPN_FAKE_COMMAND_LOG": str(command_log)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    commands = command_log.read_text(encoding="utf-8").splitlines()
    assert commands == [
        f"doctor --project-root {repo_root} --output json",
        f"profile summary --project-root {repo_root} --json",
        f"jobs list --project-root {repo_root} --json",
        f"run --project-root {repo_root} --skip-deploy --skip-verify --output jsonl",
    ]


def test_start_script_forwards_proxy_only_when_requested(tmp_path: Path) -> None:
    repo_root, script_path, logs_dir = _make_fake_repo(
        tmp_path,
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$AUTOVPN_FAKE_COMMAND_LOG\"\n"
        "printf '{\"ok\":true}\\n'\n",
    )
    command_log = tmp_path / "commands.log"

    result = subprocess.run(
        [
            str(script_path),
            "--local",
            "--proxy",
            "http://127.0.0.1:7897",
            "--logs-dir",
            str(logs_dir),
            "--run-id",
            "run-004",
        ],
        env={**os.environ, "AUTOVPN_FAKE_COMMAND_LOG": str(command_log)},
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    commands = command_log.read_text(encoding="utf-8").splitlines()
    assert commands[-1] == (
        f"run --project-root {repo_root} --skip-deploy --skip-verify "
        "--proxy http://127.0.0.1:7897 --output jsonl"
    )
