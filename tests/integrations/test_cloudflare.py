from pathlib import Path

import pytest
import requests

from vpn_automation.config.models import DeployConfig, WorkerBuildConfig
from vpn_automation.integrations.managed_tools import ManagedToolSpec, ResolvedManagedTool
from vpn_automation.integrations.cloudflare import (
    CloudflareClient,
    build_pages_deploy_command,
    build_secret_url,
    build_share_project_bundle_dir,
    deploy_pages_bundle,
    generate_fallback_project_name,
    resolve_deploy_proxy_url,
    resolve_share_project_worker_source_path,
)
from vpn_automation.pipeline.package import build_pages_bundle as build_pages_bundle_files
from vpn_automation.pipeline.worker_build import build_worker_artifacts


def _template_path() -> Path:
    return Path(__file__).resolve().parents[2] / "templates" / "vmess_node.js"


def _project_name_from_deploy_command(command: list[str]) -> str:
    return command[command.index("--project-name") + 1]


def _bundle_dir_from_deploy_command(command: list[str]) -> str:
    return command[command.index("deploy") + 1]


@pytest.fixture(autouse=True)
def stub_managed_wrangler(monkeypatch, tmp_path) -> None:
    wrangler = tmp_path / "tools" / "wrangler"
    wrangler.parent.mkdir(parents=True)
    wrangler.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.resolve_managed_npm_tool",
        lambda spec, *, project_root: ResolvedManagedTool(wrangler, "managed", "4.106.0", wrangler.parent),
    )


def test_build_pages_deploy_command_resolves_managed_wrangler(monkeypatch, tmp_path) -> None:
    project_root = tmp_path / "repo"
    wrangler = tmp_path / "custom-tools" / "wrangler"
    wrangler.parent.mkdir(parents=True)
    wrangler.write_text("#!/bin/sh\n", encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_resolve_managed_npm_tool(spec: ManagedToolSpec, *, project_root: Path) -> ResolvedManagedTool:
        captured["spec"] = spec
        captured["project_root"] = project_root
        return ResolvedManagedTool(wrangler, "managed", "4.106.0", wrangler.parent)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.resolve_repo_anchor", lambda _candidate: project_root)
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.resolve_managed_npm_tool",
        fake_resolve_managed_npm_tool,
    )

    command = build_pages_deploy_command(Path("/tmp/pages_bundle"), "sub-nodes")

    assert captured["spec"] == ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0")
    assert captured["project_root"] == project_root
    assert command == [
        str(wrangler.resolve()),
        "pages",
        "deploy",
        "/tmp/pages_bundle",
        "--project-name",
        "sub-nodes",
        "--branch",
        "main",
    ]


def test_build_pages_deploy_command_contains_project_name() -> None:
    command = build_pages_deploy_command(
        Path("/tmp/pages_bundle"),
        "sub-nodes",
        wrangler_executable=Path("/opt/managed/bin/wrangler"),
    )
    assert command[:4] == ["/opt/managed/bin/wrangler", "pages", "deploy", "/tmp/pages_bundle"]
    assert "--project-name" in command
    assert "sub-nodes" in command
    assert "--branch" in command
    assert "main" in command


def test_build_secret_url_uses_pages_project_url_and_query() -> None:
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937",
        pages_project_url="https://sub-nodes.pages.dev",
        secret_query="serect_key=swimmingliu",
    )

    assert build_secret_url(deploy) == "https://sub-nodes.pages.dev/?serect_key=swimmingliu"


def test_build_pages_bundle_writes_modules_and_manifest(tmp_path) -> None:
    config = WorkerBuildConfig()
    rendered = _template_path().read_text(encoding="utf-8").replace("__MAIN_DATA__", "payload")
    artifacts = build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    bundle_dir = build_pages_bundle_files("obfuscated", tmp_path / "pages_bundle", artifacts, config)

    assert (bundle_dir / "_worker.js").read_text(encoding="utf-8") == "obfuscated"
    assert (bundle_dir / "modules" / "guard.js").exists()
    assert (bundle_dir / "modules" / "payload.js").exists()
    assert (bundle_dir / "manifest.json").exists()


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

    assert client.verify_url("https://sub-nodes.pages.dev/?serect_key=swimmingliu") is True


