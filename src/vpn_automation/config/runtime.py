import os
from pathlib import Path

from dotenv import dotenv_values

from vpn_automation.config.models import resolve_repo_anchor


def resolve_user_runtime_root() -> Path:
    runtime_override = os.environ.get("VPN_AUTOMATION_RUNTIME_ROOT", "").strip()
    if runtime_override:
        return Path(runtime_override).expanduser().resolve()
    return Path.home() / ".auto-vpn"


def resolve_runtime_root(candidate: Path) -> Path:
    resolved = candidate.resolve()
    if resolved.exists():
        current = resolved if resolved.is_dir() else resolved.parent
    else:
        current = resolved if resolved.suffix == "" else resolved.parent
    for path in [current, *current.parents]:
        if (path / "pyproject.toml").exists():
            return path
    return current


def resolve_env_file(candidate: Path) -> Path:
    repo_root = resolve_repo_anchor(candidate)
    return repo_root / ".env"


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
    artifacts_override = os.environ.get("VPN_AUTOMATION_ARTIFACTS_ROOT", "").strip()
    if artifacts_override:
        return Path(artifacts_override).expanduser().resolve()
    return resolve_user_runtime_root() / "artifacts"


def resolve_template_file(candidate: Path) -> Path:
    return resolve_runtime_root(candidate) / "templates" / "vmess_node.js"


def resolve_upstream_proxy_url() -> str:
    value = os.environ.get("VPN_AUTOMATION_UPSTREAM_PROXY", "http://127.0.0.1:7897").strip()
    if value.lower() in {"", "off", "none", "false", "0"}:
        return ""
    return value
