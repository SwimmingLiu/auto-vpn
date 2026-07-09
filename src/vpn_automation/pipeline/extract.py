import base64
import json
import random
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from requests import RequestException, Response
from requests.exceptions import SSLError

from vpn_automation.config.models import SourceConfig
from vpn_automation.config.runtime import resolve_upstream_proxy_url
from vpn_automation.pipeline.tls_warnings import suppress_insecure_request_warnings
from vpn_automation.pipeline.vmess import generate_vmess_link, transform_node_id

suppress_insecure_request_warnings()


@dataclass
class ExtractedSourceResult:
    source_name: str
    requested_iterations: int
    successful_iterations: int
    links: list[str]
    failed_iterations: int = 0


def _emit_event(
    event_callback: Callable[[str, dict[str, Any]], None] | None,
    event_type: str,
    **payload: Any,
) -> None:
    if event_callback:
        event_callback(event_type, payload)


def build_source_script_path(sibling_root: Path, source_name: str) -> Path:
    return sibling_root / "run" / f"{source_name}.py"


def write_vpn_api_config(config_path: Path, payload: dict) -> None:
    config_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def build_runtime_source_url(source: SourceConfig, iteration: int = 0) -> str:
    parsed = urlparse(source.url)
    query = parse_qs(parsed.query)
    if source.use_random_area and iteration > 0:
        area_min = int(getattr(source, "area_min", 0))
        area_max = int(getattr(source, "area_max", 100))
        if area_min > area_max:
            area_min, area_max = area_max, area_min
        query["area"] = [str(random.randint(area_min, area_max))]
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


def _is_tls_failure(exc: BaseException) -> bool:
    if isinstance(exc, SSLError):
        return True
    text = f"{exc.__class__.__name__}: {exc}".lower()
    return "ssl" in text or "tls" in text or "certificate" in text


def _curl_fetch(url: str, *, proxy_url: str = "") -> Response:
    command = [
        "curl",
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--max-time",
        "20",
        "--connect-timeout",
        "10",
        "--insecure",
        "--http1.1",
    ]
    if proxy_url:
        command.extend(["--proxy", proxy_url])
    else:
        command.extend(["--noproxy", "*"])
    command.append(url)
    completed = subprocess.run(
        command,
        check=False,
        capture_output=True,
        text=True,
        timeout=25,
    )
    if completed.returncode != 0:
        raise RequestException((completed.stderr or completed.stdout or "curl TLS fallback failed").strip())
    response = Response()
    response.status_code = 200
    response.url = url
    response._content = completed.stdout.encode("utf-8")
    response.encoding = "utf-8"
    return response


def _fetch_source_response(
    session: requests.Session,
    url: str,
    *,
    proxies: dict[str, str] | None,
    via: str,
) -> tuple[Response, str]:
    try:
        return session.get(url, timeout=20, verify=False, proxies=proxies), via
    except RequestException as exc:
        if not _is_tls_failure(exc):
            raise
        proxy_url = ""
        if proxies:
            proxy_url = proxies.get("https") or proxies.get("http") or ""
        try:
            return _curl_fetch(url, proxy_url=proxy_url), f"{via}_curl_tls_fallback"
        except RequestException as fallback_exc:
            raise exc from fallback_exc


