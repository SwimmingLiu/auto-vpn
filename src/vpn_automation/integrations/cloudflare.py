import os
from pathlib import Path
from typing import Any

import requests

from vpn_automation.config.models import DeployConfig
from vpn_automation.config.runtime import load_runtime_env
from vpn_automation.integrations.commands import run_command


NETWORK_ERROR_MARKERS = (
    "fetch failed",
    "connectivity issue",
    "und_err_socket",
    "other side closed",
    "econnreset",
    "etimedout",
)
PAGES_PRODUCTION_BRANCH = "main"


def build_pages_deploy_command(bundle_dir: Path, project_name: str) -> list[str]:
    return [
        "npx",
        "wrangler",
        "pages",
        "deploy",
        str(bundle_dir),
        "--project-name",
        project_name,
        "--branch",
        PAGES_PRODUCTION_BRANCH,
    ]


def build_secret_url(deploy: DeployConfig) -> str:
    base = deploy.pages_project_url.rstrip("/")
    return f"{base}/?{deploy.secret_query}"


def resolve_deploy_proxy_url(candidate: Path) -> str:
    runtime_env = load_runtime_env(candidate)
    for key in (
        "VPN_AUTOMATION_DEPLOY_PROXY",
        "VPN_AUTOMATION_CLOUDFLARE_PROXY",
        "VPN_AUTOMATION_UPSTREAM_PROXY",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
    ):
        if key in runtime_env:
            value = runtime_env[key].strip()
        elif key in os.environ:
            value = os.environ[key].strip()
        else:
            continue
        if value.lower() in {"off", "none", "false", "0"}:
            return ""
        if value:
            return value
    return ""


def _is_transient_deploy_failure(stdout: str, stderr: str) -> bool:
    combined = "\n".join([stdout, stderr]).lower()
    return any(marker in combined for marker in NETWORK_ERROR_MARKERS)


def _build_proxy_env(proxy_url: str) -> dict[str, str]:
    if not proxy_url:
        return {}
    return {
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "ALL_PROXY": proxy_url,
    }


class CloudflareClient:
    def __init__(self, api_token: str, account_id: str = "") -> None:
        self.api_token = api_token
        self.account_id = account_id
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers.update(
            {
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            }
        )

    def list_accounts(self) -> list[dict[str, Any]]:
        response = self.session.get("https://api.cloudflare.com/client/v4/accounts", timeout=20)
        response.raise_for_status()
        return response.json()["result"]

    def resolve_account_id(self) -> str:
        if self.account_id:
            return self.account_id
        accounts = self.list_accounts()
        if not accounts:
            raise RuntimeError("No Cloudflare account available for the supplied API token")
        self.account_id = str(accounts[0]["id"])
        return self.account_id

    def list_pages_projects(self) -> list[dict[str, Any]]:
        account_id = self.resolve_account_id()
        response = self.session.get(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects",
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def get_pages_project(self, project_name: str) -> dict[str, Any]:
        for project in self.list_pages_projects():
            if project["name"] == project_name:
                return project
        raise RuntimeError(f"Cloudflare Pages project not found: {project_name}")

    def verify_url(self, url: str, expected_fragment: str = "") -> bool:
        try:
            response = self.session.get(url, timeout=30)
            response.raise_for_status()
            return expected_fragment in response.text if expected_fragment else True
        except requests.exceptions.SSLError:
            result = run_command(["curl", "-fsSL", "--max-time", "30", url])
            if result.returncode != 0:
                raise RuntimeError(result.stderr or result.stdout or f"curl verification failed: {url}")
            return expected_fragment in result.stdout if expected_fragment else True


def deploy_pages_bundle(bundle_dir: Path, deploy: DeployConfig, api_token: str) -> dict[str, Any]:
    command = build_pages_deploy_command(bundle_dir, deploy.project_name)
    base_env = {
        "CI": "1",
        "CLOUDFLARE_API_TOKEN": api_token,
        "CLOUDFLARE_ACCOUNT_ID": deploy.account_id,
    }
    proxy_url = resolve_deploy_proxy_url(bundle_dir)
    attempts = [
        ("direct", base_env),
        ("direct-retry", base_env),
    ]
    if proxy_url:
        attempts.append(("proxy", {**base_env, **_build_proxy_env(proxy_url)}))

    result = None
    attempt_log: list[dict[str, Any]] = []
    for index, (mode, env) in enumerate(attempts):
        result = run_command(
            command,
            cwd=str(bundle_dir),
            env=env,
        )
        attempt_log.append({"mode": mode, "returncode": result.returncode})
        if result.returncode == 0:
            break
        if not _is_transient_deploy_failure(result.stdout, result.stderr):
            break
        if index == len(attempts) - 1:
            break

    assert result is not None
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "attempts": attempt_log,
        "project_name": deploy.project_name,
        "pages_project_url": deploy.pages_project_url,
        "bundle_dir": str(bundle_dir),
        "worker_entry": str(bundle_dir / "_worker.js"),
        "module_manifest_path": str(bundle_dir / "manifest.json"),
    }
