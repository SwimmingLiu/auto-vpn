import json
import shutil
import socket
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests

from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.vmess import parse_vmess_link


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


def resolve_xray_binary(explicit_path: str = "") -> str:
    candidates = [
        explicit_path,
        shutil.which("xray") or "",
        "/opt/homebrew/opt/xray/bin/xray",
        "/opt/homebrew/bin/xray",
        "/usr/local/bin/xray",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError("xray binary not found")


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def build_xray_runtime_config(payload: dict, http_port: int, socks_port: int) -> dict:
    security = "tls" if str(payload.get("tls", "")).lower() == "tls" else ""
    stream_settings: dict = {
        "network": payload.get("net", "ws"),
        "security": security,
    }
    if payload.get("net", "ws") == "ws":
        stream_settings["wsSettings"] = {
            "path": payload.get("path", ""),
            "headers": {"Host": payload.get("host", payload.get("add", ""))},
        }
    if security == "tls":
        stream_settings["tlsSettings"] = {
            "serverName": payload.get("sni") or payload.get("host") or payload.get("add"),
            "allowInsecure": True,
        }

    return {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {"listen": "127.0.0.1", "port": http_port, "protocol": "http"},
            {
                "listen": "127.0.0.1",
                "port": socks_port,
                "protocol": "socks",
                "settings": {"auth": "noauth", "udp": False},
            },
        ],
        "outbounds": [
            {
                "protocol": "vmess",
                "settings": {
                    "vnext": [
                        {
                            "address": payload["add"],
                            "port": int(payload["port"]),
                            "users": [
                                {
                                    "id": payload["id"],
                                    "alterId": int(str(payload.get("aid", "0")) or 0),
                                    "security": payload.get("scy", "auto"),
                                }
                            ],
                        }
                    ]
                },
                "streamSettings": stream_settings,
            },
            {"protocol": "freedom", "tag": "direct"},
        ],
    }


def _wait_for_port(port: int, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise TimeoutError(f"proxy port {port} did not open in time")


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
    payload = parse_vmess_link(link)
    binary = resolve_xray_binary(xray_path)
    http_port = _find_free_port()
    socks_port = _find_free_port()
    runtime_config = build_xray_runtime_config(payload, http_port=http_port, socks_port=socks_port)

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        config_path = Path(handle.name)
        handle.write(json.dumps(runtime_config, ensure_ascii=False))

    process = subprocess.Popen(
        [binary, "run", "-config", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    session = requests.Session()
    session.trust_env = False
    proxies = {
        "http": f"http://127.0.0.1:{http_port}",
        "https": f"http://127.0.0.1:{http_port}",
    }

    try:
        _wait_for_port(http_port, config.startup_wait_seconds + 4)

        latency_started = time.perf_counter()
        probe = session.get(
            config.probe_url,
            proxies=proxies,
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
                        session,
                        url,
                        proxies,
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
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        config_path.unlink(missing_ok=True)


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
