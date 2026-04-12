import json
from pathlib import Path

from vpn_automation.config.models import AppProfile, create_default_profile


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
        return AppProfile.from_dict(data)

    def load_or_create(self, project_root: Path) -> AppProfile:
        if self.path.exists():
            return self.load()
        profile = create_default_profile(project_root)
        self.save(profile)
        return profile
