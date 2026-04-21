import json
import shutil
import socket
import subprocess
import tempfile
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import requests

from vpn_automation.pipeline.vmess import parse_vmess_link


@dataclass
class ProxyRuntime:
    process: subprocess.Popen[str]
    session: requests.Session
    proxies: dict[str, str]
    config_path: Path


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


@contextmanager
def open_proxy_runtime(
    link: str,
    *,
    startup_wait_seconds: float,
    xray_path: str = "",
) -> Iterator[ProxyRuntime]:
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
        _wait_for_port(http_port, startup_wait_seconds + 4)
        yield ProxyRuntime(process=process, session=session, proxies=proxies, config_path=config_path)
    finally:
        session.close()
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        config_path.unlink(missing_ok=True)
