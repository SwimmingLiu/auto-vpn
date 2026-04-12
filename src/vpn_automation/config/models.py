from dataclasses import asdict, dataclass, field


@dataclass
class SourceConfig:
    url: str
    key: str
    enabled: bool = True


@dataclass
class SpeedTestConfig:
    min_download_mb_s: float
    timeout_seconds: int
    concurrency: int
    urls: list[str] = field(default_factory=list)


@dataclass
class DeployConfig:
    project_name: str
    subscription_url: str


@dataclass
class AppProfile:
    sources: dict[str, SourceConfig]
    speed_test: SpeedTestConfig
    deploy: DeployConfig

    def to_dict(self) -> dict:
        return asdict(self)