def fetch_source_links(
    source_name: str,
    source: SourceConfig,
    *,
    progress_callback: Callable[[str], None] | None = None,
    progress_state_callback: Callable[..., None] | None = None,
    raw_link_callback: Callable[[str, str], None] | None = None,
    attempt_callback: Callable[..., None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> ExtractedSourceResult:
    session = requests.Session()
    session.trust_env = False

    links: list[str] = []
    plateau = 0
    successes = 0
    failures = 0
    seen = set()
    started_at = time.monotonic()
    start_iteration = max(1, int(getattr(source, "resume_from_iteration", 1)))
    upstream_proxy = resolve_upstream_proxy_url()
    upstream_proxies = (
        {"http": upstream_proxy, "https": upstream_proxy}
        if upstream_proxy
        else None
    )

    _emit_event(
        event_callback,
        "extract_source_started",
        source_name=source_name,
        requested_iterations=source.max_iterations,
        min_iterations=source.min_iterations,
        resume_from_iteration=start_iteration,
    )

    for iteration in range(start_iteration - 1, source.max_iterations):
        attempt = iteration + 1
        if (
            source.max_runtime_seconds > 0
            and attempt > source.min_iterations
            and (time.monotonic() - started_at) >= source.max_runtime_seconds
        ):
            if progress_callback:
                progress_callback(
                    f"[extract] {source_name} stopped after {source.max_runtime_seconds:.1f}s time budget"
                )
            break

        url = build_runtime_source_url(source, iteration=iteration)
        response = None
        used_proxy = False
        try:
            try:
                response, response_via = _fetch_source_response(
                    session,
                    url,
                    proxies=None,
                    via="direct",
                )
                _emit_event(
                    event_callback,
                    "extract_request_result",
                    source_name=source_name,
                    iteration=attempt,
                    success=True,
                    via=response_via,
                    url=url,
                )
            except RequestException as direct_exc:
                _emit_event(
                    event_callback,
                    "extract_request_result",
                    source_name=source_name,
                    iteration=attempt,
                    success=False,
                    via="direct",
                    url=url,
                    error=f"{direct_exc.__class__.__name__}: {direct_exc}",
                    will_retry=bool(upstream_proxies),
                )
                if not upstream_proxies:
                    raise
                used_proxy = True
                if progress_callback:
                    progress_callback(
                        f"[extract] {source_name} iter={attempt}/{source.max_iterations} retry=upstream_proxy"
                    )
                response, response_via = _fetch_source_response(
                    session,
                    url,
                    proxies=upstream_proxies,
                    via="upstream_proxy",
                )
                _emit_event(
                    event_callback,
                    "extract_request_result",
                    source_name=source_name,
                    iteration=attempt,
                    success=True,
                    via=response_via,
                    url=url,
                )

            response.raise_for_status()
            try:
                plaintext = decrypt_payload(response.text.strip(), source.key)
                _emit_event(
                    event_callback,
                    "extract_decrypt_result",
                    source_name=source_name,
                    iteration=attempt,
                    success=True,
                )
            except Exception as decrypt_exc:
                _emit_event(
                    event_callback,
                    "extract_decrypt_result",
                    source_name=source_name,
                    iteration=attempt,
                    success=False,
                    error=f"{decrypt_exc.__class__.__name__}: {decrypt_exc}",
                )
                raise
            extracted = extract_links_from_plaintext(source_name, plaintext)
        except Exception as exc:
            failures += 1
            if attempt_callback:
                attempt_callback(
                    source_name=source_name,
                    iteration=attempt,
                    url=url,
                    used_proxy=used_proxy,
                    success=False,
                    http_status=int(getattr(response, "status_code", 0) or 0),
                    error_type=exc.__class__.__name__,
                    error_message=str(exc),
                    returned_links=0,
                    new_links=0,
                    total_links=len(links),
                )
            if progress_state_callback:
                progress_state_callback(
                    source_name=source_name,
                    iteration=attempt,
                    max_iterations=source.max_iterations,
                    new_links=0,
                    raw_links=len(links),
                    successful_iterations=successes,
                    failed_iterations=failures,
                )
            if progress_callback:
                progress_callback(
                    f"[extract] {source_name} iter={attempt}/{source.max_iterations} "
                    f"error={exc.__class__.__name__}: {exc}"
                )
            if failures >= source.failure_limit and attempt >= source.min_iterations:
                if progress_callback:
                    progress_callback(
                        f"[extract] {source_name} stopped after {failures} consecutive failures"
                    )
                break
            continue

        successes += 1
        failures = 0
        new_items = 0
        for link in extracted:
            if link in seen:
                continue
            seen.add(link)
            links.append(link)
            new_items += 1
            if raw_link_callback:
                raw_link_callback(source_name, link)

        if progress_state_callback:
            progress_state_callback(
                source_name=source_name,
                iteration=attempt,
                max_iterations=source.max_iterations,
                new_links=new_items,
                raw_links=len(links),
                successful_iterations=successes,
                failed_iterations=failures,
            )
        if attempt_callback:
            attempt_callback(
                source_name=source_name,
                iteration=attempt,
                url=url,
                used_proxy=used_proxy,
                success=True,
                http_status=int(getattr(response, "status_code", 200)),
                error_type="",
                error_message="",
                returned_links=len(extracted),
                new_links=new_items,
                total_links=len(links),
            )
        if progress_callback:
            progress_callback(
                f"[extract] {source_name} iter={attempt}/{source.max_iterations} new={new_items} total={len(links)}"
            )
        _emit_event(
            event_callback,
            "extract_iteration",
            source_name=source_name,
            iteration=attempt,
            requested_iterations=source.max_iterations,
            new_items=new_items,
            extracted_links=len(extracted),
            total_links=len(links),
        )
        plateau = plateau + 1 if new_items == 0 else 0
        if plateau >= source.plateau_limit and attempt >= source.min_iterations:
            break
    result = ExtractedSourceResult(
        source_name=source_name,
        requested_iterations=source.max_iterations,
        successful_iterations=successes,
        links=links,
        failed_iterations=failures,
    )
    _emit_event(
        event_callback,
        "extract_source_completed",
        source_name=source_name,
        requested_iterations=result.requested_iterations,
        successful_iterations=result.successful_iterations,
        failed_iterations=result.failed_iterations,
        raw_links=len(result.links),
    )
    return result
