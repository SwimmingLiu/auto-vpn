import os
import shutil
import tomllib
from pathlib import Path

from tomlkit import comment, document, nl, table

from vpn_automation.config.models import (
    AppProfile,
    DEFAULT_AVAILABILITY_TARGET_ORDER,
    DEFAULT_SOURCE_ORDER,
    create_default_profile,
    resolve_repo_anchor,
)

LEGACY_PAGES_PROJECT_NAME = "vmessnodes"
LEGACY_PAGES_PROJECT_URL = "https://vmess2clash.pages.dev"
PREVIOUS_PAGES_PROJECT_NAME = "vms-nodes"
PREVIOUS_PAGES_PROJECT_URL = "https://vms-nodes.pages.dev"
CURRENT_PAGES_PROJECT_NAME = "sub-nodes"
CURRENT_PAGES_PROJECT_URL = "https://sub-nodes.pages.dev"


def resolve_profile_path(project_root: Path) -> Path:
    profile_override = os.environ.get("VPN_AUTOMATION_PROFILE_PATH", "").strip()
    if profile_override:
        return Path(profile_override).expanduser().resolve()

    candidate_root = Path(project_root).resolve()
    local_path = candidate_root / "state" / "profile.toml"
    repo_root = resolve_repo_anchor(candidate_root)
    anchor_path = repo_root / "state" / "profile.toml"
    if anchor_path != local_path:
        return anchor_path
    return local_path


def resolve_seed_profile_path(project_root: Path) -> Path | None:
    bundled_override = os.environ.get("VPN_AUTOMATION_BUNDLED_PROFILE_PATH", "").strip()
    if bundled_override:
        candidate = Path(bundled_override).expanduser().resolve()
        return candidate if candidate.exists() else None

    candidate_root = Path(project_root).resolve()
    packaged_seed = candidate_root / "electron" / "runtime" / "bundled-profile.toml"
    if packaged_seed.exists():
        return packaged_seed
    return None


def _ordered_source_names(profile: AppProfile) -> list[str]:
    return [
        *[name for name in DEFAULT_SOURCE_ORDER if name in profile.sources],
        *sorted(name for name in profile.sources if name not in DEFAULT_SOURCE_ORDER),
    ]


def _ordered_availability_target_names(profile: AppProfile) -> list[str]:
    return [
        *[name for name in DEFAULT_AVAILABILITY_TARGET_ORDER if name in profile.availability_targets],
        *sorted(name for name in profile.availability_targets if name not in DEFAULT_AVAILABILITY_TARGET_ORDER),
    ]


