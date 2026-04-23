from pathlib import Path

from dotenv import dotenv_values

from vpn_automation.config.models import resolve_repo_anchor


def resolve_runtime_root(candidate: Path) -> Path:
    resolved = candidate.resolve()
    current = resolved if resolved.is_dir() else resolved.parent
    for path in [current, *current.parents]:
        if (path / "pyproject.toml").exists():
            return path
    return current


def resolve_env_file(candidate: Path) -> Path:
    repo_root = resolve_repo_anchor(candidate)
    env_path = repo_root / ".env"
    return env_path


def load_runtime_env(candidate: Path) -> dict[str, str]:
    env_path = resolve_env_file(candidate)
    if not env_path.exists():
        return {}
    return {
        key: value
        for key, value in dotenv_values(env_path).items()
        if key and value
    }


def resolve_artifacts_root(candidate: Path) -> Path:
    return resolve_runtime_root(candidate) / "artifacts"


def resolve_template_file(candidate: Path) -> Path:
    return resolve_runtime_root(candidate) / "templates" / "vmess_node.js"
