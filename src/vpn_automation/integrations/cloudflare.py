import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests

from vpn_automation.config.models import DeployConfig, resolve_repo_anchor
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
BLOCKED_PAGES_MARKERS = (
    "8000119",
    "your pages project has been blocked",
    "pages project has been blocked",
    "contact abusereply@cloudflare.com",
)
PAGES_PRODUCTION_BRANCH = "main"
PAGES_SECRET_ENV_PREFIX = "VPN_AUTOMATION_PAGES_SECRET_"
FALLBACK_SUFFIX_PATTERN = re.compile(r"^(?P<prefix>.+)-(?P<suffix>\d+)$")


@dataclass(frozen=True)
class CloudflareCredentials:
    auth_mode: str = "api_token"
    api_token: str = ""
    account_id: str = ""
    email: str = ""
    global_api_key: str = ""


def _clean(value: Any) -> str:
    return str(value or "").strip()


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


def derive_pages_project_url(project_name: str) -> str:
    return f"https://{project_name}.pages.dev"


def build_pages_project_root_url(deploy: DeployConfig | Any) -> str:
    return str(getattr(deploy, "pages_project_url", "") or "").rstrip("/")


def build_custom_domain_root_url(deploy: DeployConfig | Any) -> str:
    custom_domain = _clean(getattr(deploy, "custom_domain", ""))
    if not custom_domain:
        return ""
    return f"https://{custom_domain.rstrip('/')}"


def rewrite_url_host(url: str, hostname: str) -> str:
    parsed = urlsplit(url.strip())
    if not parsed.scheme or not parsed.netloc:
        return ""
    return urlunsplit((parsed.scheme, hostname, parsed.path, parsed.query, parsed.fragment))


def build_custom_domain_subscription_url(deploy: DeployConfig | Any) -> str:
    custom_domain = _clean(getattr(deploy, "custom_domain", ""))
    if not custom_domain:
        return ""

    verify_subscription_url = _clean(getattr(deploy, "verify_subscription_url", ""))
    if verify_subscription_url:
        rewritten = rewrite_url_host(verify_subscription_url, custom_domain)
        return rewritten or verify_subscription_url

    subscription_url = _clean(getattr(deploy, "subscription_url", ""))
    if not subscription_url:
        return ""
    return rewrite_url_host(subscription_url, custom_domain)


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


def is_blocked_pages_error(stdout: str, stderr: str) -> bool:
    combined = "\n".join([stdout, stderr]).lower()
    return any(marker in combined for marker in BLOCKED_PAGES_MARKERS)


def _coerce_non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _split_project_suffix(project_name: str, expected_prefix: str = "") -> tuple[str, int]:
    normalized = _clean(project_name)
    if not normalized:
        return "", 0
    match = FALLBACK_SUFFIX_PATTERN.fullmatch(normalized)
    if not match:
        return normalized, 0
    prefix = match.group("prefix")
    suffix = int(match.group("suffix"))
    if expected_prefix and prefix != expected_prefix:
        return normalized, 0
    return prefix, suffix


def derive_fallback_project_base_name(configured_prefix: str, current_project_name: str) -> str:
    explicit = _clean(configured_prefix)
    if explicit:
        return explicit
    prefix, suffix = _split_project_suffix(current_project_name)
    if prefix and suffix > 0:
        return prefix
    return _clean(current_project_name)


def generate_fallback_project_name(
    base_name: str,
    existing_names: set[str],
    *,
    current_project_name: str = "",
    last_used_suffix: int = 0,
) -> tuple[str, int]:
    normalized = _clean(base_name)
    if not normalized:
        raise RuntimeError("Fallback project base name is empty")
    current_prefix, current_suffix = _split_project_suffix(current_project_name, normalized)
    if current_prefix != normalized:
        current_suffix = 0
    max_existing_suffix = 0
    for existing_name in existing_names:
        existing_prefix, existing_suffix = _split_project_suffix(existing_name, normalized)
        if existing_prefix == normalized:
            max_existing_suffix = max(max_existing_suffix, existing_suffix)
    next_suffix = max(current_suffix, max_existing_suffix, _coerce_non_negative_int(last_used_suffix)) + 1
    while True:
        width = max(2, len(str(next_suffix)))
        candidate = f"{normalized}-{next_suffix:0{width}d}"
        if candidate not in existing_names:
            return candidate, next_suffix
        next_suffix += 1


