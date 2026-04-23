import tomllib
from pathlib import Path

from tomlkit import comment, document, nl, table

from vpn_automation.config.models import AppProfile, create_default_profile, resolve_repo_anchor


def resolve_profile_path(project_root: Path) -> Path:
    candidate_root = Path(project_root).resolve()
    local_path = candidate_root / "state" / "profile.toml"
    repo_root = resolve_repo_anchor(candidate_root)
    anchor_path = repo_root / "state" / "profile.toml"

    if anchor_path != local_path:
        return anchor_path
    return local_path


def _render_profile_toml(profile: AppProfile) -> str:
    doc = document()
    doc.add(comment("VPN Subscription Automation runtime profile"))
    doc.add(comment("Edit this file directly or save changes from the Electron UI."))
    doc.add(nl())

    sources_table = table()
    for source_name, source in profile.sources.items():
        source_table = table()
        source_table.add("url", source.url)
        source_table.add("key", source.key)
        source_table.add("enabled", source.enabled)
        source_table.add("max_iterations", source.max_iterations)
        source_table.add("min_iterations", source.min_iterations)
        source_table.add("plateau_limit", source.plateau_limit)
        source_table.add("use_random_area", source.use_random_area)
        source_table.add("failure_limit", source.failure_limit)
        source_table.add("max_runtime_seconds", source.max_runtime_seconds)
        sources_table.add(source_name, source_table)
    doc.add("sources", sources_table)
    doc.add(nl())

    speed_table = table()
    speed_table.add("min_download_mb_s", profile.speed_test.min_download_mb_s)
    speed_table.add("timeout_seconds", profile.speed_test.timeout_seconds)
    speed_table.add("concurrency", profile.speed_test.concurrency)
    speed_table.add("urls", profile.speed_test.urls)
    speed_table.add("probe_url", profile.speed_test.probe_url)
    speed_table.add("max_download_bytes", profile.speed_test.max_download_bytes)
    speed_table.add("startup_wait_seconds", profile.speed_test.startup_wait_seconds)
    speed_table.add("max_download_candidates", profile.speed_test.max_download_candidates)
    doc.add("speed_test", speed_table)
    doc.add(nl())

    deploy_table = table()
    deploy_table.add("project_name", profile.deploy.project_name)
    deploy_table.add("subscription_url", profile.deploy.subscription_url)
    deploy_table.add("pages_project_url", profile.deploy.pages_project_url)
    deploy_table.add("secret_query", profile.deploy.secret_query)
    deploy_table.add("account_id", profile.deploy.account_id)
    deploy_table.add("use_wrangler", profile.deploy.use_wrangler)
    doc.add("deploy", deploy_table)
    doc.add(nl())

    filters_table = table()
    filters_table.add("excluded_country_codes", profile.filters.excluded_country_codes)
    filters_table.add("per_country_limit", profile.filters.per_country_limit)
    doc.add("filters", filters_table)

    return doc.as_string()


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(_render_profile_toml(profile), encoding="utf-8")

    def load(self) -> AppProfile:
        data = tomllib.loads(self.path.read_text(encoding="utf-8"))
        return AppProfile.from_dict(data)

    def load_or_create(self, project_root: Path) -> AppProfile:
        if self.path.exists():
            return self.load()
        profile = create_default_profile(project_root)
        self.save(profile)
        return profile
