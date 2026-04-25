import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable

from vpn_automation.config.runtime import load_runtime_env
from vpn_automation.config.store import ProfileStore, resolve_profile_path
from vpn_automation.integrations.cloudflare import CloudflareClient, build_secret_url
from vpn_automation.integrations.node_tools import obfuscate_javascript
from vpn_automation.pipeline.availability import check_link_availability_batch
from vpn_automation.pipeline.controller import PipelineController, PipelineSummary
from vpn_automation.pipeline.package import build_pages_bundle
from vpn_automation.pipeline.postprocess import (
    decorate_link_with_country,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.render import replace_main_data
from vpn_automation.pipeline.speedtest import (
    ProbeResult,
    SpeedTestResult,
    probe_vmess_link,
    select_speedtest_candidates,
    test_vmess_link,
)
from vpn_automation.pipeline.vmess import parse_vmess_link


def _read_non_empty_lines(path: Path) -> list[str]:
    if not path.exists():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _default_verify(deploy: Any, api_token: str) -> dict[str, bool]:
    client = CloudflareClient(api_token=api_token, account_id=deploy.account_id)
    secret_ok = client.verify_url(build_secret_url(deploy))
    subscription_ok = client.verify_url(deploy.subscription_url)
    return {"secret_ok": secret_ok, "subscription_ok": subscription_ok}


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
    api_token = env.get("CLOUDFLARE_API_TOKEN", "")
    if not api_token:
        raise RuntimeError("CLOUDFLARE_API_TOKEN is missing")

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
    obfuscated_path = artifact_dir / "vmess_node_worker.js"
    controller.obfuscator(rendered_path, obfuscated_path)
    if not obfuscated_path.exists():
        raise RuntimeError("vmess_node_worker.js was not created by the obfuscation step")
    set_stage("obfuscate", "success")
    controller._write_pipeline_report(artifact_dir, summary)

    set_stage("deploy", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    bundle_dir = build_pages_bundle(obfuscated_path.read_text(encoding="utf-8"), artifact_dir / "pages_bundle")
    deployment = controller.deployer(bundle_dir, profile.deploy, api_token)
    summary.deployment = deployment
    if deployment.get("returncode", 1) != 0:
        raise RuntimeError(f"Cloudflare deployment failed: {deployment}")
    set_stage("deploy", "success")
    controller._write_pipeline_report(artifact_dir, summary)

    set_stage("verify", "running")
    controller._write_pipeline_report(artifact_dir, summary)
    verification = controller.verifier(profile.deploy, api_token)
    if not (verification.get("secret_ok") and verification.get("subscription_ok")):
        raise RuntimeError(f"Verification failed: {verification}")
    summary.deployment.update(verification)
    set_stage("verify", "success")

    summary.run_status = "success"
    summary.error = ""
    controller._write_pipeline_report(artifact_dir, summary)
    return summary
