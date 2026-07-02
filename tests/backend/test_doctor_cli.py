import json
import subprocess
from pathlib import Path

from vpn_automation import cli, doctor
from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.integrations.managed_tools import ManagedToolError, ResolvedManagedTool


class _Python312Version(tuple):
    major = 3
    minor = 12
    micro = 0

    def __new__(cls):
        return super().__new__(cls, (cls.major, cls.minor, cls.micro, "final", 0))


def _write_minimal_project(project_root: Path, *, source_key: str = "SOURCE-SECRET", api_token: str = "") -> None:
    (project_root / "templates" / "share-worker").mkdir(parents=True)
    (project_root / "templates" / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")
    (project_root / "templates" / "share-worker" / "vpn.js").write_text("export default {};", encoding="utf-8")
    ProfileStore(resolve_profile_path(project_root)).save(
        AppProfile(
            sources={
                "leiting": SourceConfig(
                    url="https://source.example/api?token=SOURCE-URL-SECRET",
                    key=source_key,
                    enabled=True,
                    max_iterations=10,
                    min_iterations=1,
                )
            },
            speed_test=SpeedTestConfig(
                min_download_mb_s=1.0,
                timeout_seconds=10,
                concurrency=2,
                urls=["https://speed.example/file.bin"],
            ),
            deploy=DeployConfig(
                project_name="sub-nodes",
                subscription_url="https://sub.example/sub?token=SUB-SECRET",
                cloudflare_api_token=api_token,
            ),
        )
    )


def _fake_successful_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(doctor.sys, "version_info", _Python312Version())
    monkeypatch.setattr(doctor.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        doctor.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, stdout="ok\n", stderr=""),
    )
    monkeypatch.setattr(
        doctor,
        "resolve_managed_npm_tool",
        lambda spec, *, project_root, install_missing=None: ResolvedManagedTool(
            Path(f"/usr/bin/{spec.binary}"),
            "managed",
            spec.version,
            Path(f"/usr/lib/{spec.package}"),
        ),
        raising=False,
    )
    monkeypatch.setattr(doctor, "_url_reachable", lambda url, timeout_seconds=3: (True, "reachable"))
    monkeypatch.setattr(doctor, "_playwright_browser_ready", lambda project_root: (True, "chromium ready"))