def _render_profile_toml(profile: AppProfile) -> str:
    doc = document()
    doc.add(comment("AutoVPN runtime profile"))
    doc.add(comment("Edit this file directly or save changes from the Electron UI."))
    doc.add(nl())

    sources_table = table()
    for source_name in _ordered_source_names(profile):
        source = profile.sources[source_name]
        source_table = table()
        source_table.add("url", source.url)
        source_table.add("key", source.key)
        source_table.add("enabled", source.enabled)
        source_table.add("max_iterations", source.max_iterations)
        source_table.add("min_iterations", source.min_iterations)
        source_table.add("plateau_limit", source.plateau_limit)
        source_table.add("use_random_area", source.use_random_area)
        source_table.add("area_min", source.area_min)
        source_table.add("area_max", source.area_max)
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

    availability_table = table()
    for target_name in _ordered_availability_target_names(profile):
        target = profile.availability_targets[target_name]
        target_table = table()
        target_table.add("url", target.url)
        target_table.add("enabled", target.enabled)
        availability_table.add(target_name, target_table)
    doc.add("availability_targets", availability_table)
    doc.add(nl())

    deploy_table = table()
    deploy_table.add("project_name", profile.deploy.project_name)
    deploy_table.add("subscription_url", profile.deploy.subscription_url)
    deploy_table.add("verify_subscription_url", profile.deploy.verify_subscription_url)
    deploy_table.add("pages_project_url", profile.deploy.pages_project_url)
    deploy_table.add("custom_domain", profile.deploy.custom_domain)
    deploy_table.add("secret_query", profile.deploy.secret_query)
    deploy_table.add("cloudflare_auth_mode", profile.deploy.cloudflare_auth_mode)
    deploy_table.add("cloudflare_api_token", profile.deploy.cloudflare_api_token)
    deploy_table.add("cloudflare_global_key", profile.deploy.cloudflare_global_key)
    deploy_table.add("cloudflare_email", profile.deploy.cloudflare_email)
    deploy_table.add("account_id", profile.deploy.account_id)
    deploy_table.add("use_wrangler", profile.deploy.use_wrangler)
    deploy_table.add("auto_create_project_on_blocked", profile.deploy.auto_create_project_on_blocked)
    deploy_table.add("fallback_project_prefix", profile.deploy.fallback_project_prefix)
    deploy_table.add("share_project_name", profile.deploy.share_project_name)
    deploy_table.add("share_project_auto_fallback", profile.deploy.share_project_auto_fallback)
    deploy_table.add("share_project_fallback_prefix", profile.deploy.share_project_fallback_prefix)
    deploy_table.add("share_project_sub_env_key", profile.deploy.share_project_sub_env_key)
    deploy_table.add("pages_secret_admin", profile.deploy.pages_secret_admin)
    deploy_table.add("fallback_last_used_suffix", profile.deploy.fallback_last_used_suffix)
    deploy_table.add(
        "share_project_fallback_last_used_suffix",
        profile.deploy.share_project_fallback_last_used_suffix,
    )
    doc.add("deploy", deploy_table)
    doc.add(nl())

    worker_build_table = table()
    worker_build_table.add("environment_name", profile.worker_build.environment_name)
    worker_build_table.add("entry_filename", profile.worker_build.entry_filename)
    worker_build_table.add("bundle_subdir", profile.worker_build.bundle_subdir)
    worker_build_table.add("modules_subdir", profile.worker_build.modules_subdir)
    worker_build_table.add("manifest_filename", profile.worker_build.manifest_filename)
    worker_build_table.add("variable_prefix", profile.worker_build.variable_prefix)
    worker_build_table.add("comment_template", profile.worker_build.comment_template)
    worker_build_table.add("random_noise_min_length", profile.worker_build.random_noise_min_length)
    worker_build_table.add("random_noise_max_length", profile.worker_build.random_noise_max_length)
    worker_build_table.add("enable_keyword_fragmentation", profile.worker_build.enable_keyword_fragmentation)
    worker_build_table.add("enable_identifier_randomization", profile.worker_build.enable_identifier_randomization)
    worker_build_table.add("emit_sidecar_modules", profile.worker_build.emit_sidecar_modules)
    doc.add("worker_build", worker_build_table)
    doc.add(nl())

    filters_table = table()
    filters_table.add("excluded_country_codes", profile.filters.excluded_country_codes)
    filters_table.add("per_country_limit", profile.filters.per_country_limit)
    doc.add("filters", filters_table)
    return doc.as_string()


def _load_profile_data(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def _is_blank_profile(profile: AppProfile) -> bool:
    has_source_values = any(
        source.url.strip() or source.key.strip()
        for source in profile.sources.values()
    )
    deploy_fields = (
        "project_name",
        "subscription_url",
        "pages_project_url",
        "secret_query",
        "account_id",
    )
    has_deploy_values = any(
        str(getattr(profile.deploy, field_name, "")).strip()
        for field_name in deploy_fields
    )
    return not has_source_values and not has_deploy_values


def _migrate_legacy_deploy_defaults(profile: AppProfile) -> bool:
    if (
        (
            profile.deploy.project_name == LEGACY_PAGES_PROJECT_NAME
            and profile.deploy.pages_project_url == LEGACY_PAGES_PROJECT_URL
        )
        or (
            profile.deploy.project_name == PREVIOUS_PAGES_PROJECT_NAME
            and profile.deploy.pages_project_url == PREVIOUS_PAGES_PROJECT_URL
        )
    ):
        profile.deploy.project_name = CURRENT_PAGES_PROJECT_NAME
        profile.deploy.pages_project_url = CURRENT_PAGES_PROJECT_URL
        return True
    return False


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(_render_profile_toml(profile), encoding="utf-8")

    def load(self) -> AppProfile:
        data = _load_profile_data(self.path)
        return AppProfile.from_dict(data)

    def load_or_create(self, project_root: Path) -> AppProfile:
        seed_profile = resolve_seed_profile_path(project_root)
        if self.path.exists():
            profile = self.load()
            if _migrate_legacy_deploy_defaults(profile):
                self.save(profile)
            if seed_profile and _is_blank_profile(profile):
                shutil.copy2(seed_profile, self.path)
                return self.load()
            return profile
        if seed_profile:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(seed_profile, self.path)
            return self.load()
        profile = create_default_profile(project_root)
        self.save(profile)
        return profile
