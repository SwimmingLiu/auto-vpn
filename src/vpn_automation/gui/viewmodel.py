from copy import deepcopy

from vpn_automation.config.models import AppProfile


def profile_to_form_state(profile: AppProfile) -> dict[str, str]:
    state = {
        "speed.min_download_mb_s": str(profile.speed_test.min_download_mb_s),
        "speed.timeout_seconds": str(profile.speed_test.timeout_seconds),
        "speed.concurrency": str(profile.speed_test.concurrency),
        "speed.urls": "\n".join(profile.speed_test.urls),
        "deploy.project_name": profile.deploy.project_name,
        "deploy.subscription_url": profile.deploy.subscription_url,
        "deploy.pages_project_url": profile.deploy.pages_project_url,
    }
    for name, source in profile.sources.items():
        state[f"source.{name}.url"] = source.url
        state[f"source.{name}.key"] = source.key
        state[f"source.{name}.enabled"] = "1" if source.enabled else "0"
    return state


def apply_form_state_to_profile(profile: AppProfile, state: dict[str, str]) -> AppProfile:
    updated = deepcopy(profile)
    updated.speed_test.min_download_mb_s = float(state["speed.min_download_mb_s"])
    updated.speed_test.timeout_seconds = int(state["speed.timeout_seconds"])
    updated.speed_test.concurrency = int(state["speed.concurrency"])
    updated.speed_test.urls = [item.strip() for item in state["speed.urls"].splitlines() if item.strip()]
    updated.deploy.project_name = state["deploy.project_name"].strip()
    updated.deploy.subscription_url = state["deploy.subscription_url"].strip()
    updated.deploy.pages_project_url = state["deploy.pages_project_url"].strip()
    for name, source in updated.sources.items():
        source.url = state.get(f"source.{name}.url", source.url).strip()
        source.key = state.get(f"source.{name}.key", source.key).strip()
        source.enabled = state.get(f"source.{name}.enabled", "1") == "1"
    return updated