def test_deploy_pages_bundle_retries_direct_once_after_network_error(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937",
        share_project_name="",
    )

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})

    calls: list[dict[str, object]] = []
    results = iter(
        [
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )

    def fake_run(command, cwd=None, env=None):
        calls.append({"command": command, "cwd": cwd, "env": env or {}})
        return next(results)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.run_command", fake_run)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["project_name"] == "sub-nodes"
    assert result["bundle_dir"] == str(bundle_dir)
    assert result["worker_entry"] == str(bundle_dir / "_worker.js")
    assert result["module_manifest_path"] == str(bundle_dir / "manifest.json")
    assert len(calls) == 2
    assert "HTTP_PROXY" not in calls[0]["env"]
    assert "HTTP_PROXY" not in calls[1]["env"]


def test_deploy_pages_bundle_retries_with_proxy_after_network_error(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937",
        share_project_name="",
    )

    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.load_runtime_env",
        lambda _candidate: {"VPN_AUTOMATION_DEPLOY_PROXY": "http://127.0.0.1:8080"},
    )

    calls: list[dict[str, object]] = []
    results = iter(
        [
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 1, "stdout": "", "stderr": "fetch failed\nUND_ERR_SOCKET"})(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )

    def fake_run(command, cwd=None, env=None):
        calls.append({"command": command, "cwd": cwd, "env": env or {}})
        return next(results)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.run_command", fake_run)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert len(calls) == 3
    assert "HTTP_PROXY" not in calls[0]["env"]
    assert "HTTP_PROXY" not in calls[1]["env"]
    assert calls[2]["env"]["HTTP_PROXY"] == "http://127.0.0.1:8080"
    assert calls[2]["env"]["HTTPS_PROXY"] == "http://127.0.0.1:8080"
    assert calls[2]["env"]["ALL_PROXY"] == "http://127.0.0.1:8080"


def test_resolve_deploy_proxy_url_honors_explicit_off_override(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260427-081718" / "pages_bundle"
    bundle_dir.mkdir(parents=True)

    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:8080")
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.load_runtime_env",
        lambda _candidate: {"VPN_AUTOMATION_DEPLOY_PROXY": "off"},
    )

    assert resolve_deploy_proxy_url(bundle_dir) == ""


def test_generate_fallback_project_name_respects_current_suffix_and_grows_width() -> None:
    name, suffix = generate_fallback_project_name(
        "sub-nodes",
        {"sub-nodes", "sub-nodes-99"},
        current_project_name="sub-nodes-99",
        last_used_suffix=99,
    )

    assert name == "sub-nodes-100"
    assert suffix == 100


