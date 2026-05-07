import json
import re
import shutil
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

from vpn_automation.config.runtime import load_runtime_env
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.integrations.cloudflare import (
    CloudflareClient,
    build_custom_domain_root_url,
    build_custom_domain_subscription_url,
    build_pages_project_root_url,
    build_secret_url,
    derive_custom_domain_dns_target,
    resolve_cloudflare_credentials,
)
from vpn_automation.integrations.node_tools import obfuscate_javascript
from vpn_automation.pipeline.availability import check_link_availability_batch
from vpn_automation.pipeline.controller import PipelineController, PipelineSummary
from vpn_automation.pipeline.package import build_pages_bundle
from vpn_automation.pipeline.postprocess import (
    FilterConfig,
    decorate_link_with_country,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.render import replace_main_data
from vpn_automation.pipeline.run_store import DEFAULT_STAGES, RunStore
from vpn_automation.pipeline.speedtest import (
    ProbeResult,
    SpeedTestResult,
    probe_vmess_link,
    select_speedtest_candidates,
    test_vmess_link,
)
from vpn_automation.pipeline.vmess import parse_vmess_link
from vpn_automation.pipeline.worker_build import build_worker_artifacts


RETRYABLE_STAGES = (
    "speedtest",
    "availability",
    "postprocess",
    "render",
    "obfuscate",
    "deploy",
    "verify",
)

ARTIFACT_DIR_PATTERN = re.compile(r"^\d{8}-\d{6}$")


def _has_non_empty_file(path: Path) -> bool:
    return path.exists() and bool(path.read_text(encoding="utf-8").strip())


def _load_stage_status(artifact_dir: Path) -> dict[str, str]:
    report = _load_json(artifact_dir / "pipeline_report.json")
    return dict(report.get("stage_status", {}))


def _count_run_db_rows(db_path: Path, table_name: str) -> int:
    if not db_path.exists():
        return 0
    store = RunStore(db_path)
    return store.count_links(table_name)


def _build_artifact_retry_item(artifact_dir: Path) -> dict[str, Any]:
    report = _load_json(artifact_dir / "pipeline_report.json")
    stage_status = dict(report.get("stage_status", {}))
    counts = dict(report.get("counts", {}))
    source_counts = dict(report.get("source_counts", {}))
    retry_context = dict(report.get("retry_context", {}))
    run_db_path = artifact_dir / "run.db"

    retryable_stages: list[str] = []
    if _has_non_empty_file(artifact_dir / "vpn_node_deduped.txt"):
        retryable_stages.append("speedtest")
    if _has_non_empty_file(artifact_dir / "vpn_node_speedtest.txt") and _count_run_db_rows(run_db_path, "speedtest_results") > 0:
        retryable_stages.append("availability")
    if _has_non_empty_file(artifact_dir / "vpn_node_availability.txt") and _count_run_db_rows(run_db_path, "speedtest_results") > 0:
        retryable_stages.append("postprocess")
    if _has_non_empty_file(artifact_dir / "vpn_node_emoji.txt"):
        retryable_stages.append("render")
    if (artifact_dir / "vmess_node.js").exists():
        retryable_stages.append("obfuscate")
    if (artifact_dir / "_worker.js").exists():
        retryable_stages.append("deploy")
    if stage_status.get("deploy") == "success":
        retryable_stages.append("verify")

    return {
        "artifact_dir": str(artifact_dir),
        "artifact_name": artifact_dir.name,
        "run_status": report.get("run_status", ""),
        "stage_status": stage_status,
        "counts": counts,
        "source_counts": source_counts,
        "retry_context": retry_context,
        "retryable_stages": retryable_stages,
        "updated_at": datetime.fromtimestamp(artifact_dir.stat().st_mtime).isoformat(),
    }


def _is_retry_artifact_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    if not ARTIFACT_DIR_PATTERN.fullmatch(path.name):
        return False
    return (path / "run.db").exists() or (path / "pipeline_report.json").exists()


def _create_retry_artifact_dir(project_root: Path) -> Path:
    root = project_root / "artifacts"
    root.mkdir(parents=True, exist_ok=True)
    artifact_dir = root / datetime.now().strftime("%Y%m%d-%H%M%S")
    artifact_dir.mkdir(parents=True, exist_ok=True)
    return artifact_dir


def _copy_if_exists(source: Path, target: Path) -> None:
    if source.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def _copy_table(source_db: Path, target_db: Path, table_name: str) -> None:
    if not source_db.exists() or not target_db.exists():
        return
    with sqlite3.connect(source_db) as source_connection, sqlite3.connect(target_db) as target_connection:
        rows = source_connection.execute(f"SELECT * FROM {table_name}").fetchall()
        if not rows:
            return
        column_count = len(rows[0])
        placeholders = ",".join("?" for _ in range(column_count))
        target_connection.executemany(
            f"INSERT INTO {table_name} VALUES ({placeholders})",
            rows,
        )


def _seed_retry_artifact(
    source_artifact_dir: Path,
    retry_artifact_dir: Path,
    stage_name: str,
    retry_context: dict[str, Any],
) -> None:
    source_report = _load_json(source_artifact_dir / "pipeline_report.json")
    report = {
        "artifact_dir": str(retry_artifact_dir),
        "run_status": "pending",
        "error": "",
        "stage_status": {stage: "pending" for stage in DEFAULT_STAGES},
        "counts": dict(source_report.get("counts", {})),
        "source_counts": dict(source_report.get("source_counts", {})),
        "deployment": dict(source_report.get("deployment", {})),
        "retry_context": retry_context,
    }
    (retry_artifact_dir / "pipeline_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    retry_store = RunStore(retry_artifact_dir / "run.db")
    retry_store.initialize(artifact_dir=str(retry_artifact_dir))

    _copy_if_exists(source_artifact_dir / "vpn_node_raw.txt", retry_artifact_dir / "vpn_node_raw.txt")
    _copy_if_exists(source_artifact_dir / "vpn_node_deduped.txt", retry_artifact_dir / "vpn_node_deduped.txt")

    if stage_name in {"availability", "postprocess", "render", "obfuscate", "deploy", "verify"}:
        _copy_if_exists(source_artifact_dir / "vpn_node_speedtest.txt", retry_artifact_dir / "vpn_node_speedtest.txt")
        _copy_table(source_artifact_dir / "run.db", retry_artifact_dir / "run.db", "speedtest_results")
    if stage_name in {"postprocess", "render", "obfuscate", "deploy", "verify"}:
        _copy_if_exists(source_artifact_dir / "vpn_node_availability.txt", retry_artifact_dir / "vpn_node_availability.txt")
        _copy_if_exists(
            source_artifact_dir / "vpn_node_availability_report.json",
            retry_artifact_dir / "vpn_node_availability_report.json",
        )
        _copy_table(source_artifact_dir / "run.db", retry_artifact_dir / "run.db", "availability_results")
    if stage_name in {"render", "obfuscate", "deploy", "verify"}:
        _copy_if_exists(source_artifact_dir / "vpn_node_emoji.txt", retry_artifact_dir / "vpn_node_emoji.txt")
        _copy_table(source_artifact_dir / "run.db", retry_artifact_dir / "run.db", "final_links")
    if stage_name in {"obfuscate", "deploy", "verify"}:
        _copy_if_exists(source_artifact_dir / "vmess_node.js", retry_artifact_dir / "vmess_node.js")
    if stage_name in {"deploy", "verify"}:
        _copy_if_exists(source_artifact_dir / "_worker.js", retry_artifact_dir / "_worker.js")
    if stage_name == "verify":
        _copy_if_exists(source_artifact_dir / "pages_bundle" / "_worker.js", retry_artifact_dir / "pages_bundle" / "_worker.js")


def _seed_completed_stage_status(
    summary: PipelineSummary,
    run_store: RunStore,
    stage_name: str,
) -> None:
    seen_target = False
    for name in DEFAULT_STAGES:
        if name == stage_name:
            seen_target = True
        if seen_target:
            continue
        summary.stage_status[name] = "success"
        run_store.record_stage_event(name, "success")


def _read_speedtest_results_from_db(artifact_dir: Path) -> list[SpeedTestResult]:
    db_path = artifact_dir / "run.db"
    if not db_path.exists():
        return []
    with sqlite3.connect(db_path) as connection:
        rows = connection.execute(
            """
            SELECT link, reachable, average_download_mb_s, latency_ms, error
            FROM speedtest_results
            ORDER BY average_download_mb_s DESC, rowid ASC
            """
        ).fetchall()
    return [
        SpeedTestResult(
            link=str(link),
            reachable=bool(reachable),
            average_download_mb_s=float(average_download_mb_s),
            latency_ms=int(latency_ms),
            error=str(error or ""),
        )
        for link, reachable, average_download_mb_s, latency_ms, error in rows
    ]


def _read_available_speed_results(artifact_dir: Path) -> list[SpeedTestResult]:
    available_links = set(_read_non_empty_lines(artifact_dir / "vpn_node_availability.txt"))
    speedtest_by_link = {
        result.link: result for result in _read_speedtest_results_from_db(artifact_dir)
    }
    return [speedtest_by_link[link] for link in available_links if link in speedtest_by_link]


def _retry_from_speedtest(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    *,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "speedtest")
    raw_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_raw.txt")
    deduped_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_deduped.txt")
    if not deduped_links:
        raise RuntimeError("No deduped links available to retry speedtest")
    summary.counts["raw_links"] = len(raw_links)
    summary.counts["deduped_links"] = len(deduped_links)

    set_stage("speedtest", "running")
    speedtest_results = controller._call_worker(
        controller.speedtester,
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
    controller._write_lines(retry_artifact_dir / "vpn_node_speedtest.txt", [result.link for result in fast_results])
    summary.counts["speedtest_links"] = len(fast_results)
    if not fast_results:
        set_stage("speedtest", "failed")
        summary.run_status = "failed"
        summary.error = "RuntimeError: No links passed speed test"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    set_stage("speedtest", "success")
    return _continue_after_speedtest_results(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        run_store,
        fast_results,
        event_callback=event_callback,
    )


def _retry_from_availability(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    *,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "availability")
    raw_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_raw.txt")
    deduped_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_deduped.txt")
    fast_results = [
        result
        for result in _read_speedtest_results_from_db(retry_artifact_dir)
        if result.link in set(_read_non_empty_lines(retry_artifact_dir / "vpn_node_speedtest.txt"))
    ]
    summary.counts["raw_links"] = len(raw_links)
    summary.counts["deduped_links"] = len(deduped_links)
    summary.counts["speedtest_links"] = len(fast_results)
    if not fast_results:
        raise RuntimeError("No speedtest results available to retry availability")
    return _continue_after_speedtest_results(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        run_store,
        fast_results,
        start_at="availability",
        event_callback=event_callback,
    )


def _retry_from_postprocess(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "postprocess")
    raw_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_raw.txt")
    deduped_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_deduped.txt")
    available_results = _read_available_speed_results(retry_artifact_dir)
    summary.counts["raw_links"] = len(raw_links)
    summary.counts["deduped_links"] = len(deduped_links)
    summary.counts["speedtest_links"] = len(_read_non_empty_lines(retry_artifact_dir / "vpn_node_speedtest.txt"))
    summary.counts["availability_links"] = len(available_results)
    if not available_results:
        raise RuntimeError("No availability inputs available to retry postprocess")
    return _continue_after_available_results(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        run_store,
        available_results,
    )


def _retry_from_render(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "render")
    decorated_links = _read_non_empty_lines(source_artifact_dir / "vpn_node_emoji.txt")
    if not decorated_links:
        raise RuntimeError("No postprocess output available to retry render")
    summary.counts["final_links"] = len(decorated_links)
    summary.counts["postprocess_links"] = len(decorated_links)
    return _continue_after_decorated_links(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        decorated_links,
        start_at="render",
    )


def _retry_from_obfuscate(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "obfuscate")
    rendered_path = retry_artifact_dir / "vmess_node.js"
    if not rendered_path.exists():
        raise RuntimeError("No rendered template available to retry obfuscate")
    return _continue_after_rendered_script(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        rendered_path,
        start_at="obfuscate",
    )


def _retry_from_deploy(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    source_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    *,
    api_token: str,
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "deploy")
    obfuscated_path = retry_artifact_dir / "_worker.js"
    if not obfuscated_path.exists():
        raise RuntimeError("No obfuscated worker available to retry deploy")
    return _continue_after_obfuscated_script(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        obfuscated_path,
        api_token=api_token,
        start_at="deploy",
    )


def _retry_from_verify(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    *,
    api_token: str,
) -> PipelineSummary:
    run_store = RunStore(retry_artifact_dir / "run.db")
    _seed_completed_stage_status(summary, run_store, "verify")
    return _run_verify_only(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        api_token=api_token,
    )


def _continue_after_speedtest_results(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    run_store: RunStore,
    fast_results: list[SpeedTestResult],
    *,
    start_at: str = "speedtest",
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    if start_at == "speedtest":
        summary.counts["speedtest_links"] = len(fast_results)
    set_stage("availability", "running")
    availability_results = controller._call_worker(
        controller.availability_checker,
        fast_results,
        profile.speed_test,
        progress_callback=log,
        event_callback=event_callback,
        worker_kwargs={"targets": profile.availability_targets},
    )
    available_results = [item.speed_result for item in availability_results if item.all_passed]
    for item in availability_results:
        for provider_name, provider_result in item.provider_results.items():
            run_store.record_availability_result(
                link=item.speed_result.link,
                provider=provider_name,
                passed=provider_result.passed,
                reason=provider_result.reason,
            )
    available_links = [item.link for item in available_results]
    controller._write_lines(retry_artifact_dir / "vpn_node_availability.txt", available_links)
    (retry_artifact_dir / "vpn_node_availability_report.json").write_text(
        json.dumps([item.to_dict() for item in availability_results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    summary.counts["availability_links"] = len(available_links)
    if not available_links:
        set_stage("availability", "failed")
        summary.run_status = "failed"
        summary.error = "RuntimeError: No links passed availability"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    set_stage("availability", "success")
    return _continue_after_available_results(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        run_store,
        available_results,
    )


def _continue_after_available_results(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    run_store: RunStore,
    available_results: list[SpeedTestResult],
) -> PipelineSummary:
    set_stage("postprocess", "running")
    ranked_links: list[tuple[str, SpeedTestResult, str]] = []
    for result in available_results:
        country_code = controller.country_lookup(parse_vmess_link(result.link)["add"])
        ranked_links.append((result.link, result, country_code))
    selected_links = select_links_by_country_limit(ranked_links, getattr(profile, "filters", FilterConfig()))
    selected_country = {link: country for link, _result, country in ranked_links}
    decorated_links = [
        decorate_link_with_country(link, selected_country[link]) for link in selected_links
    ]
    for link in selected_links:
        run_store.record_final_link(stage_name="postprocess", link=link, country_code=selected_country[link])
    controller._write_lines(retry_artifact_dir / "vpn_node_emoji.txt", decorated_links)
    summary.counts["postprocess_links"] = len(decorated_links)
    summary.counts["final_links"] = len(decorated_links)
    if not decorated_links:
        set_stage("postprocess", "failed")
        summary.run_status = "failed"
        summary.error = "RuntimeError: No links remained after postprocess filters"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    set_stage("postprocess", "success")
    return _continue_after_decorated_links(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        decorated_links,
    )


def _continue_after_decorated_links(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    decorated_links: list[str],
    *,
    start_at: str = "postprocess",
) -> PipelineSummary:
    set_stage("render", "running")
    rendered_path = controller._render_template(
        Path(profile.workspace.project_root or __file__),
        retry_artifact_dir,
        decorated_links,
        profile=profile,
    )
    set_stage("render", "success")
    return _continue_after_rendered_script(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        rendered_path,
    )


def _continue_after_rendered_script(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    rendered_path: Path,
    *,
    start_at: str = "render",
) -> PipelineSummary:
    set_stage("obfuscate", "running")
    obfuscated_path = retry_artifact_dir / "_worker.js"
    controller.obfuscator(rendered_path, obfuscated_path)
    if not obfuscated_path.exists():
        set_stage("obfuscate", "failed")
        summary.run_status = "failed"
        summary.error = "RuntimeError: _worker.js was not created by the obfuscation step"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    set_stage("obfuscate", "success")
    env = controller.env_loader(Path(profile.workspace.project_root or __file__))
    api_token = resolve_cloudflare_credentials(profile.deploy, env)
    return _continue_after_obfuscated_script(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        obfuscated_path,
        api_token=api_token,
    )


def _continue_after_obfuscated_script(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    obfuscated_path: Path,
    *,
    api_token: Any,
    start_at: str = "obfuscate",
) -> PipelineSummary:
    set_stage("deploy", "running")
    bundle_dir = build_pages_bundle(obfuscated_path.read_text(encoding="utf-8"), retry_artifact_dir / "pages_bundle")
    log(
        f"[deploy] project={profile.deploy.project_name} "
        f"bundle={bundle_dir} url={profile.deploy.pages_project_url}"
    )
    deployment = controller.deployer(bundle_dir, profile.deploy, api_token)
    summary.deployment = deployment
    if deployment.get("returncode", 1) != 0:
        set_stage("deploy", "failed")
        summary.run_status = "failed"
        summary.error = f"RuntimeError: Cloudflare deployment failed: {deployment}"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    log(
        f"[deploy] returncode={deployment.get('returncode')} "
        f"attempts={','.join(item['mode'] for item in deployment.get('attempts', []))}"
    )
    set_stage("deploy", "success")
    return _run_verify_only(
        controller,
        profile,
        retry_artifact_dir,
        summary,
        log,
        set_stage,
        api_token=api_token,
    )


def _run_verify_only(
    controller: PipelineController,
    profile: Any,
    retry_artifact_dir: Path,
    summary: PipelineSummary,
    log: Callable[[str], None],
    set_stage: Callable[[str, str], None],
    *,
    api_token: Any,
) -> PipelineSummary:
    set_stage("verify", "running")
    verification_target = _merge_deploy_verification_target(profile.deploy, summary.deployment)
    verification = controller.verifier(
        verification_target,
        api_token,
    )
    if not _is_verify_success(verification):
        summary.deployment.update(verification)
        set_stage("verify", "failed")
        summary.run_status = "failed"
        summary.error = f"RuntimeError: Verification failed: {verification}"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        return summary
    cleanup = _cleanup_blocked_pages_project(verification_target, summary.deployment, api_token)
    summary.deployment.update(verification)
    summary.deployment.update(cleanup)
    set_stage("verify", "success")
    summary.run_status = "success"
    summary.error = ""
    controller._write_pipeline_report(retry_artifact_dir, summary)
    return summary


def _read_non_empty_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _default_verify(deploy: Any, api_token: Any) -> dict[str, bool]:
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
            errors.append(str(exc))
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


def list_artifacts_with_retry_stages(project_root: Path, *, limit: int = 20) -> list[dict[str, Any]]:
    artifacts_root = project_root / "artifacts"
    if not artifacts_root.exists():
        return []

    candidates = sorted(
        [path for path in artifacts_root.iterdir() if _is_retry_artifact_dir(path)],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )[:limit]
    return [_build_artifact_retry_item(path) for path in candidates]


def retry_pipeline_from_stage(
    artifact_dir: Path,
    *,
    stage_name: str,
    project_root: Path,
    log_callback: Callable[[str], None] | None = None,
    stage_callback: Callable[[str, str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    source_artifact_dir = Path(artifact_dir).resolve()
    if not source_artifact_dir.exists():
        raise FileNotFoundError(f"artifact dir not found: {source_artifact_dir}")
    if stage_name not in RETRYABLE_STAGES:
        raise RuntimeError(f"Unsupported retry stage: {stage_name}")

    source_item = _build_artifact_retry_item(source_artifact_dir)
    if stage_name not in source_item["retryable_stages"]:
        raise RuntimeError(f"Stage is not retryable for artifact: {stage_name}")

    profile = ProfileStore(resolve_profile_path(project_root)).load_or_create(project_root)
    controller = PipelineController(
        availability_checker=check_link_availability_batch,
        country_lookup=lookup_country_code,
        obfuscator=obfuscate_javascript,
        env_loader=load_runtime_env,
        verifier=_default_verify,
        artifact_retention_count=99,
    )
    retry_artifact_dir = _create_retry_artifact_dir(project_root)
    retry_context = {
        "source_artifact_dir": str(source_artifact_dir),
        "source_artifact_name": source_artifact_dir.name,
        "start_stage": stage_name,
    }
    _seed_retry_artifact(source_artifact_dir, retry_artifact_dir, stage_name, retry_context)

    report = _load_json(retry_artifact_dir / "pipeline_report.json")
    stage_status = {name: "pending" for name in controller.stage_names()}
    stage_status.update(report.get("stage_status", {}))
    summary = PipelineSummary(
        artifact_dir=str(retry_artifact_dir),
        stage_status=stage_status,
        counts=dict(report.get("counts", {})),
        source_counts=dict(report.get("source_counts", {})),
        deployment=dict(report.get("deployment", {})),
        retry_context=retry_context,
        run_status=str(report.get("run_status", "pending")),
        error=str(report.get("error", "")),
    )
    run_store = RunStore(retry_artifact_dir / "run.db")
    current_stage = ""

    def log(message: str) -> None:
        if log_callback:
            log_callback(message)

    def set_stage(stage_key: str, status: str) -> None:
        nonlocal current_stage
        summary.stage_status[stage_key] = status
        run_store.record_stage_event(stage_key, status)
        if status == "running":
            current_stage = stage_key
        elif current_stage == stage_key and status in {"success", "failed", "skipped"}:
            current_stage = ""
        if stage_callback:
            stage_callback(stage_key, status)
        controller._write_pipeline_report(retry_artifact_dir, summary)

    env = controller.env_loader(Path(profile.workspace.project_root or __file__))
    api_token = None
    if stage_name in {"deploy", "verify"}:
        api_token = resolve_cloudflare_credentials(profile.deploy, env)

    _emit_event(
        event_callback,
        "run_started",
        artifact_dir=str(retry_artifact_dir),
        skip_deploy=False,
        skip_verify=False,
        retry_stage=stage_name,
        source_artifact_dir=str(source_artifact_dir),
    )
    log(f"[retry] source={source_artifact_dir.name} stage={stage_name}")
    try:
        if stage_name == "speedtest":
            return _retry_from_speedtest(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
                event_callback=event_callback,
            )
        if stage_name == "availability":
            return _retry_from_availability(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
                event_callback=event_callback,
            )
        if stage_name == "postprocess":
            return _retry_from_postprocess(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
            )
        if stage_name == "render":
            return _retry_from_render(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
            )
        if stage_name == "obfuscate":
            return _retry_from_obfuscate(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
            )
        if stage_name == "deploy":
            return _retry_from_deploy(
                controller,
                profile,
                retry_artifact_dir,
                source_artifact_dir,
                summary,
                log,
                set_stage,
                api_token=api_token,
            )
        return _retry_from_verify(
            controller,
            profile,
            retry_artifact_dir,
            summary,
            log,
            set_stage,
            api_token=api_token,
        )
    except Exception as exc:
        if current_stage and summary.stage_status.get(current_stage) == "running":
            set_stage(current_stage, "failed")
        summary.run_status = "failed"
        summary.error = f"{exc.__class__.__name__}: {exc}"
        controller._write_pipeline_report(retry_artifact_dir, summary)
        raise


def _emit_event(
    event_callback: Callable[[str, dict[str, Any]], None] | None,
    event_type: str,
    **payload: Any,
) -> None:
    if event_callback:
        event_callback(event_type, payload)


def _parse_resume_state(event_log_path: Path) -> tuple[dict[str, ProbeResult], dict[str, SpeedTestResult]]:
    probes: dict[str, ProbeResult] = {}
    full_results: dict[str, SpeedTestResult] = {}
    if not event_log_path.exists():
        return probes, full_results

    for line in event_log_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if not line.strip():
            continue
        payload = json.loads(line)
        event_type = payload.get("type", "")
        if event_type == "speedtest_probe_result":
            link = str(payload.get("link", "")).strip()
            if not link:
                continue
            probes[link] = ProbeResult(
                link=link,
                reachable=bool(payload.get("reachable")),
                latency_ms=int(payload.get("latency_ms", 0)),
                error=str(payload.get("error", "")),
            )
        elif event_type == "speedtest_result":
            link = str(payload.get("link", "")).strip()
            if not link:
                continue
            full_results[link] = SpeedTestResult(
                link=link,
                reachable=bool(payload.get("reachable")),
                average_download_mb_s=float(payload.get("average_download_mb_s", 0.0) or 0.0),
                latency_ms=int(payload.get("latency_ms", 0)),
                error=str(payload.get("error", "")),
            )
    return probes, full_results


def _read_speedtest_results(
    artifact_dir: Path,
    event_log_path: Path,
) -> list[SpeedTestResult]:
    passed_links = set(_read_non_empty_lines(artifact_dir / "vpn_node_speedtest.txt"))
    if not passed_links:
        return []

    _probes, full_results = _parse_resume_state(event_log_path)
    selected = [result for link, result in full_results.items() if link in passed_links]
    selected.sort(key=lambda item: item.average_download_mb_s, reverse=True)
    return selected


def resume_speedtest_session(
    session_dir: Path,
    *,
    project_root: Path,
    log_callback: Callable[[str], None] | None = None,
    stage_callback: Callable[[str, str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    session_dir = Path(session_dir).resolve()
    session_payload = _load_json(session_dir / "session.json")
    artifact_dir = Path(session_payload.get("artifact_dir", "")).resolve()
    if not artifact_dir.exists():
        raise FileNotFoundError(f"artifact dir not found: {artifact_dir}")

    profile = ProfileStore(resolve_profile_path(project_root)).load_or_create(project_root)
    controller = PipelineController()
    report = _load_json(artifact_dir / "pipeline_report.json")

    stage_status = {name: "pending" for name in controller.stage_names()}
    stage_status.update(report.get("stage_status", {}))
    summary = PipelineSummary(
        artifact_dir=str(artifact_dir),
        stage_status=stage_status,
        counts=dict(report.get("counts", {})),
        source_counts=dict(report.get("source_counts", {})),
        deployment=dict(report.get("deployment", {})),
        run_status=str(report.get("run_status", "pending")),
        error=str(report.get("error", "")),
    )

    def log(message: str) -> None:
        if log_callback:
            log_callback(message)

    def set_stage(stage_name: str, status: str) -> None:
        summary.stage_status[stage_name] = status
        if stage_callback:
            stage_callback(stage_name, status)

    for base_stage in ("doctor", "extract", "dedupe"):
        if summary.stage_status.get(base_stage) == "pending":
            summary.stage_status[base_stage] = "success"

    raw_links = _read_non_empty_lines(artifact_dir / "vpn_node_raw.txt")
    deduped_links = _read_non_empty_lines(artifact_dir / "vpn_node_deduped.txt")
    summary.counts["raw_links"] = len(raw_links)
    summary.counts["deduped_links"] = len(deduped_links)

    probes, full_results = _parse_resume_state(Path(session_payload.get("event_log", session_dir / "events.jsonl")))

    _emit_event(
        event_callback,
        "speedtest_resume_state",
        resumed_probe_count=len(probes),
        resumed_full_count=len(full_results),
        total_links=len(deduped_links),
    )
    log(
        f"[resume] speedtest resume from probe={len(probes)}/{len(deduped_links)} "
        f"full={len(full_results)}"
    )

    set_stage("speedtest", "running")
    controller._write_pipeline_report(artifact_dir, summary)

    remaining_probe_links = [link for link in deduped_links if link not in probes]
    if remaining_probe_links:
        with ThreadPoolExecutor(max_workers=max(1, profile.speed_test.concurrency)) as executor:
            futures = {
                executor.submit(probe_vmess_link, link, profile.speed_test): link for link in remaining_probe_links
            }
            for completed_index, future in enumerate(as_completed(futures), start=len(probes) + 1):
                result = future.result()
                probes[result.link] = result
                log(
                    f"[speedtest:probe] {completed_index}/{len(deduped_links)} "
                    f"reachable={result.reachable} latency={result.latency_ms}ms"
                )
                _emit_event(
                    event_callback,
                    "speedtest_probe_result",
                    completed=completed_index,
                    total=len(deduped_links),
                    link=result.link,
                    reachable=result.reachable,
                    latency_ms=result.latency_ms,
                    error=result.error,
                )

    ordered_probes = [probes[link] for link in deduped_links if link in probes]
    candidate_links = select_speedtest_candidates(ordered_probes, profile.speed_test.max_download_candidates)

    log(
        f"[speedtest] selected {len(candidate_links)}/"
        f"{sum(1 for probe in ordered_probes if probe.reachable)} reachable links for full download test"
    )
    _emit_event(
        event_callback,
        "speedtest_selected",
        total_links=len(deduped_links),
        reachable_count=sum(1 for probe in ordered_probes if probe.reachable),
        candidate_count=len(candidate_links),
    )

    remaining_full_links = [link for link in candidate_links if link not in full_results]
    if remaining_full_links:
        with ThreadPoolExecutor(max_workers=max(1, profile.speed_test.concurrency)) as executor:
            futures = {
                executor.submit(test_vmess_link, link, profile.speed_test): link for link in remaining_full_links
            }
            for completed_index, future in enumerate(as_completed(futures), start=len(full_results) + 1):
                result = future.result()
                full_results[result.link] = result
                passed_threshold = (
                    result.reachable and result.average_download_mb_s >= profile.speed_test.min_download_mb_s
                )
                log(
                    f"[speedtest] {completed_index}/{len(candidate_links)} "
                    f"reachable={result.reachable} speed={result.average_download_mb_s}MB/s"
                )
                _emit_event(
                    event_callback,
                    "speedtest_result",
                    completed=completed_index,
                    total=len(candidate_links),
                    link=result.link,
                    reachable=result.reachable,
                    average_download_mb_s=result.average_download_mb_s,
                    latency_ms=result.latency_ms,
                    passed_threshold=passed_threshold,
                    error=result.error,
                )

    ordered_full_results = [full_results[link] for link in candidate_links if link in full_results]
    fast_results = [
        result
        for result in ordered_full_results
        if result.reachable and result.average_download_mb_s >= profile.speed_test.min_download_mb_s
    ]
    fast_results.sort(key=lambda item: item.average_download_mb_s, reverse=True)
    controller._write_lines(artifact_dir / "vpn_node_speedtest.txt", [result.link for result in fast_results])
    summary.counts["speedtest_links"] = len(fast_results)
    log(f"[speedtest] kept {len(fast_results)} links above threshold")

    if fast_results:
        set_stage("speedtest", "success")
        summary.run_status = "success"
        summary.error = ""
    else:
        set_stage("speedtest", "failed")
        summary.run_status = "failed"
        summary.error = "RuntimeError: No links passed speed test"

    controller._write_pipeline_report(artifact_dir, summary)
    return summary


def continue_pipeline_session(
    session_dir: Path,
    *,
    project_root: Path,
    log_callback: Callable[[str], None] | None = None,
    stage_callback: Callable[[str, str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> PipelineSummary:
    session_dir = Path(session_dir).resolve()
    session_payload = _load_json(session_dir / "session.json")
    artifact_dir = Path(session_payload.get("artifact_dir", "")).resolve()
    if not artifact_dir.exists():
        raise FileNotFoundError(f"artifact dir not found: {artifact_dir}")

    event_log_path = Path(str(session_payload.get("event_log", session_dir / "events.jsonl"))).resolve()
    profile = ProfileStore(resolve_profile_path(project_root)).load_or_create(project_root)
    controller = PipelineController(
        availability_checker=check_link_availability_batch,
        country_lookup=lookup_country_code,
        obfuscator=obfuscate_javascript,
        env_loader=load_runtime_env,
        verifier=_default_verify,
    )
    report = _load_json(artifact_dir / "pipeline_report.json")
    stage_status = {name: "pending" for name in controller.stage_names()}
    stage_status.update(report.get("stage_status", {}))
    summary = PipelineSummary(
        artifact_dir=str(artifact_dir),
        stage_status=stage_status,
        counts=dict(report.get("counts", {})),
        source_counts=dict(report.get("source_counts", {})),
        deployment=dict(report.get("deployment", {})),
        run_status=str(report.get("run_status", "pending")),
        error=str(report.get("error", "")),
    )

    def log(message: str) -> None:
        if log_callback:
            log_callback(message)

    def set_stage(stage_name: str, status: str) -> None:
        summary.stage_status[stage_name] = status
        if stage_callback:
            stage_callback(stage_name, status)

    raw_links = _read_non_empty_lines(artifact_dir / "vpn_node_raw.txt")
    deduped_links = _read_non_empty_lines(artifact_dir / "vpn_node_deduped.txt")
    summary.counts["raw_links"] = len(raw_links)
    summary.counts["deduped_links"] = len(deduped_links)
    for stage_name in ("doctor", "extract", "dedupe", "speedtest"):
        if summary.stage_status.get(stage_name) in {"pending", "failed"}:
            summary.stage_status[stage_name] = "success"

    fast_results = _read_speedtest_results(artifact_dir, event_log_path)
    summary.counts["speedtest_links"] = len(fast_results)
    if not fast_results:
        raise RuntimeError("No speedtest results available to continue pipeline")

    controller._write_pipeline_report(artifact_dir, summary)
    _emit_event(
        event_callback,
        "resume_pipeline_state",
        speedtest_links=len(fast_results),
        artifact_dir=str(artifact_dir),
    )
    log(f"[resume] continue pipeline from speedtest_links={len(fast_results)}")

    env = controller.env_loader(Path(profile.workspace.project_root or __file__))
    api_token = resolve_cloudflare_credentials(profile.deploy, env)

    set_stage("availability", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    availability_results = controller.availability_checker(
        fast_results,
        profile.speed_test,
        progress_callback=log,
        event_callback=event_callback,
    )
    available_results = [item.speed_result for item in availability_results if item.all_passed]
    available_links = [item.link for item in available_results]
    controller._write_lines(artifact_dir / "vpn_node_availability.txt", available_links)
    (artifact_dir / "vpn_node_availability_report.json").write_text(
        json.dumps([item.to_dict() for item in availability_results], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    set_stage("availability", "success")
    summary.counts["availability_links"] = len(available_links)
    log(f"[availability] kept {len(available_links)} links after provider validation")
    controller._write_pipeline_report(artifact_dir, summary)
    if not available_links:
        raise RuntimeError("No links passed availability")

    set_stage("postprocess", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    ranked_links: list[tuple[str, object, str]] = []
    for result in available_results:
        country_code = controller.country_lookup(parse_vmess_link(result.link)["add"])
        ranked_links.append((result.link, result, country_code))
    selected_links = select_links_by_country_limit(ranked_links, profile.filters)
    selected_country = {link: country for link, _result, country in ranked_links}
    decorated_links = [
        decorate_link_with_country(link, selected_country[link]) for link in selected_links
    ]
    controller._write_lines(artifact_dir / "vpn_node_emoji.txt", decorated_links)
    set_stage("postprocess", "success")
    summary.counts["postprocess_links"] = len(decorated_links)
    summary.counts["final_links"] = len(decorated_links)
    controller._write_pipeline_report(artifact_dir, summary)
    if not decorated_links:
        raise RuntimeError("No links remained after postprocess filters")

    set_stage("render", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    template_path = Path(profile.workspace.edgetunnel_root) / "vmess_node.js"
    rendered = replace_main_data(template_path.read_text(encoding="utf-8"), decorated_links)
    rendered_path = artifact_dir / "vmess_node.js"
    rendered_path.write_text(rendered, encoding="utf-8")
    set_stage("render", "success")

    set_stage("obfuscate", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    build_artifacts = build_worker_artifacts(
        rendered_path.read_text(encoding="utf-8"),
        profile.worker_build,
        profile.deploy.secret_query,
    )
    transformed_path = artifact_dir / "worker_transformed.js"
    transformed_path.write_text(build_artifacts.transformed_source, encoding="utf-8")
    obfuscated_path = artifact_dir / profile.worker_build.entry_filename
    controller.obfuscator(transformed_path, obfuscated_path)
    if not obfuscated_path.exists():
        raise RuntimeError("_worker.js was not created by the obfuscation step")
    summary.counts["worker_modules"] = len(build_artifacts.modules)
    set_stage("obfuscate", "success")
    controller._write_pipeline_report(artifact_dir, summary)

    set_stage("deploy", "running")
    controller._write_pipeline_report(artifact_dir, summary)
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
    deployment = controller.deployer(bundle_dir, profile.deploy, api_token)
    summary.deployment = deployment
    if deployment.get("returncode", 1) != 0:
        raise RuntimeError(f"Cloudflare deployment failed: {deployment}")
    log(
        f"[deploy] returncode={deployment.get('returncode')} "
        f"attempts={','.join(item['mode'] for item in deployment.get('attempts', []))}"
    )
    set_stage("deploy", "success")
    controller._write_pipeline_report(artifact_dir, summary)

    set_stage("verify", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    verification_target = _merge_deploy_verification_target(profile.deploy, deployment)
    verification = controller.verifier(
        verification_target,
        api_token,
    )
    if not _is_verify_success(verification):
        raise RuntimeError(f"Verification failed: {verification}")
    cleanup = _cleanup_blocked_pages_project(verification_target, deployment, api_token)
    summary.deployment.update(verification)
    summary.deployment.update(cleanup)
    set_stage("verify", "success")

    summary.run_status = "success"
    summary.error = ""
    controller._write_pipeline_report(artifact_dir, summary)
    return summary
