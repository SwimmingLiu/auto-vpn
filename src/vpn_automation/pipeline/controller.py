import inspect
import json
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
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
    build_custom_domain_root_url,
    build_custom_domain_subscription_url,
    build_pages_project_root_url,
    build_secret_url,
    derive_custom_domain_dns_target,
    deploy_pages_bundle,
    resolve_cloudflare_credentials,
)
from vpn_automation.integrations.node_tools import obfuscate_javascript
from vpn_automation.pipeline.availability import check_link_availability_batch, normalize_provider_targets
from vpn_automation.pipeline.dedupe import dedupe_vmess_links
from vpn_automation.pipeline.extract import fetch_source_links, write_vpn_api_config
from vpn_automation.pipeline.package import build_pages_bundle
from vpn_automation.pipeline.postprocess import (
    decorate_link_with_country,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.render import replace_main_data
from vpn_automation.pipeline.run_store import RunStore
from vpn_automation.pipeline.speedtest import speedtest_links
from vpn_automation.pipeline.vmess import canonical_key, parse_vmess_link
from vpn_automation.pipeline.worker_build import build_worker_artifacts


@dataclass
class PipelineSummary:
    artifact_dir: str
    stage_status: dict[str, str]
    counts: dict[str, int] = field(default_factory=dict)
    source_counts: dict[str, dict[str, int | str]] = field(default_factory=dict)
    deployment: dict[str, Any] = field(default_factory=dict)
    retry_context: dict[str, Any] = field(default_factory=dict)
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
        runtime_root_resolver: Callable[[Path], Path] = resolve_runtime_root,
        artifacts_root_resolver: Callable[[Path], Path] = resolve_artifacts_root,
        template_path_resolver: Callable[[Path], Path] = resolve_template_file,
        now_factory: Callable[[], datetime] = datetime.now,
        artifact_retention_count: int = 1,
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
        self.artifact_retention_count = artifact_retention_count
        self._last_source_counts: dict[str, dict[str, int | str]] = {}
        self._last_source_links: dict[str, list[str]] = {}

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
        resume_from: Path | None = None,
        skip_deploy: bool = False,
        skip_verify: bool = False,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> PipelineSummary:
        stage_status = {name: "pending" for name in self.stage_names()}
        runtime_candidate = Path(getattr(profile.workspace, "project_root", "") or __file__)
        runtime_root = self.runtime_root_resolver(runtime_candidate)
        if resume_from:
            artifact_dir = resume_from
            run_store = RunStore(artifact_dir / "run.db")
        else:
            artifact_dir = self._create_artifact_dir(runtime_root)
            run_store = RunStore(artifact_dir / "run.db")
            run_store.initialize(artifact_dir=str(artifact_dir))
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
            run_store.record_stage_event(name, status)
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
                "resume_from": str(resume_from) if resume_from else "",
            },
        )

        try:
            env = self.env_loader(runtime_root)
            credentials = None if skip_deploy else resolve_cloudflare_credentials(profile.deploy, env)

            set_stage("doctor", "running")
            set_stage("doctor", "success")
            log("[doctor] runtime environment loaded")

            quality = self._run_quality_pipeline(
                profile,
                artifact_dir,
                log,
                run_store,
                set_stage,
                summary,
                resume=bool(resume_from),
                event_callback=event_callback,
            )
            available_results = quality["available_results"]
            available_links = quality["available_links"]

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
            for link in selected_links:
                run_store.record_final_link(
                    stage_name="postprocess",
                    link=link,
                    country_code=selected_country[link],
                )
            self._write_lines(artifact_dir / "vpn_node_emoji.txt", decorated_links)
            set_stage("postprocess", "success")
            summary.counts["postprocess_links"] = len(decorated_links)
            summary.counts["final_links"] = len(decorated_links)
            self._write_pipeline_report(artifact_dir, summary)
            if not decorated_links:
                raise RuntimeError("No links remained after postprocess filters")

            set_stage("render", "running")
            rendered_path = self._render_template(runtime_root, artifact_dir, decorated_links, profile=profile)
            set_stage("render", "success")

            set_stage("obfuscate", "running")
            build_artifacts = build_worker_artifacts(
                rendered_path.read_text(encoding="utf-8"),
                profile.worker_build,
                profile.deploy.secret_query,
            )
            transformed_path = artifact_dir / "worker_transformed.js"
            transformed_path.write_text(build_artifacts.transformed_source, encoding="utf-8")
            obfuscated_path = artifact_dir / profile.worker_build.entry_filename
            self.obfuscator(transformed_path, obfuscated_path)
            if not obfuscated_path.exists():
                raise RuntimeError("_worker.js was not created by the obfuscation step")
            summary.counts["worker_modules"] = len(build_artifacts.modules)
            set_stage("obfuscate", "success")
            self._write_pipeline_report(artifact_dir, summary)

            if skip_deploy:
                set_stage("deploy", "skipped")
                log("[deploy] skipped by runtime option")
                self._write_pipeline_report(artifact_dir, summary)
            else:
                set_stage("deploy", "running")
                bundle_dir = build_pages_bundle(
                    obfuscated_path.read_text(encoding="utf-8"),
                    artifact_dir / profile.worker_build.bundle_subdir,
                    build_artifacts,
                    profile.worker_build,
                )
                log(
                    f"[deploy] project={profile.deploy.project_name} "
                    f"bundle={bundle_dir} url={profile.deploy.pages_project_url}"
                )
                deployment = self.deployer(bundle_dir, profile.deploy, credentials)
                summary.deployment = deployment
                if deployment.get("returncode", 1) != 0:
                    raise RuntimeError(f"Cloudflare deployment failed: {deployment}")
                log(
                    f"[deploy] returncode={deployment.get('returncode')} "
                    f"attempts={','.join(item['mode'] for item in deployment.get('attempts', []))}"
                )
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
                verification_target = _merge_deploy_verification_target(profile.deploy, deployment)
                verification = self.verifier(verification_target, credentials)
                if not _is_verify_success(verification):
                    raise RuntimeError(f"Verification failed: {verification}")
                cleanup = _cleanup_blocked_pages_project(verification_target, deployment, credentials)
                set_stage("verify", "success")
                summary.deployment.update(verification)
                summary.deployment.update(cleanup)
                self._write_pipeline_report(artifact_dir, summary)

            summary.run_status = "success"
            self._write_pipeline_report(artifact_dir, summary)
            run_store.mark_run_status("success")
            return summary
        except Exception as exc:
            if current_stage and stage_status.get(current_stage) == "running":
                set_stage(current_stage, "failed")
            summary.run_status = "failed"
            summary.error = f"{exc.__class__.__name__}: {exc}"
            self._write_pipeline_report(artifact_dir, summary)
            run_store.mark_run_status("failed")
            raise

    def _create_artifact_dir(self, runtime_root: Path) -> Path:
        root = self.artifacts_root_resolver(runtime_root)
        root.mkdir(parents=True, exist_ok=True)
        artifact_dir = root / self.now_factory().strftime("%Y%m%d-%H%M%S")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        self._prune_artifacts(root, keep={artifact_dir}, keep_count=self.artifact_retention_count)
        return artifact_dir

    @staticmethod
    def _prune_artifacts(root: Path, *, keep: set[Path], keep_count: int) -> None:
        if keep_count <= 0 or not root.exists():
            return
        keep_resolved = {path.resolve() for path in keep}
        directories = sorted(
            [path for path in root.iterdir() if path.is_dir()],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        extra_keep_slots = max(0, keep_count - len(keep_resolved))
        kept = 0
        for directory in directories:
            if directory.resolve() in keep_resolved:
                continue
            if kept < extra_keep_slots:
                kept += 1
                continue
            shutil.rmtree(directory, ignore_errors=True)

    def _run_quality_pipeline(
        self,
        profile: AppProfile,
        artifact_dir: Path,
        log: Callable[[str], None],
        run_store: RunStore,
        set_stage: Callable[[str, str], None],
        summary: PipelineSummary,
        *,
        resume: bool = False,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        if resume or not self._extractor_supports_streaming():
            return self._run_quality_pipeline_batch(
                profile,
                artifact_dir,
                log,
                run_store,
                set_stage,
                summary,
                resume=resume,
                event_callback=event_callback,
            )

        lock = threading.Lock()
        deduped_links: list[str] = []
        speedtest_results: list[Any] = []
        fast_results: list[Any] = []
        availability_results: list[Any] = []
        available_results: list[Any] = []
        speed_futures: list[Any] = []
        availability_futures: list[Any] = []
        availability_targets = normalize_provider_targets(profile.availability_targets)

        speed_executor = ThreadPoolExecutor(max_workers=max(1, profile.speed_test.concurrency))
        availability_executor = ThreadPoolExecutor(max_workers=max(1, profile.speed_test.concurrency))

        def record_speedtest_result(result: Any) -> None:
            run_store.record_speedtest_result(
                link=result.link,
                reachable=result.reachable,
                latency_ms=result.latency_ms,
                average_download_mb_s=result.average_download_mb_s,
                error=getattr(result, "error", "") or "",
            )

        def record_availability_result(item: Any) -> None:
            for provider_name, provider_result in item.provider_results.items():
                run_store.record_availability_result(
                    link=item.speed_result.link,
                    provider=provider_name,
                    passed=provider_result.passed,
                    reason=provider_result.reason,
                )

        def call_speedtester(link: str) -> Any:
            results = self._call_worker(
                self.speedtester,
                [link],
                profile.speed_test,
                progress_callback=log,
                event_callback=event_callback,
            )
            return list(results)[0]

        def call_availability_checker(speed_result: Any) -> Any:
            results = self._call_worker(
                self.availability_checker,
                [speed_result],
                profile.speed_test,
                progress_callback=log,
                event_callback=event_callback,
                worker_kwargs={"targets": availability_targets},
            )
            return list(results)[0]

        def submit_availability(speed_result: Any) -> None:
            future = availability_executor.submit(call_availability_checker, speed_result)
            with lock:
                availability_futures.append(future)
            future.add_done_callback(handle_availability_done)

        def handle_speed_done(future: Any) -> None:
            try:
                result = future.result()
            except Exception as exc:
                log(f"[speedtest] worker failed: {exc.__class__.__name__}: {exc}")
                return
            with lock:
                speedtest_results.append(result)
                record_speedtest_result(result)
                passed = result.reachable and result.average_download_mb_s >= profile.speed_test.min_download_mb_s
                if passed:
                    fast_results.append(result)
            if passed:
                submit_availability(result)

        def handle_availability_done(future: Any) -> None:
            try:
                item = future.result()
            except Exception as exc:
                log(f"[availability] worker failed: {exc.__class__.__name__}: {exc}")
                return
            with lock:
                availability_results.append(item)
                record_availability_result(item)
                if item.all_passed:
                    available_results.append(item.speed_result)

        def submit_speedtest_link(link: str) -> None:
            with lock:
                if link in deduped_links:
                    return
                deduped_links.append(link)
            future = speed_executor.submit(call_speedtester, link)
            with lock:
                speed_futures.append(future)
            future.add_done_callback(handle_speed_done)

        try:
            set_stage("extract", "running")
            set_stage("dedupe", "running")
            set_stage("dedupe", "success")
            log("[dedupe] using run database canonical index during extract")
            set_stage("speedtest", "running")
            set_stage("availability", "running")
            raw_links = self._run_extract(
                profile,
                artifact_dir,
                log,
                run_store,
                resume=resume,
                event_callback=event_callback,
                unique_link_callback=submit_speedtest_link,
            )
            set_stage("extract", "success")
            speed_executor.shutdown(wait=True)
            set_stage("speedtest", "success")
            availability_executor.shutdown(wait=True)
            set_stage("availability", "success")
        except Exception:
            speed_executor.shutdown(wait=False, cancel_futures=True)
            availability_executor.shutdown(wait=False, cancel_futures=True)
            raise

        fast_results.sort(key=lambda item: item.average_download_mb_s, reverse=True)
        available_results.sort(key=lambda item: item.average_download_mb_s, reverse=True)
        fast_links = [result.link for result in fast_results]
        available_links = [item.link for item in available_results]

        self._write_lines(artifact_dir / "vpn_node_raw.txt", raw_links)
        self._write_lines(artifact_dir / "vpn_node_deduped.txt", deduped_links)
        self._write_lines(artifact_dir / "vpn_node_speedtest.txt", fast_links)
        self._write_lines(artifact_dir / "vpn_node_availability.txt", available_links)
        (artifact_dir / "vpn_node_availability_report.json").write_text(
            json.dumps([item.to_dict() for item in availability_results], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        summary.counts["raw_links"] = len(raw_links)
        summary.counts["deduped_links"] = len(deduped_links)
        summary.counts["speedtest_links"] = len(fast_links)
        summary.counts["availability_links"] = len(available_links)
        summary.source_counts = self._merge_source_dedupe_counts(profile)
        log(f"[extract] collected {len(raw_links)} raw links")
        log(f"[dedupe] kept {len(deduped_links)} unique links")
        log(f"[speedtest] kept {len(fast_links)} links above threshold")
        log(f"[availability] kept {len(available_links)} links after provider validation")
        self._write_pipeline_report(artifact_dir, summary)

        if not raw_links:
            raise RuntimeError("No links extracted from enabled sources")
        if not fast_links:
            raise RuntimeError("No links passed speed test")
        if not available_links:
            raise RuntimeError("No links passed availability")

        return {
            "raw_links": raw_links,
            "deduped_links": deduped_links,
            "speedtest_results": speedtest_results,
            "fast_results": fast_results,
            "availability_results": availability_results,
            "available_results": available_results,
            "available_links": available_links,
        }

    def _run_quality_pipeline_batch(
        self,
        profile: AppProfile,
        artifact_dir: Path,
        log: Callable[[str], None],
        run_store: RunStore,
        set_stage: Callable[[str, str], None],
        summary: PipelineSummary,
        *,
        resume: bool = False,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        availability_targets = normalize_provider_targets(profile.availability_targets)

        set_stage("extract", "running")
        raw_links = self._run_extract(
            profile,
            artifact_dir,
            log,
            run_store,
            resume=resume,
            event_callback=event_callback,
        )
        set_stage("extract", "success")
        summary.counts["raw_links"] = len(raw_links)
        summary.source_counts = self._merge_source_dedupe_counts(profile)
        self._write_pipeline_report(artifact_dir, summary)
        if not raw_links:
            raise RuntimeError("No links extracted from enabled sources")

        set_stage("dedupe", "running")
        deduped_links = dedupe_vmess_links(raw_links)
        self._write_lines(artifact_dir / "vpn_node_deduped.txt", deduped_links)
        set_stage("dedupe", "success")
        summary.counts["deduped_links"] = len(deduped_links)
        summary.source_counts = self._merge_source_dedupe_counts(profile)
        log(f"[dedupe] kept {len(deduped_links)} unique links")
        self._write_pipeline_report(artifact_dir, summary)

        set_stage("speedtest", "running")
        speedtest_results = self._call_worker(
            self.speedtester,
            deduped_links,
            profile.speed_test,
            progress_callback=log,
            event_callback=event_callback,
        )
        fast_results = [
            result
            for result in speedtest_results
            if result.reachable and result.average_download_mb_s >= profile.speed_test.min_download_mb_s
        ]
        for result in speedtest_results:
            run_store.record_speedtest_result(
                link=result.link,
                reachable=result.reachable,
                latency_ms=result.latency_ms,
                average_download_mb_s=result.average_download_mb_s,
                error=getattr(result, "error", "") or "",
            )
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
        availability_results = self._call_worker(
            self.availability_checker,
            fast_results,
            profile.speed_test,
            progress_callback=log,
            event_callback=event_callback,
            worker_kwargs={"targets": availability_targets},
        )
        available_results = [
            item.speed_result
            for item in availability_results
            if item.all_passed
        ]
        for item in availability_results:
            for provider_name, provider_result in item.provider_results.items():
                run_store.record_availability_result(
                    link=item.speed_result.link,
                    provider=provider_name,
                    passed=provider_result.passed,
                    reason=provider_result.reason,
                )
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

        return {
            "raw_links": raw_links,
            "deduped_links": deduped_links,
            "speedtest_results": speedtest_results,
            "fast_results": fast_results,
            "availability_results": availability_results,
            "available_results": available_results,
            "available_links": available_links,
        }

    def _extractor_supports_streaming(self) -> bool:
        signature = inspect.signature(self.extractor)
        parameters = signature.parameters
        return "raw_link_callback" in parameters or any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )

    def _merge_source_dedupe_counts(self, profile: AppProfile) -> dict[str, dict[str, int | str]]:
        deduped_counts = self._count_source_deduped_links(profile, self._last_source_links)
        merged: dict[str, dict[str, int | str]] = {}
        for name, counts in self._last_source_counts.items():
            merged[name] = {
                **counts,
                "deduped_links": int(deduped_counts.get(name, 0)),
            }
        for name, count in deduped_counts.items():
            merged.setdefault(name, {"raw_links": 0})
            merged[name]["deduped_links"] = int(count)
        return merged

    @staticmethod
    def _count_source_deduped_links(
        profile: AppProfile,
        source_links: dict[str, list[str]],
    ) -> dict[str, int]:
        deduped_counts = {name: 0 for name in source_links}
        seen: set[Any] = set()
        for source_name in profile.sources:
            for link in source_links.get(source_name, []):
                key = canonical_key(parse_vmess_link(link))
                if key in seen:
                    continue
                seen.add(key)
                deduped_counts[source_name] = deduped_counts.get(source_name, 0) + 1
        return deduped_counts

    def _run_extract(
        self,
        profile: AppProfile,
        artifact_dir: Path,
        log: Callable[[str], None],
        run_store: RunStore | None = None,
        *,
        resume: bool = False,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
        unique_link_callback: Callable[[str], None] | None = None,
    ) -> list[str]:
        config_payload = {
            name: {"url": source.url, "key": source.key}
            for name, source in profile.sources.items()
        }
        runtime_config_path = artifact_dir / "vpn_api.runtime.json"
        write_vpn_api_config(runtime_config_path, config_payload)

        enabled_sources = [
            (source_name, deepcopy(source))
            for source_name, source in profile.sources.items()
            if source.enabled and source.url and source.key
        ]
        if not enabled_sources:
            self._last_source_counts = {}
            self._last_source_links = {}
            self._write_lines(artifact_dir / "vpn_node_raw.txt", [])
            return []

        results_by_source: dict[str, list[str]] = {}
        source_counts: dict[str, dict[str, int | str]] = {}
        resume_states: dict[str, dict[str, object]] = {}
        accepted_unique_links: set[str] = set()

        for source_name, source in enabled_sources:
            if run_store and resume:
                resume_state = run_store.fetch_source_resume_state(source_name)
                source.resume_from_iteration = int(resume_state["iteration"]) + 1
            else:
                resume_state = {
                    "iteration": 0,
                    "max_iterations": 0,
                    "new_links": 0,
                    "raw_links": [],
                    "successful_iterations": 0,
                    "failed_iterations": 0,
                }
                source.resume_from_iteration = 1
            resume_states[source_name] = resume_state
            results_by_source[source_name] = list(resume_state["raw_links"])

        with ThreadPoolExecutor(max_workers=max(1, len(enabled_sources))) as executor:
            future_map = {
                executor.submit(
                    self._call_extractor,
                    source_name,
                    source,
                    log,
                    run_store,
                    resume_state=resume_states[source_name],
                    event_callback=event_callback,
                    unique_link_callback=unique_link_callback,
                    accepted_unique_links=accepted_unique_links,
                ): (source_name, source)
                for source_name, source in enabled_sources
            }
            for future in as_completed(future_map):
                source_name, source = future_map[future]
                resume_state = resume_states[source_name]
                try:
                    extracted = future.result()
                except Exception as exc:
                    log(f"[extract] {source_name} failed: {exc.__class__.__name__}: {exc}")
                    if event_callback:
                        event_callback(
                            "extract_source_failed",
                            {
                                "source_name": source_name,
                                "error": f"{exc.__class__.__name__}: {exc}",
                            },
                        )
                    source_counts[source_name] = {
                        "raw_links": len(results_by_source[source_name]),
                        "successful_iterations": int(resume_state["successful_iterations"]),
                        "failed_iterations": int(resume_state["failed_iterations"]),
                        "requested_iterations": int(source.max_iterations),
                        "error": f"{exc.__class__.__name__}: {exc}",
                    }
                    continue

                if hasattr(extracted, "links"):
                    new_links = list(extracted.links)
                    successful_iterations = int(
                        resume_state["successful_iterations"]
                    ) + int(getattr(extracted, "successful_iterations", 0))
                    failed_iterations = int(
                        resume_state["failed_iterations"]
                    ) + int(getattr(extracted, "failed_iterations", 0))
                    requested_iterations = int(getattr(extracted, "requested_iterations", source.max_iterations))
                else:
                    new_links = list(extracted)
                    successful_iterations = int(resume_state["successful_iterations"])
                    failed_iterations = int(resume_state["failed_iterations"])
                    requested_iterations = int(source.max_iterations)

                seen = set(results_by_source[source_name])
                for link in new_links:
                    inserted = True
                    already_accepted = link in accepted_unique_links
                    if run_store and not already_accepted:
                        inserted = run_store.record_raw_link(source_name, link)
                        if inserted and accepted_unique_links is not None:
                            accepted_unique_links.add(link)
                    if inserted and unique_link_callback and not already_accepted:
                        unique_link_callback(link)
                    if link in seen:
                        continue
                    seen.add(link)
                    results_by_source[source_name].append(link)

                if run_store:
                    progress_state = run_store.fetch_source_resume_state(source_name)
                    successful_iterations = int(progress_state["successful_iterations"])
                    failed_iterations = int(progress_state["failed_iterations"])

                source_counts[source_name] = {
                    "raw_links": len(results_by_source[source_name]),
                    "successful_iterations": successful_iterations,
                    "failed_iterations": failed_iterations,
                    "requested_iterations": requested_iterations,
                }

        raw_links: list[str] = []
        for source_name, _source in enabled_sources:
            raw_links.extend(results_by_source.get(source_name, []))
            source_counts.setdefault(
                source_name,
                {
                    "raw_links": len(results_by_source.get(source_name, [])),
                    "successful_iterations": int(resume_states[source_name]["successful_iterations"]),
                    "failed_iterations": int(resume_states[source_name]["failed_iterations"]),
                    "requested_iterations": int(_source.max_iterations),
                },
            )

        self._last_source_counts = source_counts
        self._last_source_links = {name: list(links) for name, links in results_by_source.items()}
        self._write_lines(artifact_dir / "vpn_node_raw.txt", raw_links)
        return raw_links

    def _call_extractor(
        self,
        source_name: str,
        source: Any,
        log: Callable[[str], None],
        run_store: RunStore | None,
        *,
        resume_state: dict[str, object],
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
        unique_link_callback: Callable[[str], None] | None = None,
        accepted_unique_links: set[str] | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {"progress_callback": log}
        signature = inspect.signature(self.extractor)
        parameters = signature.parameters
        accepts_kwargs = any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
        if run_store and (accepts_kwargs or "progress_state_callback" in parameters):
            base_successes = int(resume_state.get("successful_iterations", 0))
            base_failures = int(resume_state.get("failed_iterations", 0))

            def progress_state_callback(**payload: Any) -> None:
                payload["successful_iterations"] = base_successes + int(payload.get("successful_iterations", 0))
                payload["failed_iterations"] = base_failures + int(payload.get("failed_iterations", 0))
                run_store.record_source_progress(**payload)

            kwargs["progress_state_callback"] = progress_state_callback
        if run_store and (accepts_kwargs or "raw_link_callback" in parameters):
            def raw_link_callback(source_name: str, link: str) -> bool:
                inserted = run_store.record_raw_link(source_name, link)
                if inserted and accepted_unique_links is not None:
                    accepted_unique_links.add(link)
                if inserted and unique_link_callback:
                    unique_link_callback(link)
                return inserted

            kwargs["raw_link_callback"] = raw_link_callback
        if run_store and (accepts_kwargs or "attempt_callback" in parameters):
            kwargs["attempt_callback"] = lambda **payload: run_store.record_extract_attempt(**payload)
        if event_callback is not None and (accepts_kwargs or "event_callback" in parameters):
            kwargs["event_callback"] = event_callback
        return self.extractor(source_name, source, **kwargs)

    def _call_worker(
        self,
        worker: Callable[..., Any],
        *args: Any,
        progress_callback: Callable[[str], None] | None = None,
        event_callback: Callable[[str, dict[str, Any]], None] | None = None,
        worker_kwargs: dict[str, Any] | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {"progress_callback": progress_callback}
        signature = inspect.signature(worker)
        parameters = signature.parameters
        accepts_kwargs = any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
        if event_callback is not None and (accepts_kwargs or "event_callback" in parameters):
            kwargs["event_callback"] = event_callback
        for key, value in (worker_kwargs or {}).items():
            if accepts_kwargs or key in parameters:
                kwargs[key] = value
        return worker(*args, **kwargs)

    def _render_template(
        self,
        runtime_root: Path,
        artifact_dir: Path,
        links: list[str],
        *,
        profile: AppProfile | None = None,
    ) -> Path:
        template_path = self.template_path_resolver(runtime_root)
        if not template_path.exists() and profile is not None:
            compat_root = str(getattr(profile.workspace, "edgetunnel_root", "")).strip()
            if compat_root:
                fallback = Path(compat_root) / "vmess_node.js"
                if fallback.exists():
                    template_path = fallback
        rendered = replace_main_data(template_path.read_text(encoding="utf-8"), links)
        rendered_path = artifact_dir / "vmess_node.js"
        rendered_path.write_text(rendered, encoding="utf-8")
        return rendered_path

    def _default_verify(self, deploy: Any, api_token: Any) -> dict[str, bool]:
        if isinstance(api_token, str):
            credentials = resolve_cloudflare_credentials(deploy, {}, explicit_api_token=api_token)
        else:
            credentials = api_token
        client = _build_cloudflare_client(credentials)
        pages_domain_url = build_pages_project_root_url(deploy)
        pages_domain_ok = client.verify_url(pages_domain_url) if pages_domain_url else False
        secret_ok = client.verify_url(build_secret_url(deploy))
        subscription_ok = client.verify_url(_resolve_verify_subscription_url(deploy))
        custom_domain_url = build_custom_domain_root_url(deploy)
        custom_domain_ok = client.verify_url(custom_domain_url) if custom_domain_url else False
        custom_domain_subscription_url = _resolve_custom_domain_verify_subscription_url(deploy)
        custom_domain_subscription_ok = (
            client.verify_url(custom_domain_subscription_url) if custom_domain_subscription_url else False
        )
        custom_domain_dns_target = derive_custom_domain_dns_target(deploy)
        custom_domain_dns_ok = (
            client.verify_subdomain_cname(str(deploy.custom_domain), custom_domain_dns_target)
            if custom_domain_url and custom_domain_dns_target
            else False
        )
        return {
            "pages_domain_ok": pages_domain_ok,
            "secret_ok": secret_ok,
            "subscription_ok": subscription_ok,
            "custom_domain_ok": custom_domain_ok,
            "custom_domain_subscription_ok": custom_domain_subscription_ok,
            "custom_domain_dns_ok": custom_domain_dns_ok,
        }

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
                    "retry_context": summary.retry_context,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )


def _resolve_verify_subscription_url(deploy: Any) -> str:
    verify_subscription_url = str(getattr(deploy, "verify_subscription_url", "") or "").strip()
    if verify_subscription_url:
        return verify_subscription_url
    return str(deploy.subscription_url).strip()


def _resolve_custom_domain_verify_subscription_url(deploy: Any) -> str:
    return build_custom_domain_subscription_url(deploy).strip()


def _merge_deploy_verification_target(deploy: Any, deployment: dict[str, Any]) -> Any:
    merged = dict(vars(deploy))
    merged.update(
        {
            key: value
            for key, value in deployment.items()
            if key in {"project_name", "pages_project_url", "custom_domain"}
        }
    )
    return SimpleNamespace(**merged)


def _is_verify_success(verification: dict[str, bool]) -> bool:
    pages_domain_ok = verification.get("pages_domain_ok")
    if pages_domain_ok is None:
        pages_domain_ok = True
    if not (pages_domain_ok and verification.get("secret_ok") and verification.get("subscription_ok")):
        return False
    if verification.get("custom_domain_ok") and not verification.get("custom_domain_subscription_ok", True):
        return False
    if verification.get("custom_domain_ok") and not verification.get("custom_domain_dns_ok", True):
        return False
    return True


def _cleanup_blocked_pages_project(deploy: Any, deployment: dict[str, Any], api_token: Any) -> dict[str, Any]:
    final_project = str(getattr(deploy, "project_name", "") or "").strip()
    cleanup_candidates = []
    for key in ("cleanup_blocked_project", "share_project_cleanup_blocked_project"):
        candidate = str(deployment.get(key, "") or "").strip()
        if not candidate or candidate == final_project or candidate in cleanup_candidates:
            continue
        cleanup_candidates.append(candidate)
    if not cleanup_candidates:
        return {"cleanup_deleted": False, "cleanup_errors": deployment.get("cleanup_errors", [])}
    if isinstance(api_token, str):
        credentials = resolve_cloudflare_credentials(deploy, {}, explicit_api_token=api_token)
    else:
        credentials = api_token
    deleted_any = False
    errors: list[str] = []
    client = _build_cloudflare_client(credentials)
    for blocked_project in cleanup_candidates:
        try:
            client.delete_pages_project(blocked_project)
            deleted_any = True
        except Exception as exc:
            message = str(exc)
            response = getattr(exc, "response", None)
            body = ""
            if response is not None:
                try:
                    body = str(getattr(response, "text", "") or "")
                except Exception:
                    body = ""
            if body:
                message = f"{message}: {body}"
            errors.append(message)
    if errors:
        return {"cleanup_deleted": deleted_any, "cleanup_errors": errors}
    try:
        return {"cleanup_deleted": deleted_any, "cleanup_errors": []}
    except Exception as exc:
        return {"cleanup_deleted": deleted_any, "cleanup_errors": [str(exc)]}


def _build_cloudflare_client(credentials: Any) -> CloudflareClient:
    if getattr(credentials, "auth_mode", "api_token") == "global_key":
        return CloudflareClient(
            account_id=credentials.account_id,
            auth_mode="global_key",
            global_api_key=credentials.global_api_key,
            email=credentials.email,
        )
    return CloudflareClient(
        api_token=credentials.api_token,
        account_id=credentials.account_id,
    )