def test_resolve_share_project_worker_source_path_falls_back_to_packaged_runtime_copy(
    monkeypatch,
    tmp_path,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    runtime_copy = project_root / "electron" / "runtime" / "share-worker" / "vpn.js"
    runtime_copy.parent.mkdir(parents=True)
    runtime_copy.write_text("export default { async fetch() { return new Response('runtime'); } }", encoding="utf-8")

    monkeypatch.delenv("VPN_AUTOMATION_SHARE_WORKER_PATH", raising=False)
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.resolve_repo_anchor", lambda _candidate: project_root)

    resolved = resolve_share_project_worker_source_path()

    assert resolved == runtime_copy.resolve()


def test_resolve_share_project_worker_source_path_uses_repo_template_without_sibling_reference(
    monkeypatch,
    tmp_path,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    repo_template = project_root / "templates" / "share-worker" / "vpn.js"
    repo_template.parent.mkdir(parents=True)
    repo_template.write_text("export default { async fetch() { return new Response('template'); } }", encoding="utf-8")

    monkeypatch.delenv("VPN_AUTOMATION_SHARE_WORKER_PATH", raising=False)
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.resolve_repo_anchor", lambda _candidate: project_root)

    resolved = resolve_share_project_worker_source_path()

    assert resolved == repo_template.resolve()


def test_build_share_project_bundle_dir_uses_ignored_runtime_tree(monkeypatch, tmp_path) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    source_path = project_root / "templates" / "share-worker" / "vpn.js"

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.resolve_repo_anchor", lambda _candidate: project_root)

    assert build_share_project_bundle_dir(source_path) == (
        project_root / "electron" / "runtime" / "share-worker" / "share_pages_bundle"
    )


def test_deploy_pages_bundle_syncs_share_project_sub_to_final_pages_url(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260507-150000" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/sub",
        pages_project_url="https://sub-nodes.pages.dev",
        share_project_name="sub-links-share-03",
    )

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})
    results = iter(
        [
            type(
                "Result",
                (),
                {
                    "returncode": 1,
                    "stdout": "",
                    "stderr": "Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]",
                },
            )(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: next(results),
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            self.created: list[str] = []
            self.updated: list[tuple[str, dict[str, object]]] = []

        def list_pages_projects(self):
            return [{"name": "sub-nodes"}, {"name": "sub-links-share-03"}]

        def create_pages_project(self, project_name: str):
            self.created.append(project_name)
            return {"name": project_name}

        def copy_pages_project_config(self, source_project_name: str, target_project_name: str, runtime_env: dict[str, str]):
            return {"name": target_project_name}

        def get_pages_project(self, project_name: str):
            assert project_name == "sub-links-share-03"
            return {
                "name": project_name,
                "deployment_configs": {
                    "preview": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                    "production": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                },
            }

        def update_pages_project(self, project_name: str, payload: dict[str, object]):
            self.updated.append((project_name, payload))
            return {"name": project_name}

    fake_client = FakeClient("token")
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.CloudflareClient", lambda api_token, account_id="": fake_client)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["project_name"] == "sub-nodes-01"
    assert result["pages_project_url"] == "https://sub-nodes-01.pages.dev"
    assert result["share_project_sync_ok"] is True
    assert result["share_project_name"] == "sub-links-share-03"
    assert result["share_project_sub_value"] == "https://sub-nodes-01.pages.dev/?serect_key=swimmingliu"
    assert result["fallback_last_used_suffix"] == 1
    assert fake_client.created == ["sub-nodes-01"]
    assert len(fake_client.updated) == 1
    project_name, payload = fake_client.updated[0]
    assert project_name == "sub-links-share-03"
    assert payload["deployment_configs"]["preview"]["env_vars"]["SUB"]["value"] == "https://sub-nodes-01.pages.dev/?serect_key=swimmingliu"
    assert payload["deployment_configs"]["production"]["env_vars"]["SUB"]["value"] == "https://sub-nodes-01.pages.dev/?serect_key=swimmingliu"


def test_deploy_pages_bundle_falls_back_share_project_when_share_project_is_blocked(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260507-150500" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/sub",
        pages_project_url="https://sub-nodes.pages.dev",
        share_project_name="sub-links-share-03",
    )

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            self.created: list[str] = []
            self.updated: list[tuple[str, dict[str, object]]] = []
            self.copy_calls: list[tuple[str, str]] = []

        def list_pages_projects(self):
            return [{"name": "sub-nodes"}, {"name": "sub-links-share-03"}]

        def create_pages_project(self, project_name: str):
            self.created.append(project_name)
            return {"name": project_name}

        def copy_pages_project_config(self, source_project_name: str, target_project_name: str, runtime_env: dict[str, str]):
            self.copy_calls.append((source_project_name, target_project_name))
            return {"name": target_project_name}

        def get_pages_project(self, project_name: str):
            return {
                "name": project_name,
                "deployment_configs": {
                    "preview": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                    "production": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                },
            }

        def update_pages_project(self, project_name: str, payload: dict[str, object]):
            if project_name == "sub-links-share-03":
                raise RuntimeError("Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]")
            self.updated.append((project_name, payload))
            return {"name": project_name}

    fake_client = FakeClient("token")
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.CloudflareClient", lambda api_token, account_id="": fake_client)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["share_project_sync_ok"] is True
    assert result["share_project_name"] == "sub-links-share-04"
    assert result["share_project_fallback_used"] is True
    assert result["share_project_cleanup_blocked_project"] == "sub-links-share-03"
    assert result["share_project_fallback_last_used_suffix"] == 4
    assert fake_client.created == ["sub-links-share-04"]
    assert fake_client.copy_calls == [("sub-links-share-03", "sub-links-share-04")]
    assert fake_client.updated[0][0] == "sub-links-share-04"
    assert (
        fake_client.updated[0][1]["deployment_configs"]["preview"]["env_vars"]["SUB"]["value"]
        == "https://sub-nodes.pages.dev/?serect_key=swimmingliu"
    )


def test_deploy_pages_bundle_redeploys_share_project_after_sub_update(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260507-180500" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/sub",
        pages_project_url="https://sub-nodes.pages.dev",
        share_project_name="sub-links-share-03",
    )

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})
    run_calls: list[list[str]] = []
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: (
            run_calls.append(command),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})()
        )[1],
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            self.updated: list[tuple[str, dict[str, object]]] = []

        def list_pages_projects(self):
            return [{"name": "sub-links-share-03"}]

        def get_pages_project(self, project_name: str):
            return {
                "name": project_name,
                "deployment_configs": {
                    "preview": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                    "production": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                },
            }

        def update_pages_project(self, project_name: str, payload: dict[str, object]):
            self.updated.append((project_name, payload))
            return {"name": project_name}

    fake_client = FakeClient("token")
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.CloudflareClient", lambda api_token, account_id="": fake_client)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["share_project_sync_ok"] is True
    assert len(fake_client.updated) == 1
    assert len(run_calls) == 2
    assert _project_name_from_deploy_command(run_calls[0]) == "sub-nodes"
    assert _project_name_from_deploy_command(run_calls[1]) == "sub-links-share-03"


