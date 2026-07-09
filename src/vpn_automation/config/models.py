from dataclasses import asdict, dataclass, field
from pathlib import Path
from types import SimpleNamespace


DEFAULT_SOURCE_ORDER = [
    "leiting",
    "heidong",
    "mifeng",
    "xuanfeng-area",
    "xuanfeng-all-area",
]

DEFAULT_AVAILABILITY_TARGET_ORDER = ["gemini", "chatgpt_ios", "chatgpt_web", "claude"]


@dataclass
class SourceConfig:
    url: str
    key: str
    enabled: bool = True
    max_iterations: int = 5_000
    min_iterations: int = 0
    plateau_limit: int = 20
    use_random_area: bool = True
    area_min: int = 0
    area_max: int = 100
    failure_limit: int = 3
    max_runtime_seconds: float = 0.0


@dataclass
class SpeedTestConfig:
    min_download_mb_s: float
    timeout_seconds: int
    concurrency: int
    urls: list[str] = field(default_factory=list)
    probe_url: str = "https://www.gstatic.com/generate_204"
    max_download_bytes: int = 5_000_000
    startup_wait_seconds: float = 1.0
    max_download_candidates: int = 50


@dataclass
class AvailabilityTargetConfig:
    url: str
    enabled: bool = True
    allowed_hosts: list[str] = field(default_factory=list)
    negative_phrases: list[str] = field(default_factory=list)


@dataclass
class DeployConfig:
    project_name: str
    subscription_url: str
    verify_subscription_url: str = "https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc"
    pages_project_url: str = "https://sub-nodes.pages.dev"
    custom_domain: str = ""
    secret_query: str = "serect_key=swimmingliu"
    cloudflare_auth_mode: str = "api_token"
    cloudflare_api_token: str = ""
    cloudflare_global_key: str = ""
    cloudflare_email: str = ""
    account_id: str = "e743286b4304e96ee8795d62917052aa"
    use_wrangler: bool = True
    auto_create_project_on_blocked: bool = True
    fallback_project_prefix: str = ""
    share_project_name: str = "sub-links-share-03"
    share_project_auto_fallback: bool = True
    share_project_fallback_prefix: str = "sub-links-share"
    share_project_sub_env_key: str = "SUB"
    pages_secret_admin: str = "swimmingliu"
    fallback_last_used_suffix: int = 0
    share_project_fallback_last_used_suffix: int = 0


@dataclass
class WorkerBuildConfig:
    environment_name: str = "production"
    entry_filename: str = "_worker.js"
    bundle_subdir: str = "pages_bundle"
    modules_subdir: str = "modules"
    manifest_filename: str = "manifest.json"
    variable_prefix: str = "sg"
    comment_template: str = "subscription worker: returns encoded payload on secret match, random bytes otherwise"
    random_noise_min_length: int = 24
    random_noise_max_length: int = 96
    enable_keyword_fragmentation: bool = True
    enable_identifier_randomization: bool = True
    emit_sidecar_modules: bool = True


@dataclass
class FilterConfig:
    excluded_country_codes: list[str] = field(default_factory=lambda: ["CN"])
    per_country_limit: dict[str, int] = field(default_factory=dict)


