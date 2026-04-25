import os
from pathlib import Path

from dotenv import dotenv_values

from vpn_automation.config.models import resolve_repo_anchor


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


def resolve_upstream_proxy_url() -> str:
    value = os.environ.get("VPN_AUTOMATION_UPSTREAM_PROXY", "http://127.0.0.1:7897").strip()
    if value.lower() in {"", "off", "none", "false", "0"}:
        return ""
    return value
