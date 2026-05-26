import json
import os
import signal
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator
from urllib.parse import quote

import requests

from vpn_automation.pipeline.vmess import parse_vmess_link


@dataclass
class ProxyRuntime:
    process: subprocess.Popen[str]
    session: requests.Session
    proxies: dict[str, str]
    config_path: Path
    controller_url: str = ""
    proxy_name: str = ""


PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
)


_ACTIVE_RUNTIMES: list[tuple[subprocess.Popen[str], Path]] = []
_ACTIVE_RUNTIMES_LOCK = threading.Lock()
_SIGNAL_HANDLERS_INSTALLED = False


def resolve_mihomo_binary(explicit_path: str = "") -> str:
    candidates = [
        explicit_path,
        shutil.which("mihomo") or "",
        "/opt/homebrew/bin/mihomo",
        "/usr/local/bin/mihomo",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError("mihomo binary not found")


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def build_mihomo_runtime_config(payload: dict, mixed_port: int, controller_port: int) -> dict:
    network = payload.get("net", "ws")
    tls_enabled = str(payload.get("tls", "")).lower() == "tls"
    proxy_name = "runtime-node"
    proxy: dict[str, object] = {
        "name": proxy_name,
        "type": "vmess",
        "server": payload["add"],
        "port": int(payload["port"]),
        "uuid": payload["id"],
        "alterId": int(str(payload.get("aid", "0")) or 0),
        "cipher": payload.get("scy", "auto"),
        "udp": False,
        "network": network,
    }
    if tls_enabled:
        proxy["tls"] = True
        proxy["skip-cert-verify"] = True
        proxy["servername"] = payload.get("sni") or payload.get("host") or payload.get("add")
    if network == "ws":
        proxy["ws-opts"] = {
            "path": payload.get("path", ""),
            "headers": {"Host": payload.get("host") or payload.get("add", "")},
        }

    return {
        "mixed-port": mixed_port,
        "allow-lan": False,
        "mode": "global",
        "log-level": "silent",
        "ipv6": False,
        "external-controller": f"127.0.0.1:{controller_port}",
        "dns": {"enable": False},
        "proxies": [proxy],
        "proxy-groups": [
            {
                "name": "GLOBAL",
                "type": "select",
                "proxies": [proxy_name],
            }
        ],
        "rules": ["MATCH,GLOBAL"],
    }


def build_runtime_env() -> dict[str, str]:
    env = dict(os.environ)
    for key in PROXY_ENV_KEYS:
        env.pop(key, None)
    return env


def _register_active_proxy_runtime(process: subprocess.Popen[str], config_path: Path) -> tuple[subprocess.Popen[str], Path]:
    token = (process, config_path)
    with _ACTIVE_RUNTIMES_LOCK:
        _ACTIVE_RUNTIMES.append(token)
    return token


def _unregister_active_proxy_runtime(token: tuple[subprocess.Popen[str], Path]) -> None:
    with _ACTIVE_RUNTIMES_LOCK:
        if token in _ACTIVE_RUNTIMES:
            _ACTIVE_RUNTIMES.remove(token)


def _terminate_proxy_runtime_process(process: subprocess.Popen[str], config_path: Path) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
    config_path.unlink(missing_ok=True)


def terminate_active_proxy_runtimes() -> int:
    with _ACTIVE_RUNTIMES_LOCK:
        runtimes = list(_ACTIVE_RUNTIMES)
        _ACTIVE_RUNTIMES.clear()

    for process, config_path in runtimes:
        _terminate_proxy_runtime_process(process, config_path)
    return len(runtimes)


def _handle_proxy_runtime_shutdown_signal(signum: int, _frame: object) -> None:
    terminate_active_proxy_runtimes()
    raise SystemExit(128 + signum)


def install_proxy_runtime_signal_handlers() -> None:
    global _SIGNAL_HANDLERS_INSTALLED
    if _SIGNAL_HANDLERS_INSTALLED or threading.current_thread() is not threading.main_thread():
        return
    signal.signal(signal.SIGTERM, _handle_proxy_runtime_shutdown_signal)
    signal.signal(signal.SIGINT, _handle_proxy_runtime_shutdown_signal)
    _SIGNAL_HANDLERS_INSTALLED = True

def select_mihomo_proxy(controller_url: str, proxy_name: str, timeout_seconds: float) -> None:
    if not controller_url:
        return
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.put(
            f"{controller_url}/proxies/GLOBAL",
            json={"name": proxy_name},
            timeout=max(timeout_seconds, 1),
        )
        response.raise_for_status()
    finally:
        session.close()


def probe_mihomo_proxy_delay(
    controller_url: str,
    proxy_name: str,
    probe_url: str,
    timeout_seconds: int,
) -> int:
    session = requests.Session()
    session.trust_env = False
    try:
        response = session.get(
            f"{controller_url}/proxies/{quote(proxy_name, safe='')}/delay",
            params={
                "timeout": int(timeout_seconds * 1000),
                "url": probe_url,
            },
            timeout=max(timeout_seconds, 1),
        )
        response.raise_for_status()
        payload = response.json()
        delay = int(payload.get("delay", -1))
        if delay < 0:
            raise RuntimeError(f"mihomo returned invalid delay payload: {payload}")
        return delay
    finally:
        session.close()


def _wait_for_port(port: int, timeout_seconds: float) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            if sock.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise TimeoutError(f"proxy port {port} did not open in time")


@contextmanager
def open_proxy_runtime(
    link: str,
    *,
    startup_wait_seconds: float,
    runtime_path: str = "",
) -> Iterator[ProxyRuntime]:
    install_proxy_runtime_signal_handlers()
    payload = parse_vmess_link(link)
    binary = resolve_mihomo_binary(runtime_path)
    http_port = _find_free_port()
    controller_port = _find_free_port()
    proxy_name = "runtime-node"
    runtime_config = build_mihomo_runtime_config(
        payload,
        mixed_port=http_port,
        controller_port=controller_port,
    )
    listen_port = http_port
    controller_url = f"http://127.0.0.1:{controller_port}"

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        config_path = Path(handle.name)
        handle.write(json.dumps(runtime_config, ensure_ascii=False))

    process = subprocess.Popen(
        [binary, "-f", str(config_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=build_runtime_env(),
    )
    runtime_token = _register_active_proxy_runtime(process, config_path)
    session = requests.Session()
    session.trust_env = False
    proxies = {
        "http": f"http://127.0.0.1:{listen_port}",
        "https": f"http://127.0.0.1:{listen_port}",
    }

    try:
        _wait_for_port(listen_port, startup_wait_seconds + 4)
        _wait_for_port(controller_port, startup_wait_seconds + 4)
        select_mihomo_proxy(controller_url, proxy_name, startup_wait_seconds + 4)
        yield ProxyRuntime(
            process=process,
            session=session,
            proxies=proxies,
            config_path=config_path,
            controller_url=controller_url,
            proxy_name=proxy_name,
        )
    finally:
        session.close()
        _unregister_active_proxy_runtime(runtime_token)
        _terminate_proxy_runtime_process(process, config_path)


install_proxy_runtime_signal_handlers()
