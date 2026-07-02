import importlib
import json
import os
import shutil
import socket
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from vpn_automation.config.runtime import load_runtime_env, resolve_artifacts_root, resolve_env_file
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.integrations.managed_tools import ManagedToolError, ManagedToolSpec, resolve_managed_npm_tool


Status = str

JAVASCRIPT_OBFUSCATOR = ManagedToolSpec(
    package="javascript-obfuscator",
    binary="javascript-obfuscator",
    version="5.4.3",
)
WRANGLER = ManagedToolSpec(package="wrangler", binary="wrangler", version="4.106.0")


@dataclass
class DoctorCheck:
    name: str
    status: Status
    message: str
    details: dict[str, Any] = field(default_factory=dict)


def _check(name: str, status: Status, message: str, **details: Any) -> DoctorCheck:
    return DoctorCheck(name=name, status=status, message=message, details=details)


def _safe_run(command: list[str]) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"
    output = (result.stdout or result.stderr or "").strip().splitlines()
    return result.returncode == 0, output[0] if output else f"exit {result.returncode}"


def _can_bind_localhost() -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
        return True
    except OSError:
        return False


def _path_writable(path: Path) -> bool:
    target = path if path.exists() and path.is_dir() else path.parent
    try:
        target.mkdir(parents=True, exist_ok=True)
        probe = target / ".doctor-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


def _url_reachable(url: str, timeout_seconds: int = 3) -> tuple[bool, str]:
    if not url.strip():
        return False, "empty URL"
    try:
        response = requests.head(url, allow_redirects=True, timeout=timeout_seconds)
        if response.status_code >= 405:
            response = requests.get(url, stream=True, timeout=timeout_seconds)
        response.close()
        return response.status_code < 500, f"HTTP {response.status_code}"
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"


def _playwright_browser_ready(project_root: Path) -> tuple[bool, str]:
    node = shutil.which("node")
    if not node:
        return False, "node binary missing"
    script = (
        "const { chromium } = require('playwright');"
        "const path = chromium.executablePath();"
        "if (!path) process.exit(2);"
        "console.log(path);"
    )
    env = dict(os.environ)
    module_dirs = [
        project_root / "node_modules",
        project_root / "electron" / "runtime" / "node-vendor" / "node_modules",
    ]
    existing = [str(path) for path in module_dirs if path.exists()]
    if existing:
        env["NODE_PATH"] = os.pathsep.join(existing)
    try:
        result = subprocess.run(
            [node, "-e", script],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
            cwd=str(project_root),
        )
    except Exception as exc:
        return False, f"{exc.__class__.__name__}: {exc}"
    executable = (result.stdout or "").strip().splitlines()[0] if result.stdout.strip() else ""
    if result.returncode != 0:
        return False, (result.stderr or result.stdout or f"exit {result.returncode}").strip()
    if executable and Path(executable).exists():
        return True, "Chromium executable is available"
    return False, "Chromium executable path is missing"


def _runtime_env(project_root: Path) -> dict[str, str]:
    merged = dict(os.environ)
    merged.update(load_runtime_env(project_root))
    return {key: value for key, value in merged.items() if value}


def _has_cloudflare_credentials(profile: Any, runtime_env: dict[str, str]) -> bool:
    deploy = profile.deploy
    api_token = getattr(deploy, "cloudflare_api_token", "") or runtime_env.get("CLOUDFLARE_API_TOKEN", "")
    global_key = getattr(deploy, "cloudflare_global_key", "") or runtime_env.get("CLOUDFLARE_API_KEY", "")
    email = getattr(deploy, "cloudflare_email", "") or runtime_env.get("CLOUDFLARE_EMAIL", "")
    return bool(api_token or (global_key and email))


