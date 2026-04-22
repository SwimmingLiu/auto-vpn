import json
import os
import shutil
from pathlib import Path

from vpn_automation.config.models import AppProfile, create_default_profile, resolve_repo_anchor


def resolve_profile_path(project_root: Path) -> Path:
    profile_override = os.environ.get("VPN_AUTOMATION_PROFILE_PATH", "").strip()
    if profile_override:
        return Path(profile_override).expanduser().resolve()

    candidate_root = Path(project_root).resolve()
    local_path = candidate_root / "state" / "profiles" / "default.json"
    repo_root = resolve_repo_anchor(candidate_root)
    anchor_path = repo_root / "state" / "profiles" / "default.json"

    if anchor_path != local_path:
        return anchor_path
    return local_path


def resolve_seed_profile_path(project_root: Path) -> Path | None:
    bundled_override = os.environ.get("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", "").strip()
    if bundled_override:
        candidate = Path(bundled_override).expanduser().resolve()
        return candidate if candidate.exists() else None

    candidate_root = Path(project_root).resolve()
    packaged_seed = candidate_root / "electron" / "runtime" / "bundled-profile.json"
    if packaged_seed.exists():
        return packaged_seed

    return None


def _is_blank_profile(profile: AppProfile) -> bool:
    has_source_values = any(
        source.url.strip() or source.key.strip()
        for source in profile.sources.values()
    )
    has_deploy_values = any(
        [
            profile.deploy.project_name.strip(),
            profile.deploy.subscription_url.strip(),
            profile.deploy.pages_project_url.strip(),
        ]
    )
    return not has_source_values and not has_deploy_values


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        profile.workspace.profile_path = str(self.path)
        self.path.write_text(
            json.dumps(profile.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def load(self) -> AppProfile:
        data = json.loads(self.path.read_text(encoding="utf-8"))
        profile = AppProfile.from_dict(data)
        profile.workspace.profile_path = str(self.path)
        return profile

    def load_or_create(self, project_root: Path) -> AppProfile:
        seed_profile = resolve_seed_profile_path(project_root)
        if self.path.exists():
            profile = self.load()
            if seed_profile and seed_profile.exists() and _is_blank_profile(profile):
                shutil.copy2(seed_profile, self.path)
                return self.load()
            return profile
        if seed_profile and seed_profile.exists():
            self.path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(seed_profile, self.path)
            return self.load()
        profile = create_default_profile(project_root)
        self.save(profile)
        return profile
