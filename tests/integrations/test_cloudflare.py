from pathlib import Path

import requests

from vpn_automation.config.models import DeployConfig
from vpn_automation.integrations.cloudflare import CloudflareClient, build_pages_deploy_command, build_secret_url


def test_build_pages_deploy_command_contains_project_name() -> None:
    command = build_pages_deploy_command(Path("/tmp/pages_bundle"), "vms-nodes")
    assert command[:4] == ["npx", "wrangler", "pages", "deploy"]
    assert "--project-name" in command
    assert "vms-nodes" in command


def test_build_secret_url_uses_pages_project_url_and_query() -> None:
    deploy = DeployConfig(
        project_name="vms-nodes",
        subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
        pages_project_url="https://vms-nodes.pages.dev",
        secret_query="serect_key=swimmingliu",
    )

    assert build_secret_url(deploy) == "https://vms-nodes.pages.dev/?serect_key=swimmingliu"


def test_verify_url_falls_back_to_curl_on_ssl_error(monkeypatch) -> None:
    client = CloudflareClient(api_token="token", account_id="account")

    def raise_ssl(*_args, **_kwargs):
        raise requests.exceptions.SSLError("ssl eof")

    monkeypatch.setattr(client.session, "get", raise_ssl)
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: type(
            "Result",
            (),
            {"returncode": 0, "stdout": "ok", "stderr": ""},
        )(),
    )

    assert client.verify_url("https://vms-nodes.pages.dev/?serect_key=swimmingliu") is True