def _check_python_runtime(project_root: Path) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    version = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    status = "pass" if sys.version_info >= (3, 12) else "fail"
    checks.append(_check("python_version", status, f"Python {version}", required=">=3.12"))

    imports = [
        "vpn_automation.backend",
        "vpn_automation.pipeline.controller",
        "requests",
        "dotenv",
        "tomlkit",
        "cryptography",
    ]
    missing: list[str] = []
    for module_name in imports:
        try:
            importlib.import_module(module_name)
        except Exception:
            missing.append(module_name)
    if missing:
        checks.append(_check("python_imports", "fail", "Python package imports are missing", missing=missing))
    else:
        checks.append(_check("python_imports", "pass", "Python package imports are available", checked=imports))

    checks.append(_check("project_root", "pass", "Project root resolved", path=str(project_root)))
    return checks


def _check_paths(project_root: Path) -> tuple[list[DoctorCheck], Any]:
    checks: list[DoctorCheck] = []
    profile_path = resolve_profile_path(project_root)
    store = ProfileStore(profile_path)
    profile = store.load_or_create(project_root)
    profile_writable = _path_writable(profile_path)
    checks.append(
        _check(
            "profile_path",
            "pass" if profile_writable else "fail",
            "Profile is readable and writable" if profile_writable else "Profile path is not writable",
            profile_path=str(profile_path),
            exists=profile_path.exists(),
        )
    )

    artifacts_root = resolve_artifacts_root(project_root)
    try:
        artifacts_root.mkdir(parents=True, exist_ok=True)
        probe = artifacts_root / ".doctor-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        checks.append(_check("artifacts_root", "pass", "Artifacts root is writable", path=str(artifacts_root)))
    except Exception as exc:
        checks.append(_check("artifacts_root", "fail", "Artifacts root is not writable", error=exc.__class__.__name__))

    template_path = project_root / "templates" / "vmess_node.js"
    checks.append(
        _check(
            "worker_template",
            "pass" if template_path.exists() else "fail",
            "Worker template exists" if template_path.exists() else "Worker template is missing",
            path=str(template_path),
        )
    )

    share_template_path = project_root / "templates" / "share-worker" / "vpn.js"
    checks.append(
        _check(
            "share_worker_template",
            "pass" if share_template_path.exists() else "warn",
            "Share worker template exists" if share_template_path.exists() else "Share worker template is missing",
            path=str(share_template_path),
        )
    )

    env_path = resolve_env_file(project_root)
    checks.append(
        _check(
            "env_file",
            "pass" if env_path.exists() else "warn",
            ".env file exists" if env_path.exists() else ".env file is not present",
            path=str(env_path),
        )
    )
    return checks, profile


def _check_sources(profile: Any) -> DoctorCheck:
    enabled = [source for source in profile.sources.values() if source.enabled]
    configured = [source for source in enabled if source.url.strip() and source.key.strip()]
    invalid = [
        name
        for name, source in profile.sources.items()
        if source.enabled and (source.max_iterations < 1 or source.min_iterations < 0)
    ]
    if invalid:
        return _check("sources", "fail", "Enabled source iteration settings are invalid", invalid_sources=invalid)
    if configured:
        return _check(
            "sources",
            "pass",
            "At least one enabled source is configured",
            enabled_count=len(enabled),
            configured_count=len(configured),
            key_state="set",
        )
    return _check(
        "sources",
        "warn",
        "No enabled source has both URL and key configured",
        enabled_count=len(enabled),
        configured_count=0,
        key_state="missing",
    )


def _check_speed_test_config(profile: Any) -> DoctorCheck:
    speed = profile.speed_test
    invalid: list[str] = []
    if speed.timeout_seconds < 1:
        invalid.append("timeout_seconds")
    if speed.concurrency < 1:
        invalid.append("concurrency")
    if speed.min_download_mb_s < 0:
        invalid.append("min_download_mb_s")
    if speed.max_download_bytes < 1:
        invalid.append("max_download_bytes")
    if not speed.probe_url.strip():
        invalid.append("probe_url")
    if invalid:
        return _check("speed_test_config", "fail", "Speed test settings are invalid", invalid_fields=invalid)
    return _check(
        "speed_test_config",
        "pass",
        "Speed test settings are valid",
        speed_url_count=len(speed.urls),
        has_probe_url=bool(speed.probe_url.strip()),
    )


