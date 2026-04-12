import json
from pathlib import Path

from vpn_automation.config.models import AppProfile, DeployConfig, SourceConfig, SpeedTestConfig


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(
            json.dumps(profile.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def load(self) -> AppProfile:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        return AppProfile(
            sources={name: SourceConfig(**value) for name, value in data["sources"].items()},
            speed_test=SpeedTestConfig(**data["speed_test"]),
            deploy=DeployConfig(**data["deploy"]),
        )
