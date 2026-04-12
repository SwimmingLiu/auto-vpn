from pathlib import Path
from typing import Any

import requests

from vpn_automation.config.models import DeployConfig
from vpn_automation.integrations.commands import run_command


def build_pages_deploy_command(bundle_dir: Path, project_name: str) -> list[str]:
    return [
        "npx",
        "wrangler",
        "pages",
        "deploy",
        str(bundle_dir),
        "--project-name",
        project_name,
    ]


def build_secret_url(deploy: DeployConfig) -> str:
    base = deploy.pages_project_url.rstrip("/")
    return f"{base}/?{deploy.secret_query}"


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
        response = self.session.get(url, timeout=30)
        response.raise_for_status()
        return expected_fragment in response.text if expected_fragment else True


def deploy_pages_bundle(bundle_dir: Path, deploy: DeployConfig, api_token: str) -> dict[str, Any]:
    command = build_pages_deploy_command(bundle_dir, deploy.project_name)
    result = run_command(
        command,
        cwd=str(bundle_dir),
        env={
            "CI": "1",
            "CLOUDFLARE_API_TOKEN": api_token,
            "CLOUDFLARE_ACCOUNT_ID": deploy.account_id,
        },
    )
    return {
        "command": command,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
