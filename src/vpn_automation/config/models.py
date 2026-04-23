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
    max_iterations: int = 100_000
    min_iterations: int = 0
    plateau_limit: int = 8
    use_random_area: bool = True
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
    per_country_limit: dict[str, int] = field(default_factory=dict)


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig
    filters: FilterConfig = field(default_factory=FilterConfig)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "AppProfile":
        return cls(
            sources={name: SourceConfig(**value) for name, value in data["sources"].items()},
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
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


def _default_source_config(source_name: str) -> SourceConfig:
    source_defaults = {
        "leiting": SourceConfig(url="", key="", enabled=True, min_iterations=10_000),
        "heidong": SourceConfig(url="", key="", enabled=True, min_iterations=15_000),
        "mifeng": SourceConfig(url="", key="", enabled=True, min_iterations=20_000),
        "xuanfeng1": SourceConfig(
            url="",
            key="",
            enabled=True,
            min_iterations=10_000,
            use_random_area=False,
        ),
        "xuanfeng2": SourceConfig(url="", key="", enabled=True, min_iterations=25_000),
    }
    return source_defaults[source_name]


def default_sources() -> dict[str, SourceConfig]:
    return {
        name: _default_source_config(name)
        for name in DEFAULT_SOURCE_ORDER
    }


def create_default_profile(project_root: Path) -> AppProfile:
    _ = project_root

    return AppProfile(
        sources=default_sources(),
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
            project_name="vmessnodes",
            subscription_url="https://swimmingliu.xyz/179ba8dd-3854-4747-b853-fc1868ef3937",
        ),
    )
