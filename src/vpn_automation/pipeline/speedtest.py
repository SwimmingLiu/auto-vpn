import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable

import requests

from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.proxy_runtime import open_proxy_runtime


@dataclass
class SpeedTestResult:
    link: str
    reachable: bool
    average_download_mb_s: float
    latency_ms: int
    error: str = ""


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
    xray_path: str = "",
) -> SpeedTestResult:
    try:
        with open_proxy_runtime(
            link,
            startup_wait_seconds=config.startup_wait_seconds,
            xray_path=xray_path,
        ) as runtime:
            latency_started = time.perf_counter()
            probe = runtime.session.get(
                config.probe_url,
                proxies=runtime.proxies,
                timeout=config.timeout_seconds,
                verify=False,
            )
            probe.raise_for_status()
            latency_ms = int((time.perf_counter() - latency_started) * 1000)

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


def speedtest_links(
    links: list[str],
    config: SpeedTestConfig,
    *,
    xray_path: str = "",
    progress_callback: Callable[[str], None] | None = None,
) -> list[SpeedTestResult]:
    if not links:
        return []

    results: list[SpeedTestResult] = []
    with ThreadPoolExecutor(max_workers=max(1, config.concurrency)) as executor:
        futures = {
            executor.submit(test_vmess_link, link, config, xray_path=xray_path): link for link in links
        }
        for index, future in enumerate(as_completed(futures), start=1):
            result = future.result()
            results.append(result)
            if progress_callback:
                progress_callback(
                    f"[speedtest] {index}/{len(links)} reachable={result.reachable} speed={result.average_download_mb_s}MB/s"
                )
    return results