def _default_workspace_compat(project_root: Path | None = None) -> SimpleNamespace:
    if project_root is None:
        project_root = resolve_repo_anchor(Path(__file__))
    project_root = project_root.resolve()
    workspace_root = project_root.parent
    return SimpleNamespace(
        project_root=str(project_root),
        workspace_root=str(workspace_root),
        vpn_catch_nodes_root=str(workspace_root / "vpn-catch-nodes"),
        edgetunnel_root=str(workspace_root / "cloudflarevpn" / "edgetunnel"),
        artifacts_root=str(project_root / "artifacts"),
        state_root=str(project_root / "state"),
        env_file=str(project_root / ".env"),
        build_root=str(project_root / "build"),
    )


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig
    worker_build: WorkerBuildConfig = field(default_factory=WorkerBuildConfig)
    availability_targets: dict[str, AvailabilityTargetConfig] = field(default_factory=dict)
    filters: FilterConfig = field(default_factory=FilterConfig)

    def __post_init__(self) -> None:
        self._workspace_compat = _default_workspace_compat()
        if not self.availability_targets:
            self.availability_targets = default_availability_targets()

    @property
    def workspace(self) -> SimpleNamespace:
        return self._workspace_compat

    def set_workspace_compat(self, project_root: Path) -> None:
        self._workspace_compat = _default_workspace_compat(project_root)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "AppProfile":
        sources = default_sources()
        for name, value in data.get("sources", {}).items():
            sources[name] = _normalize_source_config(name, value)
        if "availability_targets" in data:
            availability_targets = {
                name: _normalize_availability_target_config(name, value)
                for name, value in data.get("availability_targets", {}).items()
            }
            availability_targets = _migrate_default_availability_targets(availability_targets)
        else:
            availability_targets = default_availability_targets()
        profile = cls(
            sources=sources,
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
            worker_build=WorkerBuildConfig(**data.get("worker_build", {})),
            availability_targets=availability_targets,
            filters=FilterConfig(**data.get("filters", {})),
        )
        return profile


def resolve_repo_anchor(candidate: Path) -> Path:
    resolved = candidate.resolve()
    if ".worktrees" in resolved.parts:
        index = resolved.parts.index(".worktrees")
        return Path(*resolved.parts[:index])

    if resolved.exists():
        current = resolved if resolved.is_dir() else resolved.parent
    else:
        current = resolved if resolved.suffix == "" else resolved.parent
    for path in [current, *current.parents]:
        if (path / "pyproject.toml").exists():
            return path
    return current


def _default_use_random_area(source_name: str) -> bool:
    return source_name == "xuanfeng-all-area"


def _default_source_config(source_name: str) -> SourceConfig:
    source_defaults = {
        "leiting": SourceConfig(url="", key="", enabled=True, max_iterations=5_000, min_iterations=10_000),
        "heidong": SourceConfig(url="", key="", enabled=True, max_iterations=5_000, min_iterations=15_000),
        "mifeng": SourceConfig(url="", key="", enabled=True, max_iterations=5_000, min_iterations=20_000),
        "xuanfeng-area": SourceConfig(
            url="",
            key="",
            enabled=True,
            max_iterations=5_000,
            min_iterations=10_000,
            use_random_area=False,
        ),
        "xuanfeng-all-area": SourceConfig(
            url="",
            key="",
            enabled=True,
            max_iterations=5_000,
            min_iterations=25_000,
            use_random_area=True,
        ),
    }
    return source_defaults[source_name]


def default_sources() -> dict[str, SourceConfig]:
    return {
        name: _default_source_config(name)
        for name in DEFAULT_SOURCE_ORDER
    }


def _default_availability_target_config(target_name: str) -> AvailabilityTargetConfig:
    target_defaults = {
        "gemini": AvailabilityTargetConfig(
            url="https://gemini.google.com",
            enabled=True,
            allowed_hosts=["gemini.google.com"],
            negative_phrases=[],
        ),
        "chatgpt_ios": AvailabilityTargetConfig(
            url="https://ios.chat.openai.com/",
            enabled=True,
            allowed_hosts=["ios.chat.openai.com"],
            negative_phrases=[],
        ),
        "chatgpt_web": AvailabilityTargetConfig(
            url="https://api.openai.com/compliance/cookie_requirements",
            enabled=True,
            allowed_hosts=["api.openai.com"],
            negative_phrases=[],
        ),
        "claude": AvailabilityTargetConfig(
            url="https://claude.ai/cdn-cgi/trace",
            enabled=True,
            allowed_hosts=["claude.ai"],
            negative_phrases=[],
        ),
    }
    return target_defaults[target_name]


def default_availability_targets() -> dict[str, AvailabilityTargetConfig]:
    return {
        name: _default_availability_target_config(name)
        for name in DEFAULT_AVAILABILITY_TARGET_ORDER
    }


