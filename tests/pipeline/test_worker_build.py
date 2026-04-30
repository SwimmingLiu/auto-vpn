from pathlib import Path
from importlib import import_module
from importlib.util import find_spec

from vpn_automation.config.models import AppProfile, create_default_profile
from vpn_automation.config.store import ProfileStore


def _template_path() -> Path:
    return Path(__file__).resolve().parents[2] / "templates" / "vmess_node.js"


def test_worker_build_defaults_are_present(tmp_path: Path) -> None:
    profile = create_default_profile(tmp_path / "vpn-subscription-automation")
    worker_build = getattr(profile, "worker_build", None)

    assert worker_build is not None
    assert worker_build.environment_name == "production"
    assert worker_build.entry_filename == "_worker.js"
    assert worker_build.modules_subdir == "modules"
    assert worker_build.enable_keyword_fragmentation is True
    assert worker_build.enable_identifier_randomization is True


def test_worker_build_round_trips_through_store(tmp_path: Path) -> None:
    profile_path = tmp_path / "state" / "profile.toml"
    profile_path.parent.mkdir(parents=True)
    store = ProfileStore(profile_path)

    profile = create_default_profile(tmp_path / "vpn-subscription-automation")
    worker_build = getattr(profile, "worker_build", None)

    assert worker_build is not None
    worker_build.environment_name = "staging"
    worker_build.variable_prefix = "edge"
    worker_build.comment_template = "generated ({environment_name})"
    worker_build.random_noise_min_length = 12
    worker_build.random_noise_max_length = 24
    store.save(profile)

    reloaded = store.load_or_create(tmp_path / "vpn-subscription-automation")

    assert reloaded.worker_build.environment_name == "staging"
    assert reloaded.worker_build.variable_prefix == "edge"
    assert reloaded.worker_build.random_noise_max_length == 24


def test_app_profile_from_dict_accepts_worker_build_payload() -> None:
    profile = AppProfile.from_dict(
        {
            "sources": {},
            "speed_test": {"min_download_mb_s": 1, "timeout_seconds": 20, "concurrency": 3, "urls": []},
            "deploy": {
                "project_name": "sub-nodes",
                "subscription_url": "https://vpn.example/sub",
                "verify_subscription_url": "https://verify.example/sub",
                "pages_project_url": "https://sub-nodes.pages.dev",
            },
            "worker_build": {
                "environment_name": "review",
                "variable_prefix": "rv",
                "emit_sidecar_modules": False,
            },
        }
    )

    worker_build = getattr(profile, "worker_build", None)
    assert worker_build is not None
    assert profile.deploy.verify_subscription_url == "https://verify.example/sub"
    assert worker_build.environment_name == "review"
    assert worker_build.variable_prefix == "rv"
    assert worker_build.emit_sidecar_modules is False


def _load_worker_build_module():
    spec = find_spec("vpn_automation.pipeline.worker_build")
    assert spec is not None
    return import_module("vpn_automation.pipeline.worker_build")


def test_build_worker_artifacts_fragments_secret_literals() -> None:
    module = _load_worker_build_module()
    config = module.WorkerBuildConfig(
        variable_prefix="edge",
        random_noise_min_length=8,
        random_noise_max_length=12,
    )
    rendered = _template_path().read_text(encoding="utf-8").replace("__MAIN_DATA__", "alpha")

    artifacts = module.build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    assert "['ser', 'ect', '_key'].join('')" in artifacts.transformed_source
    assert "['swim', 'ming', 'liu'].join('')" in artifacts.transformed_source
    assert "SUBSCRIPTION_PAYLOAD" in artifacts.transformed_source
    assert "handleSubscriptionRequest" in artifacts.transformed_source
    assert "// subscription worker: returns encoded payload on secret match, random bytes otherwise" in artifacts.transformed_source
    assert "const edge_" in artifacts.transformed_source


def test_build_worker_artifacts_emits_sidecar_modules_and_manifest() -> None:
    module = _load_worker_build_module()
    config = module.WorkerBuildConfig(environment_name="staging", variable_prefix="vf")
    rendered = _template_path().read_text(encoding="utf-8").replace("__MAIN_DATA__", "payload")

    artifacts = module.build_worker_artifacts(rendered, config, "serect_key=swimmingliu")

    assert sorted(artifacts.modules) == [
        "modules/guard.js",
        "modules/noise.js",
        "modules/payload.js",
        "modules/runtime.js",
    ]
    assert artifacts.manifest["environment_name"] == "staging"
    assert artifacts.manifest["entry_filename"] == "_worker.js"
    assert artifacts.manifest["variable_prefix"] == "vf"
