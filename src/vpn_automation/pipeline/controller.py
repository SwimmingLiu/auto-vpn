import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from vpn_automation.config.models import AppProfile
from vpn_automation.config.runtime import load_runtime_env
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
    source_counts: dict[str, dict[str, int | str]] = field(default_factory=dict)
    deployment: dict[str, Any] = field(default_factory=dict)
    run_status: str = "pending"
    error: str = ""


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
        self.now_factory = now_factory
        self._last_source_counts: dict[str, dict[str, int | str]] = {}

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
        skip_deploy: bool = False,
        skip_verify: bool = False,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> PipelineSummary:
        stage_status = {name: "pending" for name in self.stage_names()}
        artifact_dir = self._create_artifact_dir(profile)
        summary = PipelineSummary(artifact_dir=str(artifact_dir), stage_status=stage_status)
        current_stage = ""

        def log(message: str) -> None:
            if log_callback:
                log_callback(message)

        def emit_event(event_type: str, payload: dict[str, Any]) -> None:
            if event_callback:
                event_callback(event_type, payload)

        def set_stage(name: str, status: str) -> None:
            nonlocal current_stage
            stage_status[name] = status
            if status == "running":
                current_stage = name
            elif current_stage == name and status in {"success", "failed", "skipped"}:
                current_stage = ""
            if stage_callback:
                stage_callback(name, status)

        effective_skip_verify = skip_verify or skip_deploy
        emit_event(
            "run_started",
            {
                "artifact_dir": summary.artifact_dir,
                "skip_deploy": skip_deploy,
                "skip_verify": effective_skip_verify,
            },
        )

        try:
            env = self.env_loader(Path(profile.workspace.project_root or __file__))
            api_token = env.get("CLOUDFLARE_API_TOKEN", "")

            set_stage("doctor", "running")
            if not api_token:
                raise RuntimeError("CLOUDFLARE_API_TOKEN is missing")
            set_stage("doctor", "success")
            log("[doctor] runtime environment loaded")

            set_stage("extract", "running")
            raw_links = self._run_extract(profile, artifact_dir, log, event_callback=event_callback)
            set_stage("extract", "success")
            summary.counts["raw_links"] = len(raw_links)
            summary.source_counts = dict(self._last_source_counts)
            self._write_pipeline_report(artifact_dir, summary)

            set_stage("dedupe", "running")
            deduped_links = dedupe_vmess_links(raw_links)
            self._write_lines(artifact_dir / "vpn_node_deduped.txt", deduped_links)
            set_stage("dedupe", "success")
            summary.counts["deduped_links"] = len(deduped_links)
            log(f"[dedupe] kept {len(deduped_links)} unique links")
            self._write_pipeline_report(artifact_dir, summary)

            set_stage("speedtest", "running")
            speedtest_kwargs: dict[str, Any] = {"progress_callback": log}
            if event_callback is not None:
                speedtest_kwargs["event_callback"] = event_callback
            speedtest_results = self.speedtester(
                deduped_links,
                profile.speed_test,
                **speedtest_kwargs,
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
            self._write_pipeline_report(artifact_dir, summary)
            if not fast_links:
                raise RuntimeError("No links passed speed test")

            set_stage("availability", "running")
            availability_kwargs: dict[str, Any] = {"progress_callback": log}
            if event_callback is not None:
                availability_kwargs["event_callback"] = event_callback
            availability_results = self.availability_checker(
                fast_results,
                profile.speed_test,
                **availability_kwargs,
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
            self._write_pipeline_report(artifact_dir, summary)
            if not available_links:
                raise RuntimeError("No links passed availability")

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
            summary.counts["final_links"] = len(decorated_links)
            self._write_pipeline_report(artifact_dir, summary)
            if not decorated_links:
                raise RuntimeError("No links remained after postprocess filters")

            set_stage("render", "running")
            rendered_path = self._render_template(profile, artifact_dir, decorated_links)
            set_stage("render", "success")

            set_stage("obfuscate", "running")
            obfuscated_path = artifact_dir / "vmess_node_worker.js"
            self.obfuscator(rendered_path, obfuscated_path)
            if not obfuscated_path.exists():
                raise RuntimeError("vmess_node_worker.js was not created by the obfuscation step")
            set_stage("obfuscate", "success")
            self._write_pipeline_report(artifact_dir, summary)

            if skip_deploy:
                set_stage("deploy", "skipped")
                log("[deploy] skipped by runtime option")
                self._write_pipeline_report(artifact_dir, summary)
            else:
                set_stage("deploy", "running")
                bundle_dir = build_pages_bundle(obfuscated_path.read_text(encoding="utf-8"), artifact_dir / "pages_bundle")
                deployment = self.deployer(bundle_dir, profile.deploy, api_token)
                summary.deployment = deployment
                if deployment.get("returncode", 1) != 0:
                    raise RuntimeError(f"Cloudflare deployment failed: {deployment}")
                set_stage("deploy", "success")
                self._write_pipeline_report(artifact_dir, summary)

            if effective_skip_verify:
                set_stage("verify", "skipped")
                if skip_deploy and not skip_verify:
                    log("[verify] skipped because deploy stage was skipped")
                else:
                    log("[verify] skipped by runtime option")
                self._write_pipeline_report(artifact_dir, summary)
            else:
                set_stage("verify", "running")
                verification = self.verifier(profile.deploy, api_token)
                if not (verification.get("secret_ok") and verification.get("subscription_ok")):
                    raise RuntimeError(f"Verification failed: {verification}")
                set_stage("verify", "success")
                summary.deployment.update(verification)
                self._write_pipeline_report(artifact_dir, summary)

            summary.run_status = "success"
            self._write_pipeline_report(artifact_dir, summary)
            return summary
        except Exception as exc:
            if current_stage and stage_status.get(current_stage) == "running":
                set_stage(current_stage, "failed")
            summary.run_status = "failed"
            summary.error = f"{exc.__class__.__name__}: {exc}"
            self._write_pipeline_report(artifact_dir, summary)
            raise

    def _create_artifact_dir(self, profile: AppProfile) -> Path:
        root = Path(profile.workspace.artifacts_root)
        root.mkdir(parents=True, exist_ok=True)
        artifact_dir = root / self.now_factory().strftime("%Y%m%d-%H%M%S")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        return artifact_dir

    def _run_extract(
        self,
        profile: AppProfile,
        artifact_dir: Path,
        log: Callable[[str], None],
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> list[str]:
        config_payload = {
            name: {"url": source.url, "key": source.key}
            for name, source in profile.sources.items()
        }
        runtime_config_path = artifact_dir / "vpn_api.runtime.json"
        write_vpn_api_config(runtime_config_path, config_payload)

        enabled_sources = [
            (source_name, source)
            for source_name, source in profile.sources.items()
            if source.enabled and source.url and source.key
        ]
        results_by_source: dict[str, list[str]] = {}
        source_counts: dict[str, dict[str, int | str]] = {}

        with ThreadPoolExecutor(max_workers=max(1, len(enabled_sources))) as executor:
            future_map = {}
            for source_name, source in enabled_sources:
                extract_kwargs: dict[str, Any] = {"progress_callback": log}
                if event_callback is not None:
                    extract_kwargs["event_callback"] = event_callback
                future = executor.submit(
                    self.extractor,
                    source_name,
                    source,
                    **extract_kwargs,
                )
                future_map[future] = source_name
            for future in as_completed(future_map):
                source_name = future_map[future]
                try:
                    extracted = future.result()
                except Exception as exc:
                    log(f"[extract] {source_name} failed: {exc.__class__.__name__}: {exc}")
                    source_counts[source_name] = {
                        "raw_links": 0,
                        "successful_iterations": 0,
                        "failed_iterations": 0,
                        "requested_iterations": 0,
                        "error": f"{exc.__class__.__name__}: {exc}",
                    }
                    continue

                if hasattr(extracted, "links"):
                    results_by_source[source_name] = list(extracted.links)
                    source_counts[source_name] = {
                        "raw_links": len(extracted.links),
                        "successful_iterations": int(getattr(extracted, "successful_iterations", 0)),
                        "failed_iterations": int(getattr(extracted, "failed_iterations", 0)),
                        "requested_iterations": int(getattr(extracted, "requested_iterations", 0)),
                    }
                else:
                    results_by_source[source_name] = list(extracted)
                    source_counts[source_name] = {
                        "raw_links": len(results_by_source[source_name]),
                        "successful_iterations": 0,
                        "failed_iterations": 0,
                        "requested_iterations": 0,
                    }

        raw_links: list[str] = []
        for source_name, _source in enabled_sources:
            raw_links.extend(results_by_source.get(source_name, []))
        self._last_source_counts = source_counts

        if not raw_links:
            raise RuntimeError("No links extracted from enabled sources")
        self._write_lines(artifact_dir / "vpn_node_raw.txt", raw_links)
        return raw_links

    def _render_template(self, profile: AppProfile, artifact_dir: Path, links: list[str]) -> Path:
        template_path = Path(profile.workspace.edgetunnel_root) / "vmess_node.js"
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

    @staticmethod
    def _write_pipeline_report(artifact_dir: Path, summary: PipelineSummary) -> None:
        report_path = artifact_dir / "pipeline_report.json"
        report_path.write_text(
            json.dumps(
                {
                    "artifact_dir": summary.artifact_dir,
                    "run_status": summary.run_status,
                    "error": summary.error,
                    "stage_status": summary.stage_status,
                    "counts": summary.counts,
                    "source_counts": summary.source_counts,
                    "deployment": summary.deployment,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
