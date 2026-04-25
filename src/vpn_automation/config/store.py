import json
import tomllib
from pathlib import Path

from vpn_automation.config.models import (
    AppProfile,
    DEFAULT_SOURCE_ORDER,
    SourceConfig,
    WorkspaceConfig,
    create_default_profile,
    resolve_repo_anchor,
)


def resolve_profile_path(project_root: Path) -> Path:
    candidate_root = Path(project_root).resolve()
    repo_root = resolve_repo_anchor(candidate_root)
    return repo_root / "state" / "profile.toml"


def _workspace_for(project_root: Path) -> WorkspaceConfig:
    return create_default_profile(project_root).workspace


def _format_scalar(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    return json.dumps(str(value), ensure_ascii=False)


def _format_list(values: list[object]) -> str:
    return "[" + ", ".join(_format_scalar(value) for value in values) + "]"


def _append_key_values(lines: list[str], payload: dict[str, object]) -> None:
    for key, value in payload.items():
        if isinstance(value, list):
            lines.append(f"{key} = {_format_list(value)}")
            continue
        lines.append(f"{key} = {_format_scalar(value)}")


def _serialize_profile(profile: AppProfile) -> str:
    lines = [
        "# VPN Subscription Automation runtime profile",
        "# Edit this file directly or save changes from the Electron UI.",
        "",
    ]

    ordered_sources = [
        *[name for name in DEFAULT_SOURCE_ORDER if name in profile.sources],
        *sorted(name for name in profile.sources if name not in DEFAULT_SOURCE_ORDER),
    ]
    for source_name in ordered_sources:
        source = profile.sources[source_name]
        lines.append(f"[sources.{source_name}]")
        _append_key_values(
            lines,
            {
                "url": source.url,
                "key": source.key,
                "enabled": source.enabled,
                "max_iterations": source.max_iterations,
                "min_iterations": source.min_iterations,
                "plateau_limit": source.plateau_limit,
                "use_random_area": source.use_random_area,
                "failure_limit": source.failure_limit,
                "max_runtime_seconds": source.max_runtime_seconds,
            },
        )
        lines.append("")

    lines.append("[speed_test]")
    _append_key_values(
        lines,
        {
            "min_download_mb_s": profile.speed_test.min_download_mb_s,
            "timeout_seconds": profile.speed_test.timeout_seconds,
            "concurrency": profile.speed_test.concurrency,
            "urls": profile.speed_test.urls,
            "probe_url": profile.speed_test.probe_url,
            "max_download_bytes": profile.speed_test.max_download_bytes,
            "startup_wait_seconds": profile.speed_test.startup_wait_seconds,
            "max_download_candidates": profile.speed_test.max_download_candidates,
        },
    )
    lines.append("")

    lines.append("[deploy]")
    _append_key_values(
        lines,
        {
            "project_name": profile.deploy.project_name,
            "subscription_url": profile.deploy.subscription_url,
            "pages_project_url": profile.deploy.pages_project_url,
            "secret_query": profile.deploy.secret_query,
            "account_id": profile.deploy.account_id,
            "use_wrangler": profile.deploy.use_wrangler,
        },
    )
    lines.append("")

    lines.append("[filters]")
    _append_key_values(lines, {"excluded_country_codes": profile.filters.excluded_country_codes})

    if profile.filters.per_country_limit:
        lines.append("")
        lines.append("[filters.per_country_limit]")
        for country_code, limit in sorted(profile.filters.per_country_limit.items()):
            lines.append(f"{country_code} = {limit}")

    lines.append("")
    return "\n".join(lines)


class ProfileStore:
    def __init__(self, path: Path) -> None:
        self.path = path

    def save(self, profile: AppProfile) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(_serialize_profile(profile), encoding="utf-8")

    def load(self) -> AppProfile:
        data = tomllib.loads(self.path.read_text(encoding="utf-8"))
        return AppProfile.from_dict(data)

    def load_or_create(self, project_root: Path) -> AppProfile:
        if self.path.exists():
            profile = self.load()
            profile.workspace = _workspace_for(project_root)
            return profile
        profile = create_default_profile(project_root)
        self.save(profile)
        return profile