def _migrate_default_availability_targets(
    targets: dict[str, AvailabilityTargetConfig],
) -> dict[str, AvailabilityTargetConfig]:
    migrated = dict(targets)
    legacy_chatgpt = migrated.pop("chatgpt", None)
    if legacy_chatgpt is not None:
        chatgpt_ios_default = _default_availability_target_config("chatgpt_ios")
        chatgpt_web_default = _default_availability_target_config("chatgpt_web")
        migrated.setdefault(
            "chatgpt_ios",
            AvailabilityTargetConfig(
                url=chatgpt_ios_default.url,
                enabled=legacy_chatgpt.enabled,
            ),
        )
        migrated.setdefault(
            "chatgpt_web",
            AvailabilityTargetConfig(
                url=chatgpt_web_default.url,
                enabled=legacy_chatgpt.enabled,
            ),
        )
    for name in DEFAULT_AVAILABILITY_TARGET_ORDER:
        migrated.setdefault(name, _default_availability_target_config(name))
    return migrated


def _normalize_source_config(source_name: str, payload: dict) -> SourceConfig:
    normalized = dict(payload)
    defaults = _default_source_config(source_name) if source_name in DEFAULT_SOURCE_ORDER else SourceConfig(url="", key="")
    normalized.setdefault("enabled", defaults.enabled)
    normalized.setdefault("max_iterations", defaults.max_iterations)
    normalized.setdefault("min_iterations", defaults.min_iterations)
    normalized.setdefault("plateau_limit", defaults.plateau_limit)
    normalized.setdefault("use_random_area", _default_use_random_area(source_name))
    normalized.setdefault("area_min", defaults.area_min)
    normalized.setdefault("area_max", defaults.area_max)
    normalized.setdefault("failure_limit", defaults.failure_limit)
    normalized.setdefault("max_runtime_seconds", defaults.max_runtime_seconds)
    return SourceConfig(**normalized)


def _normalize_string_list(value: object) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, tuple):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _normalize_availability_target_config(target_name: str, payload: dict) -> AvailabilityTargetConfig:
    defaults = (
        _default_availability_target_config(target_name)
        if target_name in DEFAULT_AVAILABILITY_TARGET_ORDER
        else AvailabilityTargetConfig(url="")
    )
    normalized = dict(payload)
    normalized.setdefault("url", defaults.url)
    normalized.setdefault("enabled", defaults.enabled)
    normalized["allowed_hosts"] = []
    normalized["negative_phrases"] = []
    return AvailabilityTargetConfig(**normalized)


def _load_existing_sources(config_path: Path) -> dict[str, SourceConfig]:
    source_map = default_sources()
    if not config_path.exists():
        return source_map

    import json

    payload = json.loads(config_path.read_text(encoding="utf-8"))
    for name in DEFAULT_SOURCE_ORDER:
        if name not in payload:
            continue
        source_map[name] = _normalize_source_config(
            name,
            {
                "url": str(payload[name].get("url", "")),
                "key": str(payload[name].get("key", "")),
                "enabled": True,
            },
        )
    return source_map


def create_default_profile(project_root: Path) -> AppProfile:
    project_root = resolve_repo_anchor(project_root)
    workspace_root = project_root.parent
    vpn_catch_nodes_root = workspace_root / "vpn-catch-nodes"

    profile = AppProfile(
        sources=_load_existing_sources(vpn_catch_nodes_root / "config" / "vpn_api.json"),
        speed_test=SpeedTestConfig(
            min_download_mb_s=0.5,
            timeout_seconds=20,
            concurrency=3,
            urls=[
                "https://speed.cloudflare.com/__down?bytes=5000000",
                "https://proof.ovh.net/files/10Mb.dat",
                "https://cachefly.cachefly.net/10mb.test",
            ],
            max_download_bytes=5_000_000,
            startup_wait_seconds=1.0,
            max_download_candidates=50,
        ),
        deploy=DeployConfig(
            project_name="sub-nodes",
            subscription_url="https://swimmingliu.online/179ba8dd-3854-4747-b853-fc1868ef3937",
            verify_subscription_url="https://www.swimmingliu.online/sub?token=8410fb43eb2176497f5beafc0c39f5bc",
        ),
        availability_targets=default_availability_targets(),
    )
    profile.set_workspace_compat(project_root)
    return profile