def test_deploy_pages_bundle_falls_back_when_share_redeploy_is_blocked(monkeypatch, tmp_path) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260507-181500" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    share_worker_source = tmp_path / "vpn.js"
    share_worker_source.write_text("export default { async fetch() { return new Response('login'); } }", encoding="utf-8")
    deploy = DeployConfig(
        project_name="sub-nodes",
        subscription_url="https://swimmingliu.online/sub",
        pages_project_url="https://sub-nodes.pages.dev",
        share_project_name="sub-links-share-03",
    )

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.resolve_share_project_worker_source_path",
        lambda: share_worker_source,
    )
    results = iter(
        [
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
            type(
                "Result",
                (),
                {
                    "returncode": 1,
                    "stdout": "",
                    "stderr": "Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]",
                },
            )(),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
        ]
    )
    run_calls: list[list[str]] = []

    def fake_run(command, cwd=None, env=None):
        run_calls.append(command)
        return next(results)

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.run_command", fake_run)

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            self.created: list[str] = []
            self.updated: list[tuple[str, dict[str, object]]] = []
            self.copy_calls: list[tuple[str, str]] = []
            self.attached: list[tuple[str, str]] = []
            self.dns_calls: list[tuple[str, str, bool]] = []

        def list_pages_projects(self):
            return [{"name": "sub-links-share-03"}]

        def list_pages_domains(self, project_name: str):
            if project_name == "sub-links-share-03":
                return [{"name": "www.swimmingliu.online"}]
            return []

        def get_pages_project(self, project_name: str):
            return {
                "name": project_name,
                "deployment_configs": {
                    "preview": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                    "production": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                },
            }

        def update_pages_project(self, project_name: str, payload: dict[str, object]):
            self.updated.append((project_name, payload))
            return {"name": project_name}

        def create_pages_project(self, project_name: str):
            self.created.append(project_name)
            return {"name": project_name}

        def copy_pages_project_config(self, source_project_name: str, target_project_name: str, runtime_env: dict[str, str]):
            self.copy_calls.append((source_project_name, target_project_name))
            return {"name": target_project_name}

        def attach_custom_domain(self, project_name: str, domain: str):
            self.attached.append((project_name, domain))
            return {"name": domain}

        def detach_custom_domain(self, project_name: str, domain: str):
            self.attached.append((f"detach:{project_name}", domain))
            return {"success": True}

        def upsert_subdomain_cname(self, hostname: str, target: str, proxied: bool = True):
            self.dns_calls.append((hostname, target, proxied))
            return {"id": "dns-1", "name": hostname, "content": target, "proxied": proxied}

    fake_client = FakeClient("token")
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.CloudflareClient", lambda api_token, account_id="": fake_client)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["share_project_sync_ok"] is True
    assert result["share_project_name"] == "sub-links-share-04"
    assert result["share_project_fallback_used"] is True
    assert result["share_project_cleanup_blocked_project"] == "sub-links-share-03"
    assert fake_client.created == ["sub-links-share-04"]
    assert fake_client.copy_calls == [("sub-links-share-03", "sub-links-share-04")]
    assert fake_client.attached == [("sub-links-share-04", "www.swimmingliu.online")]
    assert fake_client.dns_calls == [("www.swimmingliu.online", "sub-links-share-04.pages.dev", False)]
    assert len(run_calls) == 3
    assert _project_name_from_deploy_command(run_calls[1]) == "sub-links-share-03"
    assert _project_name_from_deploy_command(run_calls[2]) == "sub-links-share-04"
    assert result["share_project_source_path"] == str(share_worker_source)
    assert result["share_project_bundle_dir"].endswith("/share_pages_bundle")
    assert result["share_project_worker_entry"].endswith("/share_pages_bundle/_worker.js")
    assert _bundle_dir_from_deploy_command(run_calls[2]).endswith("/share_pages_bundle")


