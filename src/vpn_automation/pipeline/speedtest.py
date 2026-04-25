import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Callable

import requests

from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.proxy_runtime import open_proxy_runtime, probe_mihomo_proxy_delay
from vpn_automation.pipeline.tls_warnings import suppress_insecure_request_warnings

suppress_insecure_request_warnings()


@dataclass
class SpeedTestResult:
    link: str
    reachable: bool
    average_download_mb_s: float
    latency_ms: int
    error: str = ""


@dataclass
class ProbeResult:
    link: str
    reachable: bool
    latency_ms: int
    error: str = ""


def _emit_event(
    event_callback: Callable[[str, dict[str, Any]], None] | None,
    event_type: str,
    **payload: Any,
) -> None:
    if event_callback:
        event_callback(event_type, payload)


def aggregate_speed_measurements(values: list[float]) -> float:
    if not values:
        return 0.0
    return round(sum(values) / len(values), 3)


def _download_speed_mb_s(session: requests.Session, url: str, proxies: dict, max_bytes: int, timeout: int) -> float:
    started = time.perf_counter()
    total = 0
    with session.get(url, proxies=proxies, stream=True, timeout=timeout, verify=False) as response:
        response.raise_for_status()
        for chunk in response.iter_content(chunk_size=32_768):
            if not chunk:
                continue
            total += len(chunk)
            if total >= max_bytes:
                break
    elapsed = max(time.perf_counter() - started, 0.001)
    return total / elapsed / 1024 / 1024


def test_vmess_link(
    link: str,
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
) -> SpeedTestResult:
    try:
        with open_proxy_runtime(
            link,
            startup_wait_seconds=config.startup_wait_seconds,
            runtime_path=runtime_path,
        ) as runtime:
            latency_ms = probe_mihomo_proxy_delay(
                runtime.controller_url,
                runtime.proxy_name,
                config.probe_url,
                config.timeout_seconds,
            )

            speed_values: list[float] = []
            failures: list[str] = []
            for url in config.urls:
                try:
                    speed_values.append(
                        _download_speed_mb_s(
                            runtime.session,
                            url,
                            runtime.proxies,
                            max_bytes=config.max_download_bytes,
                            timeout=config.timeout_seconds,
                        )
                    )
                except Exception as url_exc:
                    failures.append(f"{url}: {url_exc}")

            if not speed_values:
                raise RuntimeError("; ".join(failures) or "all speed test urls failed")

            return SpeedTestResult(
                link=link,
                reachable=True,
                average_download_mb_s=aggregate_speed_measurements(speed_values),
                latency_ms=latency_ms,
                error="; ".join(failures),
            )
    except Exception as exc:
        return SpeedTestResult(
            link=link,
            reachable=False,
            average_download_mb_s=0.0,
            latency_ms=0,
            error=str(exc),
        )


def probe_vmess_link(
    link: str,
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
) -> ProbeResult:
    try:
        with open_proxy_runtime(
            link,
            startup_wait_seconds=config.startup_wait_seconds,
            runtime_path=runtime_path,
        ) as runtime:
            latency_ms = probe_mihomo_proxy_delay(
                runtime.controller_url,
                runtime.proxy_name,
                config.probe_url,
                config.timeout_seconds,
            )
            return ProbeResult(link=link, reachable=True, latency_ms=latency_ms)
    except Exception as exc:
        return ProbeResult(link=link, reachable=False, latency_ms=0, error=str(exc))


def select_speedtest_candidates(probes: list[ProbeResult], limit: int) -> list[str]:
    reachable = sorted(
        (probe for probe in probes if probe.reachable),
        key=lambda probe: (probe.latency_ms <= 0, probe.latency_ms, probe.link),
    )
    if limit <= 0:
        return [probe.link for probe in reachable]
    return [probe.link for probe in reachable[:limit]]


def probe_links(
    links: list[str],
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
    progress_callback: Callable[[str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> list[ProbeResult]:
    if not links:
        return []

    results: list[ProbeResult | None] = [None] * len(links)
    with ThreadPoolExecutor(max_workers=max(1, config.concurrency)) as executor:
        futures = {
            executor.submit(probe_vmess_link, link, config, runtime_path=runtime_path): index
            for index, link in enumerate(links)
        }
        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results[futures[future]] = result
            if progress_callback:
                progress_callback(
                    f"[speedtest:probe] {index}/{len(links)} reachable={result.reachable} latency={result.latency_ms}ms"
                )
            _emit_event(
                event_callback,
                "speedtest_probe_result",
                completed=index,
                total=len(links),
                link=result.link,
                reachable=result.reachable,
                latency_ms=result.latency_ms,
                error=result.error,
            )
    return [result for result in results if result is not None]


def speedtest_links(
    links: list[str],
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
    progress_callback: Callable[[str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> list[SpeedTestResult]:
    if not links:
        return []

    if progress_callback:
        progress_callback(
            f"[speedtest] runtime_core=mihomo probe_url={config.probe_url}"
        )
    _emit_event(
        event_callback,
        "speedtest_runtime",
        runtime_core="mihomo",
        probe_url=config.probe_url,
        urls=list(config.urls),
    )

    probe_kwargs: dict[str, Any] = {
        "runtime_path": runtime_path,
        "progress_callback": progress_callback,
    }
    if event_callback is not None:
        probe_kwargs["event_callback"] = event_callback

    probes = probe_links(
        links,
        config,
        **probe_kwargs,
    )
    candidate_links = select_speedtest_candidates(probes, config.max_download_candidates)
    candidate_set = set(candidate_links)

    if progress_callback:
        reachable_count = sum(1 for probe in probes if probe.reachable)
        progress_callback(
            f"[speedtest] selected {len(candidate_links)}/{reachable_count} reachable links for full download test"
        )
    _emit_event(
        event_callback,
        "speedtest_selected",
        total_links=len(links),
        reachable_count=sum(1 for probe in probes if probe.reachable),
        candidate_count=len(candidate_links),
    )

    results = [
        SpeedTestResult(
            link=probe.link,
            reachable=False,
            average_download_mb_s=0.0,
            latency_ms=probe.latency_ms,
            error=probe.error,
        )
        for probe in probes
        if not probe.reachable
    ]
    with ThreadPoolExecutor(max_workers=max(1, config.concurrency)) as executor:
        futures = {
            executor.submit(test_vmess_link, link, config, runtime_path=runtime_path): link for link in candidate_links
        }
        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            if progress_callback:
                progress_callback(
                    f"[speedtest] {index}/{len(candidate_set)} reachable={result.reachable} speed={result.average_download_mb_s}MB/s"
                )
            _emit_event(
                event_callback,
                "speedtest_result",
                completed=index,
                total=len(candidate_set),
                link=result.link,
                reachable=result.reachable,
                average_download_mb_s=result.average_download_mb_s,
                latency_ms=result.latency_ms,
                passed_threshold=result.reachable and result.average_download_mb_s >= config.min_download_mb_s,
                error=result.error,
            )
    return results
