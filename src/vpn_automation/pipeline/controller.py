import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from vpn_automation.config.models import AppProfile
from vpn_automation.config.runtime import (
    load_runtime_env,
    resolve_artifacts_root,
    resolve_runtime_root,
    resolve_template_file,
)
from vpn_automation.integrations.cloudflare import (
    CloudflareClient,
    build_secret_url,
    deploy_pages_bundle,
)
from vpn_automation.integrations.node_tools import obfuscate_javascript
from vpn_automation.pipeline.dedupe import dedupe_vmess_links
from vpn_automation.pipeline.extract import fetch_source_links, write_vpn_api_config
from vpn_automation.pipeline.package import build_pages_bundle
from vpn_automation.pipeline.availability import check_link_availability_batch
from vpn_automation.pipeline.postprocess import (
    decorate_link_with_country,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.render import replace_main_data
from vpn_automation.pipeline.speedtest import speedtest_links
from vpn_automation.pipeline.vmess import parse_vmess_link


@dataclass
class PipelineSummary:
    artifact_dir: str
    stage_status: dict[str, str]
    counts: dict[str, int] = field(default_factory=dict)
    deployment: dict[str, Any] = field(default_factory=dict)


class PipelineController:
    def __init__(
        self,
        *,
        extractor: Callable[..., Any] = fetch_source_links,
        speedtester: Callable[..., Any] = speedtest_links,
        availability_checker: Callable[..., Any] = check_link_availability_batch,
        country_lookup: Callable[[str], str] = lookup_country_code,
        obfuscator: Callable[[Path, Path], Any] = obfuscate_javascript,
        deployer: Callable[[Path, Any, str], dict[str, Any]] = deploy_pages_bundle,
        verifier: Callable[[Any, str], dict[str, bool]] | None = None,
        env_loader: Callable[[Path], dict[str, str]] = load_runtime_env,
        runtime_root_resolver: Callable[[Path], Path] = resolve_runtime_root,
        artifacts_root_resolver: Callable[[Path], Path] = resolve_artifacts_root,
        template_path_resolver: Callable[[Path], Path] = resolve_template_file,
        now_factory: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.extractor = extractor
        self.speedtester = speedtester
        self.availability_checker = availability_checker
        self.country_lookup = country_lookup
        self.obfuscator = obfuscator
        self.deployer = deployer
        self.verifier = verifier or self._default_verify
        self.env_loader = env_loader
        self.runtime_root_resolver = runtime_root_resolver
        self.artifacts_root_resolver = artifacts_root_resolver
        self.template_path_resolver = template_path_resolver
        self.now_factory = now_factory

    def stage_names(self) -> list[str]:
        return [
            "doctor",
            "extract",
            "dedupe",
            "speedtest",
            "availability",
            "postprocess",
            "render",
            "obfuscate",
            "deploy",
            "verify",
        ]

    def run(
        self,
        profile: AppProfile,
        *,
        log_callback: Callable[[str], None] | None = None,
        stage_callback: Callable[[str, str], None] | None = None,
    ) -> PipelineSummary:
        stage_status = {name: "pending" for name in self.stage_names()}
        runtime_root = self.runtime_root_resolver(Path(__file__))
        artifact_dir = self._create_artifact_dir(runtime_root)
        summary = PipelineSummary(artifact_dir=str(artifact_dir), stage_status=stage_status)

        def log(message: str) -> None:
            if log_callback:
                log_callback(message)

        def set_stage(name: str, status: str) -> None:
            stage_status[name] = status
            if stage_callback:
                stage_callback(name, status)

        env = self.env_loader(runtime_root)
        api_token = env.get("CLOUDFLARE_API_TOKEN", "")

        set_stage("doctor", "running")
        if not api_token:
            raise RuntimeError("CLOUDFLARE_API_TOKEN is missing")
        set_stage("doctor", "success")
        log("[doctor] runtime environment loaded")

        set_stage("extract", "running")
        raw_links = self._run_extract(profile, artifact_dir, log)
        set_stage("extract", "success")
        summary.counts["raw_links"] = len(raw_links)

        set_stage("dedupe", "running")
        deduped_links = dedupe_vmess_links(raw_links)
        self._write_lines(artifact_dir / "vpn_node_deduped.txt", deduped_links)
        set_stage("dedupe", "success")
        summary.counts["deduped_links"] = len(deduped_links)
        log(f"[dedupe] kept {len(deduped_links)} unique links")

        set_stage("speedtest", "running")
        speedtest_results = self.speedtester(
            deduped_links,
            profile.speed_test,
            progress_callback=log,
        )
        fast_results = [
            result
            for result in speedtest_results
            if result.reachable and result.average_download_mb_s >= profile.speed_test.min_download_mb_s
        ]
        fast_results.sort(key=lambda item: item.average_download_mb_s, reverse=True)
        fast_links = [result.link for result in fast_results]
        self._write_lines(artifact_dir / "vpn_node_speedtest.txt", fast_links)
        set_stage("speedtest", "success")
        summary.counts["speedtest_links"] = len(fast_links)
        log(f"[speedtest] kept {len(fast_links)} links above threshold")

        set_stage("availability", "running")
        availability_results = self.availability_checker(
            fast_results,
            profile.speed_test,
            progress_callback=log,
        )
        available_results = [
            item.speed_result
            for item in availability_results
            if item.all_passed
        ]
        available_links = [item.link for item in available_results]
        self._write_lines(artifact_dir / "vpn_node_availability.txt", available_links)
        (artifact_dir / "vpn_node_availability_report.json").write_text(
            json.dumps([item.to_dict() for item in availability_results], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        set_stage("availability", "success")
        summary.counts["availability_links"] = len(available_links)
        log(f"[availability] kept {len(available_links)} links after provider validation")

        set_stage("postprocess", "running")
        ranked_links: list[tuple[str, Any, str]] = []
        for result in available_results:
            country_code = self.country_lookup(parse_vmess_link(result.link)["add"])
            ranked_links.append((result.link, result, country_code))
        selected_links = select_links_by_country_limit(ranked_links, profile.filters)
        selected_country = {link: country for link, _result, country in ranked_links}
        decorated_links = [
            decorate_link_with_country(link, selected_country[link]) for link in selected_links
        ]
        self._write_lines(artifact_dir / "vpn_node_emoji.txt", decorated_links)
        set_stage("postprocess", "success")
        summary.counts["postprocess_links"] = len(decorated_links)

        set_stage("render", "running")
        rendered_path = self._render_template(runtime_root, artifact_dir, decorated_links)
        set_stage("render", "success")

        set_stage("obfuscate", "running")
        obfuscated_path = artifact_dir / "vmess_node_worker.js"
        self.obfuscator(rendered_path, obfuscated_path)
        if not obfuscated_path.exists():
            raise RuntimeError("vmess_node_worker.js was not created by the obfuscation step")
        set_stage("obfuscate", "success")

        set_stage("deploy", "running")
        bundle_dir = build_pages_bundle(obfuscated_path.read_text(encoding="utf-8"), artifact_dir / "pages_bundle")
        deployment = self.deployer(bundle_dir, profile.deploy, api_token)
        summary.deployment = deployment
        if deployment.get("returncode", 1) != 0:
            raise RuntimeError(f"Cloudflare deployment failed: {deployment}")
        set_stage("deploy", "success")

        set_stage("verify", "running")
        verification = self.verifier(profile.deploy, api_token)
        if not (verification.get("secret_ok") and verification.get("subscription_ok")):
            raise RuntimeError(f"Verification failed: {verification}")
        set_stage("verify", "success")
        summary.deployment.update(verification)

        return summary

    def _create_artifact_dir(self, runtime_root: Path) -> Path:
        root = self.artifacts_root_resolver(runtime_root)
        root.mkdir(parents=True, exist_ok=True)
        artifact_dir = root / self.now_factory().strftime("%Y%m%d-%H%M%S")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        return artifact_dir

    def _run_extract(
        self,
        profile: AppProfile,
        artifact_dir: Path,
        log: Callable[[str], None],
    ) -> list[str]:
        config_payload = {
            name: {"url": source.url, "key": source.key}
            for name, source in profile.sources.items()
        }
        runtime_config_path = artifact_dir / "vpn_api.runtime.json"
        write_vpn_api_config(runtime_config_path, config_payload)

        raw_links: list[str] = []
        for source_name, source in profile.sources.items():
            if not source.enabled or not source.url or not source.key:
                continue
            extracted = self.extractor(source_name, source, progress_callback=log)
            if hasattr(extracted, "links"):
                raw_links.extend(extracted.links)
            else:
                raw_links.extend(extracted)
        self._write_lines(artifact_dir / "vpn_node_raw.txt", raw_links)
        return raw_links

    def _render_template(self, runtime_root: Path, artifact_dir: Path, links: list[str]) -> Path:
        template_path = self.template_path_resolver(runtime_root)
        rendered = replace_main_data(template_path.read_text(encoding="utf-8"), links)
        rendered_path = artifact_dir / "vmess_node.js"
        rendered_path.write_text(rendered, encoding="utf-8")
        return rendered_path

    def _default_verify(self, deploy: Any, api_token: str) -> dict[str, bool]:
        client = CloudflareClient(api_token=api_token, account_id=deploy.account_id)
        secret_ok = client.verify_url(build_secret_url(deploy))
        subscription_ok = client.verify_url(deploy.subscription_url)
        return {"secret_ok": secret_ok, "subscription_ok": subscription_ok}

    @staticmethod
    def _write_lines(path: Path, lines: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines), encoding="utf-8")