def test_doctor_json_reports_checks_without_leaking_secrets(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert code == 0
    assert payload["ok"] is True
    assert any(check["name"] == "sources" and check["status"] == "pass" for check in payload["checks"])
    assert "SOURCE-SECRET" not in captured.out
    assert "SOURCE-URL-SECRET" not in captured.out
    assert "CF-TOKEN-SECRET" not in captured.out
    assert "SUB-SECRET" not in captured.out
    assert captured.err == ""


def test_doctor_deploy_strict_fails_when_cloudflare_credentials_are_missing(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root)
    _fake_successful_dependencies(monkeypatch)
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    monkeypatch.delenv("CLOUDFLARE_API_KEY", raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--deploy", "--strict", "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    cloudflare_check = next(check for check in payload["checks"] if check["name"] == "cloudflare_credentials")
    assert code == 1
    assert payload["ok"] is False
    assert cloudflare_check["status"] == "fail"
    assert "missing" in cloudflare_check["message"].lower()


def test_doctor_human_output_marks_warning_and_strict_returns_nonzero(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, source_key="")
    _fake_successful_dependencies(monkeypatch)

    code = cli.main(["doctor", "--project-root", str(project_root), "--strict", "--output", "human"])

    captured = capsys.readouterr()
    assert code == 1
    assert "[warn] sources:" in captured.out
    assert "SOURCE-URL-SECRET" not in captured.out


def test_doctor_reports_missing_mihomo_without_requiring_npx(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")

    def fake_which(name: str) -> str | None:
        if name in {"mihomo", "npx"}:
            return None
        return f"/usr/bin/{name}"

    monkeypatch.setattr(doctor.shutil, "which", fake_which)
    monkeypatch.setattr(
        doctor,
        "resolve_managed_npm_tool",
        lambda spec, *, project_root, install_missing=None: ResolvedManagedTool(
            Path(f"/usr/bin/{spec.binary}"),
            "managed",
            spec.version,
            Path(f"/usr/lib/{spec.package}"),
        ),
    )
    monkeypatch.setattr(doctor, "_url_reachable", lambda url, timeout_seconds=3: (True, "reachable"))
    monkeypatch.setattr(doctor, "_playwright_browser_ready", lambda project_root: (True, "chromium ready"))

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    checks = {check["name"]: check for check in payload["checks"]}
    assert code == 1
    assert checks["mihomo"]["status"] == "fail"
    assert checks["node_binaries"]["status"] == "pass"
    assert checks["node_binaries"]["details"]["missing"] == []


def test_doctor_warns_when_playwright_browser_is_missing(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    monkeypatch.setattr(doctor, "_playwright_browser_ready", lambda project_root: (False, "browser missing"))

    code = cli.main(["doctor", "--project-root", str(project_root), "--strict", "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "playwright_browser")
    assert code == 1
    assert check["status"] == "warn"
    assert "browser missing" in check["message"]


def test_doctor_deploy_strict_requires_wrangler_and_account_id(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    profile = ProfileStore(resolve_profile_path(project_root)).load()
    profile.deploy.account_id = ""
    ProfileStore(resolve_profile_path(project_root)).save(profile)

    monkeypatch.setattr(
        doctor,
        "resolve_managed_npm_tool",
        lambda spec, *, project_root, install_missing=None: (_ for _ in ()).throw(ManagedToolError("wrangler missing")),
        raising=False,
    )

    code = cli.main(["doctor", "--project-root", str(project_root), "--deploy", "--strict", "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    checks = {check["name"]: check for check in payload["checks"]}
    assert code == 1
    assert checks["cloudflare_account"]["status"] == "fail"
    assert checks["wrangler"]["status"] == "fail"
    assert checks["wrangler"]["message"] == "wrangler missing"


def test_doctor_reports_unreachable_network_urls(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    monkeypatch.setattr(doctor, "_url_reachable", lambda url, timeout_seconds=3: (False, "timeout"))

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "network_reachability")
    assert code == 1
    assert check["status"] == "fail"
    assert check["details"]["failed_count"] >= 2
    assert "SOURCE-URL-SECRET" not in json.dumps(check, ensure_ascii=False)


def test_doctor_fails_when_profile_path_is_not_writable(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    monkeypatch.setattr(doctor, "_path_writable", lambda path: False if path.name == "profile.toml" else True)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "profile_path")
    assert code == 1
    assert check["status"] == "fail"


def test_doctor_reports_managed_obfuscator_details(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_resolver(spec, *, project_root, install_missing=None):
        if spec.binary == "javascript-obfuscator":
            return ResolvedManagedTool(
                Path("/opt/tools/javascript-obfuscator"),
                "project",
                "5.4.3",
                Path("/opt/tools"),
            )
        return ResolvedManagedTool(Path(f"/usr/bin/{spec.binary}"), "managed", spec.version, Path("/opt/tools"))

    monkeypatch.setattr(doctor, "resolve_managed_npm_tool", fake_resolver, raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "javascript_obfuscator")
    assert code == 0
    assert check["status"] == "pass"
    assert check["details"]["source"] == "project"
    assert check["details"]["version"] == "5.4.3"
    assert check["details"]["path"] == "/opt/tools/javascript-obfuscator"


def test_doctor_reports_managed_obfuscator_error(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_resolver(spec, *, project_root, install_missing=None):
        if spec.binary == "javascript-obfuscator":
            raise ManagedToolError("javascript-obfuscator unavailable")
        return ResolvedManagedTool(Path(f"/usr/bin/{spec.binary}"), "managed", spec.version, Path("/opt/tools"))

    monkeypatch.setattr(doctor, "resolve_managed_npm_tool", fake_resolver, raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "javascript_obfuscator")
    assert code == 1
    assert check["status"] == "fail"
    assert check["message"] == "javascript-obfuscator unavailable"


def test_doctor_resolves_managed_tools_without_installing(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    calls: list[tuple[str, bool | None]] = []

    def fake_resolver(spec, *, project_root, install_missing=None):
        calls.append((spec.binary, install_missing))
        return ResolvedManagedTool(Path(f"/usr/bin/{spec.binary}"), "managed", spec.version, Path("/opt/tools"))

    monkeypatch.setattr(doctor, "resolve_managed_npm_tool", fake_resolver, raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    assert code == 0
    assert ("javascript-obfuscator", False) in calls
    assert ("wrangler", False) in calls


def test_doctor_reports_managed_wrangler_details(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_resolver(spec, *, project_root, install_missing=None):
        if spec.binary == "wrangler":
            return ResolvedManagedTool(Path("/opt/tools/wrangler"), "managed", "4.106.0", Path("/opt/tools"))
        return ResolvedManagedTool(Path(f"/usr/bin/{spec.binary}"), "managed", spec.version, Path("/opt/tools"))

    monkeypatch.setattr(doctor, "resolve_managed_npm_tool", fake_resolver, raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--deploy", "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "wrangler")
    assert code == 0
    assert check["status"] == "pass"
    assert check["details"]["source"] == "managed"
    assert check["details"]["version"] == "4.106.0"
    assert check["details"]["path"] == "/opt/tools/wrangler"
    assert check["details"]["deploy_required"] is True


def test_doctor_fails_for_wrangler_pages_deploy_help_failure_in_deploy_mode(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_safe_run(command):
        if command[1:] == ["pages", "deploy", "--help"]:
            return False, "help failed"
        return True, "ok"

    monkeypatch.setattr(doctor, "_safe_run", fake_safe_run)

    code = cli.main(["doctor", "--project-root", str(project_root), "--deploy", "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "wrangler")
    assert code == 1
    assert check["status"] == "fail"
    assert check["message"] == "Wrangler Pages deploy command is not available"
    assert check["details"]["result"] == "help failed"


def test_doctor_warns_for_wrangler_pages_deploy_help_failure_when_deploy_not_required(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_safe_run(command):
        if command[1:] == ["pages", "deploy", "--help"]:
            return False, "help failed"
        return True, "ok"

    monkeypatch.setattr(doctor, "_safe_run", fake_safe_run)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "wrangler")
    assert code == 0
    assert check["status"] == "warn"
    assert check["message"] == "Wrangler Pages deploy command is not available"
    assert check["details"]["result"] == "help failed"


def test_doctor_warns_for_managed_wrangler_error_when_deploy_not_required(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)

    def fake_resolver(spec, *, project_root, install_missing=None):
        if spec.binary == "wrangler":
            raise ManagedToolError("wrangler unavailable")
        return ResolvedManagedTool(Path(f"/usr/bin/{spec.binary}"), "managed", spec.version, Path("/opt/tools"))

    monkeypatch.setattr(doctor, "resolve_managed_npm_tool", fake_resolver, raising=False)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "wrangler")
    assert code == 0
    assert check["status"] == "warn"
    assert check["message"] == "wrangler unavailable"


def test_doctor_fails_invalid_speedtest_settings(tmp_path: Path, monkeypatch, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    _write_minimal_project(project_root, api_token="CF-TOKEN-SECRET")
    _fake_successful_dependencies(monkeypatch)
    profile = ProfileStore(resolve_profile_path(project_root)).load()
    profile.speed_test.timeout_seconds = 0
    ProfileStore(resolve_profile_path(project_root)).save(profile)

    code = cli.main(["doctor", "--project-root", str(project_root), "--output", "json"])

    payload = json.loads(capsys.readouterr().out)
    check = next(check for check in payload["checks"] if check["name"] == "speed_test_config")
    assert code == 1
    assert check["status"] == "fail"
