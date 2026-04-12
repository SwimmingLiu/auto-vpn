import json
from dataclasses import asdict, dataclass, field
from pathlib import Path


DEFAULT_SOURCE_ORDER = [
    "leiting",
    "heidong",
    "mifeng",
    "xuanfeng1",
    "xuanfeng2",
]


@dataclass
class SourceConfig:
    url: str
    key: str
    enabled: bool = True
    max_iterations: int = 40
    plateau_limit: int = 8
    use_random_area: bool = True


@dataclass
class SpeedTestConfig:
    min_download_mb_s: float
    timeout_seconds: int
    concurrency: int
    urls: list[str] = field(default_factory=list)
    probe_url: str = "https://www.gstatic.com/generate_204"
    max_download_bytes: int = 5_000_000
    startup_wait_seconds: float = 1.0


@dataclass
class DeployConfig:
    project_name: str
    subscription_url: str
    pages_project_url: str = "https://vmess2clash.pages.dev"
    secret_query: str = "serect_key=swimmingliu"
    account_id: str = "e743286b4304e96ee8795d62917052aa"
    use_wrangler: bool = True


@dataclass
class FilterConfig:
    excluded_country_codes: list[str] = field(default_factory=lambda: ["CN"])
    per_country_limit: dict[str, int] = field(default_factory=lambda: {"HK": 5, "TW": 5})


@dataclass
class WorkspaceConfig:
    project_root: str
    workspace_root: str
    vpn_catch_nodes_root: str
    edgetunnel_root: str
    artifacts_root: str
    state_root: str
    env_file: str
    build_root: str


def _default_workspace() -> WorkspaceConfig:
    return WorkspaceConfig(
        project_root="",
        workspace_root="",
        vpn_catch_nodes_root="",
        edgetunnel_root="",
        artifacts_root="",
        state_root="",
        env_file="",
        build_root="",
    )


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig
    workspace: WorkspaceConfig = field(default_factory=_default_workspace)
    filters: FilterConfig = field(default_factory=FilterConfig)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "AppProfile":
        return cls(
            sources={name: SourceConfig(**value) for name, value in data["sources"].items()},
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
            workspace=WorkspaceConfig(**data["workspace"]),
            filters=FilterConfig(**data.get("filters", {})),
        )


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


def _load_existing_sources(config_path: Path) -> dict[str, SourceConfig]:
    source_map = {
        name: SourceConfig(url="", key="", enabled=True)
        for name in DEFAULT_SOURCE_ORDER
    }
    if not config_path.exists():
        return source_map

    payload = json.loads(config_path.read_text(encoding="utf-8"))
    for name in DEFAULT_SOURCE_ORDER:
        if name not in payload:
            continue
        source_map[name] = SourceConfig(
            url=str(payload[name].get("url", "")),
            key=str(payload[name].get("key", "")),
            enabled=True,
            use_random_area=name != "xuanfeng1",
        )
    return source_map


def create_default_profile(project_root: Path) -> AppProfile:
    project_root = resolve_repo_anchor(project_root)
    workspace_root = project_root.parent
    vpn_catch_nodes_root = workspace_root / "vpn-catch-nodes"
    edgetunnel_root = workspace_root / "cloudflarevpn" / "edgetunnel"

    sources = _load_existing_sources(vpn_catch_nodes_root / "config" / "vpn_api.json")

    return AppProfile(
        sources=sources,
        speed_test=SpeedTestConfig(
            min_download_mb_s=1.0,
            timeout_seconds=20,
            concurrency=3,
            urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
        ),
        deploy=DeployConfig(
            project_name="vmessnodes",
            subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
        ),
        workspace=WorkspaceConfig(
            project_root=str(project_root),
            workspace_root=str(workspace_root),
            vpn_catch_nodes_root=str(vpn_catch_nodes_root),
            edgetunnel_root=str(edgetunnel_root),
            artifacts_root=str(project_root / "artifacts"),
            state_root=str(project_root / "state"),
            env_file=str(project_root / ".env"),
            build_root=str(project_root / "build"),
        ),
    )