def _check_proxy_runtime() -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    mihomo = shutil.which("mihomo")
    if not mihomo:
        checks.append(_check("mihomo", "fail", "mihomo binary is missing"))
    else:
        ok, version = _safe_run([mihomo, "-v"])
        checks.append(
            _check(
                "mihomo",
                "pass" if ok else "fail",
                "mihomo is executable" if ok else "mihomo version command failed",
                path=mihomo,
                version=version,
            )
        )

    checks.append(
        _check(
            "localhost_port",
            "pass" if _can_bind_localhost() else "fail",
            "Localhost port binding works" if _can_bind_localhost() else "Localhost port binding failed",
        )
    )

    proxy_keys = [
        key
        for key in (
            "VPN_AUTOMATION_UPSTREAM_PROXY",
            "VPN_AUTOMATION_DEPLOY_PROXY",
            "VPN_AUTOMATION_CLOUDFLARE_PROXY",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
        )
        if os.environ.get(key)
    ]
    checks.append(
        _check(
            "proxy_environment",
            "pass",
            "Proxy environment inspected",
            configured_keys=proxy_keys,
        )
    )
    return checks


def _check_node_tools(project_root: Path) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    missing = [name for name in ("node", "npm", "npx") if not shutil.which(name)]
    checks.append(
        _check(
            "node_binaries",
            "fail" if missing else "pass",
            "Node.js command line tools are available" if not missing else "Node.js command line tools are missing",
            missing=missing,
        )
    )

    node_modules = [
        project_root / "node_modules" / "playwright",
        project_root / "electron" / "runtime" / "node-vendor" / "node_modules" / "playwright",
    ]
    has_playwright = any(path.exists() for path in node_modules)
    checks.append(
        _check(
            "playwright",
            "pass" if has_playwright else "warn",
            "Playwright package is installed"
            if has_playwright
            else "Playwright package was not found; run npx playwright install --with-deps chromium-headless-shell",
        )
    )

    browser_ready, browser_message = _playwright_browser_ready(project_root)
    checks.append(
        _check(
            "playwright_browser",
            "pass" if browser_ready else "warn",
            browser_message
            if browser_ready
            else f"{browser_message}; run npx playwright install --with-deps chromium-headless-shell",
        )
    )

    try:
        obfuscator = resolve_managed_npm_tool(JAVASCRIPT_OBFUSCATOR, project_root=project_root)
        checks.append(
            _check(
                "javascript_obfuscator",
                "pass",
                "javascript-obfuscator is available",
                source=obfuscator.source,
                version=obfuscator.version,
                path=str(obfuscator.executable),
            )
        )
    except ManagedToolError as exc:
        checks.append(_check("javascript_obfuscator", "fail", str(exc)))
    return checks