def resolve_latest_existing_project_name(base_name: str, existing_names: set[str]) -> str:
    normalized = _clean(base_name)
    if not normalized:
        return ""
    if normalized in existing_names:
        return normalized

    latest_name = ""
    latest_suffix = 0
    for existing_name in existing_names:
        existing_prefix, existing_suffix = _split_project_suffix(existing_name, normalized)
        if existing_prefix != normalized or existing_suffix <= 0:
            continue
        if existing_suffix > latest_suffix:
            latest_name = existing_name
            latest_suffix = existing_suffix
    return latest_name


def resolve_cloudflare_credentials(
    deploy: DeployConfig | Any,
    runtime_env: dict[str, str],
    *,
    explicit_api_token: str = "",
) -> CloudflareCredentials:
    auth_mode = _clean(getattr(deploy, "cloudflare_auth_mode", "")) or "api_token"
    account_id = _clean(getattr(deploy, "account_id", "")) or _clean(runtime_env.get("CLOUDFLARE_ACCOUNT_ID"))

    if auth_mode == "global_key":
        email = _clean(getattr(deploy, "cloudflare_email", "")) or _clean(runtime_env.get("CLOUDFLARE_EMAIL"))
        global_api_key = _clean(getattr(deploy, "cloudflare_global_key", "")) or _clean(
            runtime_env.get("CLOUDFLARE_API_KEY")
        )
        if not email or not global_api_key:
            raise RuntimeError("Cloudflare global key credentials are incomplete")
        return CloudflareCredentials(
            auth_mode="global_key",
            account_id=account_id,
            email=email,
            global_api_key=global_api_key,
        )

    api_token = (
        _clean(getattr(deploy, "cloudflare_api_token", ""))
        or _clean(explicit_api_token)
        or _clean(runtime_env.get("CLOUDFLARE_API_TOKEN"))
    )
    if not api_token:
        raise RuntimeError("Cloudflare API token is missing")
    return CloudflareCredentials(
        auth_mode="api_token",
        api_token=api_token,
        account_id=account_id,
    )


def _coerce_credentials(
    deploy: DeployConfig | Any,
    runtime_env: dict[str, str],
    credentials_or_token: CloudflareCredentials | str,
) -> CloudflareCredentials:
    if isinstance(credentials_or_token, CloudflareCredentials):
        return credentials_or_token
    return resolve_cloudflare_credentials(
        deploy,
        runtime_env,
        explicit_api_token=_clean(credentials_or_token),
    )


def _build_proxy_env(proxy_url: str) -> dict[str, str]:
    if not proxy_url:
        return {}
    return {
        "HTTP_PROXY": proxy_url,
        "HTTPS_PROXY": proxy_url,
        "ALL_PROXY": proxy_url,
    }


def build_wrangler_auth_env(credentials: CloudflareCredentials) -> dict[str, str]:
    env: dict[str, str] = {"CI": "1"}
    if credentials.account_id:
        env["CLOUDFLARE_ACCOUNT_ID"] = credentials.account_id
    if credentials.auth_mode == "global_key":
        env["CLOUDFLARE_API_KEY"] = credentials.global_api_key
        env["CLOUDFLARE_EMAIL"] = credentials.email
    else:
        env["CLOUDFLARE_API_TOKEN"] = credentials.api_token
    return env


def _pages_hostname_from_url(url: str) -> str:
    return urlsplit(url.strip()).netloc.strip()


def derive_custom_domain_dns_target(deploy: DeployConfig | Any) -> str:
    return _pages_hostname_from_url(build_pages_project_root_url(deploy))


def resolve_share_project_worker_source_path() -> Path:
    candidates: list[Path] = []
    explicit_path = _clean(os.environ.get("VPN_AUTOMATION_SHARE_WORKER_PATH"))
    if explicit_path:
        candidates.append(Path(explicit_path).expanduser())

    repo_root = resolve_repo_anchor(Path(__file__))
    candidates.append(repo_root / "electron" / "runtime" / "share-worker" / "vpn.js")
    candidates.append(repo_root / "templates" / "share-worker" / "vpn.js")
    candidates.append(repo_root.parent / "cloudflarevpn" / "edgetunnel" / "vpn.js")

    seen: set[str] = set()
    unique_candidates: list[Path] = []
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        unique_candidates.append(candidate)

    for candidate in unique_candidates:
        if candidate.exists():
            return candidate.resolve()

    raise FileNotFoundError(
        "share worker source not found; tried: "
        + ", ".join(str(candidate) for candidate in unique_candidates)
    )