def test_deploy_pages_bundle_recovers_latest_existing_share_project_when_requested_share_project_is_missing(
    monkeypatch,
    tmp_path,
) -> None:
    bundle_dir = tmp_path / "artifacts" / "20260507-220500" / "pages_bundle"
    bundle_dir.mkdir(parents=True)
    deploy = DeployConfig(
        project_name="sub-nodes-04",
        subscription_url="https://swimmingliu.online/sub",
        pages_project_url="https://sub-nodes-04.pages.dev",
        share_project_name="sub-links-share-03",
    )

    monkeypatch.setattr("vpn_automation.integrations.cloudflare.load_runtime_env", lambda _candidate: {})
    run_calls: list[list[str]] = []
    monkeypatch.setattr(
        "vpn_automation.integrations.cloudflare.run_command",
        lambda command, cwd=None, env=None: (
            run_calls.append(command),
            type("Result", (), {"returncode": 0, "stdout": "ok", "stderr": ""})()
        )[1],
    )

    class FakeClient:
        def __init__(self, api_token: str, account_id: str = "") -> None:
            self.updated: list[tuple[str, dict[str, object]]] = []

        def list_pages_projects(self):
            return [{"name": "sub-nodes-04"}, {"name": "sub-links-share-05"}]

        def get_pages_project(self, project_name: str):
            if project_name == "sub-links-share-03":
                raise RuntimeError("Cloudflare Pages project not found: sub-links-share-03")
            assert project_name == "sub-links-share-05"
            return {
                "name": project_name,
                "deployment_configs": {
                    "preview": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                    "production": {"env_vars": {"SUB": {"type": "plain_text", "value": "https://old.pages.dev"}}},
                },
            }

        def list_pages_domains(self, project_name: str):
            assert project_name == "sub-links-share-05"
            return []

        def update_pages_project(self, project_name: str, payload: dict[str, object]):
            self.updated.append((project_name, payload))
            return {"name": project_name}

    fake_client = FakeClient("token")
    monkeypatch.setattr("vpn_automation.integrations.cloudflare.CloudflareClient", lambda api_token, account_id="": fake_client)

    result = deploy_pages_bundle(bundle_dir, deploy, "token")

    assert result["returncode"] == 0
    assert result["share_project_sync_ok"] is True
    assert result["share_project_name"] == "sub-links-share-05"
    assert result["share_project_requested_name"] == "sub-links-share-03"
    assert fake_client.updated[0][0] == "sub-links-share-05"
    assert fake_client.updated[0][1]["deployment_configs"]["preview"]["env_vars"]["SUB"]["value"] == "https://sub-nodes-04.pages.dev/?serect_key=swimmingliu"
    assert len(run_calls) == 2
    assert _project_name_from_deploy_command(run_calls[1]) == "sub-links-share-05"