def _check_cloudflare(
    profile: Any,
    runtime_env: dict[str, str],
    *,
    project_root: Path,
    deploy: bool,
) -> list[DoctorCheck]:
    checks: list[DoctorCheck] = []
    has_credentials = _has_cloudflare_credentials(profile, runtime_env)
    if has_credentials:
        checks.append(
            _check(
                "cloudflare_credentials",
                "pass",
                "Cloudflare credentials are configured",
                auth_state="set",
                deploy_required=deploy,
            )
        )
    else:
        checks.append(
            _check(
                "cloudflare_credentials",
                "fail" if deploy else "warn",
                "Cloudflare credentials are missing",
                auth_state="missing",
                deploy_required=deploy,
            )
        )

    account_id = getattr(profile.deploy, "account_id", "") or runtime_env.get("CLOUDFLARE_ACCOUNT_ID", "")
    checks.append(
        _check(
            "cloudflare_account",
            "pass" if account_id else ("fail" if deploy else "warn"),
            "Cloudflare account ID is configured" if account_id else "Cloudflare account ID is missing",
            account_state="set" if account_id else "missing",
            deploy_required=deploy,
        )
    )

    project_name = str(getattr(profile.deploy, "project_name", "")).strip()
    pages_url = str(getattr(profile.deploy, "pages_project_url", "")).strip()
    parsed_pages = urlparse(pages_url)
    pages_consistent = bool(project_name and parsed_pages.scheme and parsed_pages.netloc)
    checks.append(
        _check(
            "deploy_urls",
            "pass" if pages_consistent else ("fail" if deploy else "warn"),
            "Deploy URL settings are internally consistent"
            if pages_consistent
            else "Deploy URL settings are incomplete",
            has_project_name=bool(project_name),
            has_pages_url=bool(parsed_pages.scheme and parsed_pages.netloc),
        )
    )

    try:
        wrangler = resolve_managed_npm_tool(WRANGLER, project_root=project_root)
        checks.append(
            _check(
                "wrangler",
                "pass",
                "Wrangler Pages deploy command is available",
                source=wrangler.source,
                version=wrangler.version,
                path=str(wrangler.executable),
                deploy_required=deploy,
            )
        )
    except ManagedToolError as exc:
        checks.append(_check("wrangler", "fail" if deploy else "warn", str(exc), deploy_required=deploy))
    return checks


def _check_network(profile: Any) -> DoctorCheck:
    urls: list[tuple[str, str]] = []
    if profile.speed_test.probe_url.strip():
        urls.append(("speed_probe", profile.speed_test.probe_url.strip()))
    for index, url in enumerate(profile.speed_test.urls):
        if str(url).strip():
            urls.append((f"speed_url_{index + 1}", str(url).strip()))
    for name, target in profile.availability_targets.items():
        if getattr(target, "enabled", False) and str(getattr(target, "url", "")).strip():
            urls.append((f"availability_{name}", str(target.url).strip()))

    if not urls:
        return _check("network_reachability", "warn", "No network URLs are configured", checked_count=0, failed_count=0)

    failures: list[str] = []
    for label, url in urls[:8]:
        ok, _message = _url_reachable(url)
        if not ok:
            failures.append(label)
    if failures:
        return _check(
            "network_reachability",
            "fail",
            "One or more configured network URLs are unreachable",
            checked_count=len(urls[:8]),
            failed_count=len(failures),
            failed_labels=failures,
        )
    return _check(
        "network_reachability",
        "pass",
        "Configured network URLs are reachable",
        checked_count=len(urls[:8]),
        failed_count=0,
    )


def run_doctor(project_root: Path, *, deploy: bool = False, strict: bool = False) -> tuple[int, dict[str, Any]]:
    checks: list[DoctorCheck] = []
    checks.extend(_check_python_runtime(project_root))
    path_checks, profile = _check_paths(project_root)
    checks.extend(path_checks)
    checks.append(_check_sources(profile))
    checks.append(_check_speed_test_config(profile))
    checks.extend(_check_proxy_runtime())
    checks.extend(_check_node_tools(project_root))
    checks.append(_check_network(profile))
    checks.extend(_check_cloudflare(profile, _runtime_env(project_root), project_root=project_root, deploy=deploy))

    has_failures = any(check.status == "fail" for check in checks)
    has_warnings = any(check.status == "warn" for check in checks)
    ok = not has_failures and not (strict and has_warnings)
    payload = {
        "ok": ok,
        "deploy": deploy,
        "strict": strict,
        "project_root": str(project_root),
        "checks": [asdict(check) for check in checks],
    }
    return (0 if ok else 1), payload


def render_human(payload: dict[str, Any]) -> str:
    lines = []
    for check in payload["checks"]:
        lines.append(f"[{check['status']}] {check['name']}: {check['message']}")
    lines.append(f"[{'pass' if payload['ok'] else 'fail'}] doctor: {'ready' if payload['ok'] else 'not ready'}")
    return "\n".join(lines)


def render_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)