def build_share_project_bundle_dir(source_path: Path) -> Path:
    repo_root = resolve_repo_anchor(Path(__file__))
    return repo_root / "electron" / "runtime" / "share-worker" / "share_pages_bundle"


def build_cloudflare_client(credentials: CloudflareCredentials) -> "CloudflareClient":
    if credentials.auth_mode == "global_key":
        return CloudflareClient(
            account_id=credentials.account_id,
            auth_mode="global_key",
            global_api_key=credentials.global_api_key,
            email=credentials.email,
        )
    return CloudflareClient(
        api_token=credentials.api_token,
        account_id=credentials.account_id,
    )


class CloudflareClient:
    def __init__(
        self,
        api_token: str = "",
        account_id: str = "",
        *,
        auth_mode: str = "api_token",
        global_api_key: str = "",
        email: str = "",
    ) -> None:
        self.api_token = _clean(api_token)
        self.account_id = _clean(account_id)
        self.auth_mode = _clean(auth_mode) or "api_token"
        self.global_api_key = _clean(global_api_key)
        self.email = _clean(email)
        self.session = requests.Session()
        self.session.trust_env = False
        self.session.headers.update(self._build_headers())

    def _build_headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.auth_mode == "global_key":
            headers.update(
                {
                    "X-Auth-Email": self.email,
                    "X-Auth-Key": self.global_api_key,
                }
            )
            return headers
        headers["Authorization"] = f"Bearer {self.api_token}"
        return headers

    def list_accounts(self) -> list[dict[str, Any]]:
        response = self.session.get("https://api.cloudflare.com/client/v4/accounts", timeout=20)
        response.raise_for_status()
        return response.json()["result"]

    def resolve_account_id(self) -> str:
        if self.account_id:
            return self.account_id
        accounts = self.list_accounts()
        if not accounts:
            raise RuntimeError("No Cloudflare account available for the supplied credentials")
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
        account_id = self.resolve_account_id()
        response = self.session.get(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}",
            timeout=20,
        )
        if response.status_code == 404:
            raise RuntimeError(f"Cloudflare Pages project not found: {project_name}")
        response.raise_for_status()
        return response.json()["result"]

    def create_pages_project(self, project_name: str) -> dict[str, Any]:
        account_id = self.resolve_account_id()
        response = self.session.post(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects",
            json={"name": project_name, "production_branch": PAGES_PRODUCTION_BRANCH},
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def delete_pages_project(self, project_name: str) -> dict[str, Any]:
        account_id = self.resolve_account_id()
        response = self.session.delete(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}",
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    def update_pages_project(self, project_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        account_id = self.resolve_account_id()
        response = self.session.patch(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}",
            json=payload,
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def list_pages_domains(self, project_name: str) -> list[dict[str, Any]]:
        account_id = self.resolve_account_id()
        response = self.session.get(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/domains",
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def attach_custom_domain(self, project_name: str, domain: str) -> dict[str, Any]:
        account_id = self.resolve_account_id()
        response = self.session.post(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/domains",
            json={"name": domain},
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def detach_custom_domain(self, project_name: str, domain: str) -> dict[str, Any]:
        account_id = self.resolve_account_id()
        response = self.session.delete(
            f"https://api.cloudflare.com/client/v4/accounts/{account_id}/pages/projects/{project_name}/domains/{domain}",
            timeout=20,
        )
        response.raise_for_status()
        return response.json()

    def list_zones(self, name: str = "") -> list[dict[str, Any]]:
        params = {"name": name} if name else None
        response = self.session.get(
            "https://api.cloudflare.com/client/v4/zones",
            params=params,
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def resolve_zone_for_hostname(self, hostname: str) -> dict[str, Any]:
        normalized = _clean(hostname).rstrip(".").lower()
        labels = [label for label in normalized.split(".") if label]
        start_index = 0 if len(labels) <= 2 else 1
        for index in range(start_index, len(labels) - 1):
            candidate = ".".join(labels[index:])
            if "." not in candidate:
                continue
            zones = self.list_zones(candidate)
            for zone in zones:
                if _clean(zone.get("name")).lower() == candidate:
                    return zone
        raise RuntimeError(f"Cloudflare zone not found for hostname: {hostname}")

    def list_dns_records(self, zone_id: str, hostname: str) -> list[dict[str, Any]]:
        response = self.session.get(
            f"https://api.cloudflare.com/client/v4/zones/{zone_id}/dns_records",
            params={"name": hostname},
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def upsert_subdomain_cname(self, hostname: str, target: str, proxied: bool = True) -> dict[str, Any]:
        normalized_host = _clean(hostname).rstrip(".").lower()
        normalized_target = _clean(target).rstrip(".").lower()
        zone = self.resolve_zone_for_hostname(normalized_host)
        zone_name = _clean(zone.get("name")).lower()
        if normalized_host == zone_name:
            raise RuntimeError("Apex custom domains require a different DNS strategy than CNAME")

        records = self.list_dns_records(str(zone["id"]), normalized_host)
        conflicting = [record for record in records if _clean(record.get("type")).upper() != "CNAME"]
        if conflicting:
            raise RuntimeError(f"Conflicting non-CNAME DNS records exist for {normalized_host}")

        cname_records = [record for record in records if _clean(record.get("type")).upper() == "CNAME"]
        payload = {
            "type": "CNAME",
            "name": normalized_host,
            "content": normalized_target,
            "proxied": proxied,
        }
        if not cname_records:
            response = self.session.post(
                f"https://api.cloudflare.com/client/v4/zones/{zone['id']}/dns_records",
                json=payload,
                timeout=20,
            )
            response.raise_for_status()
            return response.json()["result"]

        if len(cname_records) > 1:
            raise RuntimeError(f"Multiple CNAME records exist for {normalized_host}")

        current = cname_records[0]
        if (
            _clean(current.get("content")).rstrip(".").lower() == normalized_target
            and bool(current.get("proxied")) is proxied
        ):
            return current

        response = self.session.patch(
            f"https://api.cloudflare.com/client/v4/zones/{zone['id']}/dns_records/{current['id']}",
            json=payload,
            timeout=20,
        )
        response.raise_for_status()
        return response.json()["result"]

    def verify_subdomain_cname(self, hostname: str, target: str) -> bool:
        normalized_host = _clean(hostname).rstrip(".").lower()
        normalized_target = _clean(target).rstrip(".").lower()
        zone = self.resolve_zone_for_hostname(normalized_host)
        records = self.list_dns_records(str(zone["id"]), normalized_host)
        return any(
            _clean(record.get("type")).upper() == "CNAME"
            and _clean(record.get("name")).rstrip(".").lower() == normalized_host
            and _clean(record.get("content")).rstrip(".").lower() == normalized_target
            for record in records
        )

    def copy_pages_project_config(
        self,
        source_project_name: str,
        target_project_name: str,
        runtime_env: dict[str, str],
    ) -> dict[str, Any]:
        source_project = self.get_pages_project(source_project_name)
        deployment_configs = source_project.get("deployment_configs", {})
        payload = {
            "deployment_configs": {
                environment_name: _build_clone_deployment_config(config, runtime_env)
                for environment_name, config in deployment_configs.items()
            }
        }
        return self.update_pages_project(target_project_name, payload)

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


def _resolve_pages_secret_value(secret_name: str, runtime_env: dict[str, str]) -> str:
    if secret_name == "ADMIN":
        configured_default = _clean(runtime_env.get("VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN")) or "swimmingliu"
    else:
        configured_default = ""
    for key in (f"{PAGES_SECRET_ENV_PREFIX}{secret_name}", secret_name):
        value = _clean(runtime_env.get(key))
        if not value:
            value = _clean(os.environ.get(key))
        if value:
            return value
    if configured_default:
        return configured_default
    raise RuntimeError(
        f"Missing Pages secret value for {secret_name}; set {PAGES_SECRET_ENV_PREFIX}{secret_name} or {secret_name}"
    )


def _build_clone_env_vars(env_vars: dict[str, dict[str, Any]], runtime_env: dict[str, str]) -> dict[str, dict[str, Any]]:
    cloned: dict[str, dict[str, Any]] = {}
    for name, payload in env_vars.items():
        value_type = str(payload.get("type", "plain_text"))
        if value_type == "secret_text":
            cloned[name] = {"type": "secret_text", "value": _resolve_pages_secret_value(name, runtime_env)}
            continue
        cloned[name] = {"type": value_type, "value": payload.get("value", "")}
    return cloned


def _build_clone_deployment_config(config: dict[str, Any], runtime_env: dict[str, str]) -> dict[str, Any]:
    cloned: dict[str, Any] = {}
    if config.get("env_vars"):
        cloned["env_vars"] = _build_clone_env_vars(config["env_vars"], runtime_env)
    if config.get("kv_namespaces"):
        cloned["kv_namespaces"] = config["kv_namespaces"]
    for key in (
        "compatibility_date",
        "compatibility_flags",
        "build_image_major_version",
        "usage_model",
        "fail_open",
        "always_use_latest_compatibility_date",
    ):
        if key in config:
            cloned[key] = config[key]
    return cloned


def _clone_project_deployment_configs(
    project_payload: dict[str, Any],
    runtime_env: dict[str, str],
) -> dict[str, Any]:
    deployment_configs = project_payload.get("deployment_configs", {})
    return {
        environment_name: _build_clone_deployment_config(config, runtime_env)
        for environment_name, config in deployment_configs.items()
    }


def _rewrite_share_project_sub_value(
    deployment_configs: dict[str, Any],
    *,
    env_key: str,
    sub_value: str,
) -> dict[str, Any]:
    rewritten = {
        environment_name: dict(config)
        for environment_name, config in deployment_configs.items()
    }
    for environment_name in ("preview", "production"):
        env_config = dict(rewritten.get(environment_name, {}))
        env_vars = dict(env_config.get("env_vars", {}))
        env_vars[env_key] = {"type": "plain_text", "value": sub_value}
        env_config["env_vars"] = env_vars
        rewritten[environment_name] = env_config
    return rewritten


def _build_share_project_update_payload(
    source_project: dict[str, Any],
    runtime_env: dict[str, str],
    *,
    env_key: str,
    sub_value: str,
) -> dict[str, Any]:
    cloned_configs = _clone_project_deployment_configs(source_project, runtime_env)
    return {
        "deployment_configs": _rewrite_share_project_sub_value(
            cloned_configs,
            env_key=env_key,
            sub_value=sub_value,
        )
    }


def _sync_share_project_sub(
    client: CloudflareClient,
    deploy: DeployConfig | Any,
    runtime_env: dict[str, str],
    credentials: CloudflareCredentials,
    bundle_dir: Path,
    *,
    pages_project_url: str,
) -> dict[str, Any]:
    requested_name = _clean(getattr(deploy, "share_project_name", ""))
    env_key = _clean(getattr(deploy, "share_project_sub_env_key", "")) or "SUB"
    sub_value = build_secret_url(
        DeployConfig(
            project_name=_clean(getattr(deploy, "project_name", "")) or "",
            subscription_url=_clean(getattr(deploy, "subscription_url", "")) or pages_project_url,
            verify_subscription_url=_clean(getattr(deploy, "verify_subscription_url", "")),
            pages_project_url=pages_project_url,
            custom_domain=_clean(getattr(deploy, "custom_domain", "")),
            secret_query=_clean(getattr(deploy, "secret_query", "")) or "serect_key=swimmingliu",
            cloudflare_auth_mode=_clean(getattr(deploy, "cloudflare_auth_mode", "")) or "api_token",
            cloudflare_api_token=_clean(getattr(deploy, "cloudflare_api_token", "")),
            cloudflare_global_key=_clean(getattr(deploy, "cloudflare_global_key", "")),
            cloudflare_email=_clean(getattr(deploy, "cloudflare_email", "")),
            account_id=_clean(getattr(deploy, "account_id", "")),
        )
    )
    share_auto_fallback = bool(getattr(deploy, "share_project_auto_fallback", True))
    share_last_used_suffix = _coerce_non_negative_int(
        getattr(deploy, "share_project_fallback_last_used_suffix", 0)
    )

    result = {
        "share_project_requested_name": requested_name,
        "share_project_name": requested_name,
        "share_project_fallback_used": False,
        "share_project_cleanup_blocked_project": "",
        "share_project_sub_value": sub_value if requested_name else "",
        "share_project_sync_ok": True,
        "share_project_sync_error": "",
        "share_project_fallback_candidate_names": [],
        "share_project_fallback_last_used_suffix": share_last_used_suffix,
    }
    if not requested_name:
        return result

    try:
        source_project = client.get_pages_project(requested_name)
    except Exception as exc:
        error_message = str(exc)
        if not share_auto_fallback or "not found" not in error_message.lower():
            result["share_project_sync_ok"] = False
            result["share_project_sync_error"] = error_message
            return result

        existing_names = {project["name"] for project in client.list_pages_projects()}
        recovered_name = resolve_latest_existing_project_name(
            derive_fallback_project_base_name(
                _clean(getattr(deploy, "share_project_fallback_prefix", "")),
                requested_name,
            ),
            existing_names,
        )
        if not recovered_name:
            result["share_project_sync_ok"] = False
            result["share_project_sync_error"] = error_message
            return result
        requested_name = recovered_name
        result["share_project_name"] = recovered_name
        source_project = client.get_pages_project(requested_name)

    payload = _build_share_project_update_payload(
        source_project,
        runtime_env,
        env_key=env_key,
        sub_value=sub_value,
    )
    share_worker_source_path = resolve_share_project_worker_source_path()
    share_bundle_dir = build_share_project_bundle_dir(share_worker_source_path)
    share_bundle_dir.mkdir(parents=True, exist_ok=True)
    share_worker_entry = share_bundle_dir / "_worker.js"
    share_worker_entry.write_text(share_worker_source_path.read_text(encoding="utf-8"), encoding="utf-8")
    result["share_project_source_path"] = str(share_worker_source_path)
    result["share_project_bundle_dir"] = str(share_bundle_dir)
    result["share_project_worker_entry"] = str(share_worker_entry)
    share_custom_domains = [
        _clean(item.get("name"))
        for item in client.list_pages_domains(requested_name)
    ] if hasattr(client, "list_pages_domains") else []

    def fallback_share_project(existing_names: set[str]) -> dict[str, Any]:
        fallback_base_name = derive_fallback_project_base_name(
            _clean(getattr(deploy, "share_project_fallback_prefix", "")),
            requested_name,
        )
        fallback_name, used_suffix = generate_fallback_project_name(
            fallback_base_name,
            existing_names,
            current_project_name=requested_name,
            last_used_suffix=share_last_used_suffix,
        )
        result["share_project_fallback_candidate_names"] = [fallback_name]
        client.create_pages_project(fallback_name)
        client.copy_pages_project_config(requested_name, fallback_name, runtime_env)
        client.update_pages_project(fallback_name, payload)
        for domain in share_custom_domains:
            if domain:
                _ensure_custom_domain_bound(
                    client,
                    fallback_name,
                    domain,
                    previous_project_name=requested_name,
                )
                client.upsert_subdomain_cname(domain, f"{fallback_name}.pages.dev", proxied=False)
        redeploy_result, redeploy_attempts = _run_pages_deploy_attempts(
            build_pages_deploy_command(share_bundle_dir, fallback_name),
            build_wrangler_auth_env(credentials),
            resolve_deploy_proxy_url(share_bundle_dir),
            cwd=str(share_bundle_dir),
        )
        if redeploy_result.returncode != 0:
            result["share_project_sync_ok"] = False
            result["share_project_sync_error"] = redeploy_result.stderr or redeploy_result.stdout
            result["share_project_redeploy_attempts"] = redeploy_attempts
            return result
        result.update(
            {
                "share_project_name": fallback_name,
                "share_project_fallback_used": True,
                "share_project_cleanup_blocked_project": requested_name,
                "share_project_sync_ok": True,
                "share_project_sync_error": "",
                "share_project_fallback_last_used_suffix": used_suffix,
                "share_project_redeploy_attempts": redeploy_attempts,
            }
        )
        return result

    try:
        client.update_pages_project(requested_name, payload)
        redeploy_result, redeploy_attempts = _run_pages_deploy_attempts(
            build_pages_deploy_command(share_bundle_dir, requested_name),
            build_wrangler_auth_env(credentials),
            resolve_deploy_proxy_url(share_bundle_dir),
            cwd=str(share_bundle_dir),
        )
        if redeploy_result.returncode != 0:
            if share_auto_fallback and is_blocked_pages_error(redeploy_result.stdout, redeploy_result.stderr):
                existing_names = {project["name"] for project in client.list_pages_projects()}
                return fallback_share_project(existing_names)
            result["share_project_sync_ok"] = False
            result["share_project_sync_error"] = redeploy_result.stderr or redeploy_result.stdout
        result["share_project_redeploy_attempts"] = redeploy_attempts
        return result
    except Exception as exc:
        if not share_auto_fallback or not is_blocked_pages_error(str(exc), ""):
            result["share_project_sync_ok"] = False
            result["share_project_sync_error"] = str(exc)
            return result

    existing_names = {project["name"] for project in client.list_pages_projects()}
    return fallback_share_project(existing_names)


def _run_pages_deploy_attempts(
    command: list[str],
    base_env: dict[str, str],
    proxy_url: str,
    *,
    cwd: str,
) -> tuple[Any, list[dict[str, Any]]]:
    attempts = [
        ("direct", base_env),
        ("direct-retry", base_env),
    ]
    if proxy_url:
        attempts.append(("proxy", {**base_env, **_build_proxy_env(proxy_url)}))

    result = None
    attempt_log: list[dict[str, Any]] = []
    for index, (mode, env) in enumerate(attempts):
        result = run_command(command, cwd=cwd, env=env)
        attempt_log.append({"mode": mode, "returncode": result.returncode})
        if result.returncode == 0:
            break
        if not _is_transient_deploy_failure(result.stdout, result.stderr):
            break
        if index == len(attempts) - 1:
            break
    assert result is not None
    return result, attempt_log


def _ensure_custom_domain_bound(
    client: CloudflareClient,
    project_name: str,
    custom_domain: str,
    *,
    previous_project_name: str = "",
) -> None:
    if not custom_domain:
        return
    current_domains: set[str] = set()
    if hasattr(client, "list_pages_domains"):
        current_domains = {
            _clean(item.get("name")).lower()
            for item in client.list_pages_domains(project_name)
        }
        if custom_domain.lower() in current_domains:
            return
    try:
        client.attach_custom_domain(project_name, custom_domain)
    except Exception:
        if previous_project_name and previous_project_name != project_name:
            client.detach_custom_domain(previous_project_name, custom_domain)
            client.attach_custom_domain(project_name, custom_domain)
            return
        raise


def deploy_pages_bundle(
    bundle_dir: Path,
    deploy: DeployConfig,
    api_token: CloudflareCredentials | str,
) -> dict[str, Any]:
    requested_project_name = deploy.project_name
    runtime_env = {
        **load_runtime_env(bundle_dir),
        "VPN_AUTOMATION_DEFAULT_PAGES_SECRET_ADMIN": _clean(getattr(deploy, "pages_secret_admin", "")) or "swimmingliu",
    }
    credentials = _coerce_credentials(deploy, runtime_env, api_token)
    command = build_pages_deploy_command(bundle_dir, requested_project_name)
    base_env = build_wrangler_auth_env(credentials)
    proxy_url = resolve_deploy_proxy_url(bundle_dir)
    result, attempt_log = _run_pages_deploy_attempts(command, base_env, proxy_url, cwd=str(bundle_dir))
    final_project_name = requested_project_name
    final_pages_project_url = _clean(getattr(deploy, "pages_project_url", "")) or derive_pages_project_url(
        requested_project_name
    )
    fallback_used = False
    custom_domain = _clean(getattr(deploy, "custom_domain", ""))
    cleanup_blocked_project = ""
    fallback_candidate_names: list[str] = []
    dns_error = ""
    dns_target = ""
    share_sync_error = ""
    client: CloudflareClient | None = None
    custom_domain_bound = False
    final_fallback_last_used_suffix = _coerce_non_negative_int(getattr(deploy, "fallback_last_used_suffix", 0))
    share_sync_result = {
        "share_project_requested_name": _clean(getattr(deploy, "share_project_name", "")),
        "share_project_name": _clean(getattr(deploy, "share_project_name", "")),
        "share_project_fallback_used": False,
        "share_project_cleanup_blocked_project": "",
        "share_project_sub_value": "",
        "share_project_sync_ok": True,
        "share_project_sync_error": "",
        "share_project_fallback_candidate_names": [],
        "share_project_fallback_last_used_suffix": _coerce_non_negative_int(
            getattr(deploy, "share_project_fallback_last_used_suffix", 0)
        ),
    }

    if (
        result.returncode != 0
        and deploy.auto_create_project_on_blocked
        and is_blocked_pages_error(result.stdout, result.stderr)
    ):
        client = build_cloudflare_client(credentials)
        existing_names = {project["name"] for project in client.list_pages_projects()}
        fallback_base_name = derive_fallback_project_base_name(
            _clean(getattr(deploy, "fallback_project_prefix", "")),
            requested_project_name,
        )
        final_project_name, final_fallback_last_used_suffix = generate_fallback_project_name(
            fallback_base_name,
            existing_names,
            current_project_name=requested_project_name,
            last_used_suffix=final_fallback_last_used_suffix,
        )
        fallback_candidate_names.append(final_project_name)
        client.create_pages_project(final_project_name)
        client.copy_pages_project_config(requested_project_name, final_project_name, runtime_env)
        if custom_domain:
            _ensure_custom_domain_bound(
                client,
                final_project_name,
                custom_domain,
                previous_project_name=requested_project_name,
            )
            custom_domain_bound = True
        command = build_pages_deploy_command(bundle_dir, final_project_name)
        result, fallback_attempts = _run_pages_deploy_attempts(command, base_env, proxy_url, cwd=str(bundle_dir))
        attempt_log.extend(
            {"mode": f"fallback-{attempt['mode']}", "returncode": attempt["returncode"]}
            for attempt in fallback_attempts
        )
        final_pages_project_url = derive_pages_project_url(final_project_name)
        fallback_used = True
        cleanup_blocked_project = requested_project_name

    if result.returncode == 0:
        client = client or build_cloudflare_client(credentials)
        share_sync_result = _sync_share_project_sub(
            client,
            deploy,
            runtime_env,
            credentials,
            bundle_dir,
            pages_project_url=final_pages_project_url,
        )
        if not share_sync_result.get("share_project_sync_ok", False):
            share_sync_error = str(share_sync_result.get("share_project_sync_error", "") or "share project sync failed")

    if result.returncode == 0 and custom_domain:
        client = client or build_cloudflare_client(credentials)
        if not custom_domain_bound:
            _ensure_custom_domain_bound(
                client,
                final_project_name,
                custom_domain,
                previous_project_name=requested_project_name if fallback_used else "",
            )
        dns_target = _pages_hostname_from_url(final_pages_project_url) or f"{final_project_name}.pages.dev"
        try:
            client.upsert_subdomain_cname(custom_domain, dns_target, proxied=False)
        except Exception as exc:
            dns_error = str(exc)

    final_returncode = result.returncode if not dns_error and not share_sync_error else 1
    stderr = result.stderr
    if dns_error:
        stderr = f"{stderr}\ncustom domain dns binding failed: {dns_error}".strip()
    if share_sync_error:
        stderr = f"{stderr}\nshare project sync failed: {share_sync_error}".strip()

    deploy.project_name = final_project_name
    deploy.pages_project_url = final_pages_project_url
    deploy.fallback_last_used_suffix = final_fallback_last_used_suffix
    deploy.share_project_fallback_last_used_suffix = int(
        share_sync_result.get("share_project_fallback_last_used_suffix", 0) or 0
    )
    final_share_project_name = _clean(share_sync_result.get("share_project_name", ""))
    if final_share_project_name:
        deploy.share_project_name = final_share_project_name

    return {
        "command": command,
        "returncode": final_returncode,
        "stdout": result.stdout,
        "stderr": stderr,
        "attempts": attempt_log,
        "requested_project_name": requested_project_name,
        "fallback_candidate_names": fallback_candidate_names,
        "cleanup_blocked_project": cleanup_blocked_project if cleanup_blocked_project != final_project_name else "",
        "cleanup_deleted": False,
        "cleanup_errors": [],
        "project_name": final_project_name,
        "pages_project_url": final_pages_project_url,
        "custom_domain": custom_domain,
        "custom_domain_dns_name": custom_domain,
        "custom_domain_dns_target": dns_target,
        "custom_domain_dns_proxied": False if custom_domain and dns_target else False,
        "custom_domain_dns_ok": bool(custom_domain and dns_target and not dns_error),
        "fallback_used": fallback_used,
        "fallback_last_used_suffix": final_fallback_last_used_suffix,
        **share_sync_result,
        "bundle_dir": str(bundle_dir),
        "worker_entry": str(bundle_dir / "_worker.js"),
        "module_manifest_path": str(bundle_dir / "manifest.json"),
    }
