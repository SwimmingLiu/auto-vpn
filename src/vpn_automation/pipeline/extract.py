import base64
import json
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

from vpn_automation.config.models import SourceConfig
from vpn_automation.config.runtime import resolve_upstream_proxy_url
from vpn_automation.pipeline.vmess import generate_vmess_link, transform_node_id


@dataclass
class ExtractedSourceResult:
    source_name: str
    requested_iterations: int
    successful_iterations: int
    links: list[str]


def build_source_script_path(sibling_root: Path, source_name: str) -> Path:
    return sibling_root / "run" / f"{source_name}.py"


def write_vpn_api_config(config_path: Path, payload: dict) -> None:
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_runtime_source_url(source: SourceConfig, iteration: int = 0) -> str:
    parsed = urlparse(source.url)
    query = parse_qs(parsed.query)
    if source.use_random_area and iteration > 0:
        query["area"] = [str(random.randint(0, 100))]
    if "t" in query:
        query["t"] = [f"{time.time():.6f}"]
    return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))


def decrypt_payload(cipher_text: str, key: str) -> str:
    payload = base64.b64decode(cipher_text)
    key_bytes = key.encode("utf-8")
    decryptor = Cipher(algorithms.AES(key_bytes), modes.CBC(key_bytes)).decryptor()
    plain = decryptor.update(payload) + decryptor.finalize()
    return plain.decode("utf-8", errors="ignore").rstrip("\0")


def _payload_from_outbound_config(ps_name: str, json_text: str) -> dict:
    config = json.loads(json_text)
    outbound = next(
        item for item in config.get("outbounds", []) if item.get("protocol") == "vmess"
    )
    vnext = outbound["settings"]["vnext"][0]
    user = vnext["users"][0]
    stream_settings = outbound.get("streamSettings", {})
    ws_settings = stream_settings.get("wsSettings", {})
    headers = ws_settings.get("headers", {})
    host = ws_settings.get("host") or headers.get("Host") or vnext["address"]
    security = stream_settings.get("security", "")
    return {
        "v": 2,
        "ps": config.get("ps", ps_name).strip() if isinstance(config.get("ps", ps_name), str) else config.get("ps", ps_name),
        "add": vnext["address"],
        "port": str(vnext["port"]),
        "id": transform_node_id(user["id"]),
        "aid": str(user.get("alterId", 0)),
        "scy": user.get("security", "auto"),
        "net": stream_settings.get("network", "ws"),
        "type": "dtls",
        "host": host,
        "path": ws_settings.get("path", ""),
        "tls": security,
        "sni": stream_settings.get("tlsSettings", {}).get("serverName", ""),
    }


def extract_links_from_plaintext(source_name: str, plaintext: str) -> list[str]:
    cleaned = plaintext.strip()
    if not cleaned:
        return []
    if cleaned.startswith("vmess://"):
        return [cleaned]
    parts = cleaned.split("|")
    if len(parts) < 2:
        return []
    ps_name = parts[0].strip() or source_name
    json_text = parts[1].strip()
    return [generate_vmess_link(_payload_from_outbound_config(ps_name, json_text))]


def fetch_source_links(
    source_name: str,
    source: SourceConfig,
    *,
    progress_callback: Callable[[str], None] | None = None,
    progress_state_callback: Callable[..., None] | None = None,
    raw_link_callback: Callable[[str, str], None] | None = None,
) -> ExtractedSourceResult:
    session = requests.Session()
    session.trust_env = False
    upstream_proxy = resolve_upstream_proxy_url()
    request_proxies = (
        {"http": upstream_proxy, "https": upstream_proxy}
        if upstream_proxy
        else None
    )

    links: list[str] = []
    plateau = 0
    successes = 0
    seen = set()

    for iteration in range(source.max_iterations):
        url = build_runtime_source_url(source, iteration=iteration)
        response = session.get(url, timeout=20, verify=False, proxies=request_proxies)
        response.raise_for_status()
        plaintext = decrypt_payload(response.text.strip(), source.key)
        extracted = extract_links_from_plaintext(source_name, plaintext)
        successes += 1
        new_items = 0
        for link in extracted:
            if link in seen:
                continue
            seen.add(link)
            links.append(link)
            new_items += 1
            if raw_link_callback:
                raw_link_callback(source_name, link)
        plateau = plateau + 1 if new_items == 0 else 0
        if progress_state_callback:
            progress_state_callback(
                source_name=source_name,
                iteration=iteration + 1,
                max_iterations=source.max_iterations,
                new_links=new_items,
                raw_links=len(links),
                successful_iterations=successes,
                failed_iterations=0,
            )
        if progress_callback:
            progress_callback(
                f"[extract] {source_name} iter={iteration + 1}/{source.max_iterations} new={new_items} total={len(links)}"
            )
        if plateau >= source.plateau_limit:
            break

    return ExtractedSourceResult(
        source_name=source_name,
        requested_iterations=source.max_iterations,
        successful_iterations=successes,
        links=links,
    )
