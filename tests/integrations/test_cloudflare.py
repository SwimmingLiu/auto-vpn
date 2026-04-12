from pathlib import Path

from vpn_automation.integrations.cloudflare import build_pages_deploy_command


def test_build_pages_deploy_command_contains_project_name() -> None:
    command = build_pages_deploy_command(Path("/tmp/pages_bundle"), "vmessnodes")
    assert command[:4] == ["npx", "wrangler", "pages", "deploy"]
    assert "--project-name" in command
    assert "vmessnodes" in command
