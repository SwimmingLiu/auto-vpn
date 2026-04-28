import socket
import time
from functools import lru_cache

import requests

from vpn_automation.config.models import FilterConfig
from vpn_automation.pipeline.vmess import generate_vmess_link, parse_vmess_link


EMOJI_MAP = {
    "AE": "🇦🇪",
    "AR": "🇦🇷",
    "AU": "🇦🇺",
    "BE": "🇧🇪",
    "BR": "🇧🇷",
    "CA": "🇨🇦",
    "CH": "🇨🇭",
    "CL": "🇨🇱",
    "CN": "🇨🇳",
    "CO": "🇨🇴",
    "DE": "🇩🇪",
    "DK": "🇩🇰",
    "ES": "🇪🇸",
    "FR": "🇫🇷",
    "GB": "🇬🇧",
    "HK": "🇭🇰",
    "IN": "🇮🇳",
    "IT": "🇮🇹",
    "JP": "🇯🇵",
    "KR": "🇰🇷",
    "MX": "🇲🇽",
    "MY": "🇲🇾",
    "NL": "🇳🇱",
    "NO": "🇳🇴",
    "NZ": "🇳🇿",
    "PL": "🇵🇱",
    "PT": "🇵🇹",
    "RU": "🇷🇺",
    "SA": "🇸🇦",
    "SE": "🇸🇪",
    "SG": "🇸🇬",
    "TH": "🇹🇭",
    "TR": "🇹🇷",
    "TW": "🇹🇼",
    "US": "🇺🇸",
    "ZA": "🇿🇦",
}

UNKNOWN_COUNTRY_CODE = "ZZ"
PRIMARY_GEOIP_RETRY_DELAYS = (0.5, 1.0, 2.0)
PRIMARY_GEOIP_COOLDOWN_SECONDS = 300.0
_PRIMARY_GEOIP_BLOCKED_UNTIL = 0.0


def country_to_emoji(country_code: str) -> str:
    return EMOJI_MAP.get(country_code.upper(), "🏳️")


def decorate_node_name(original_name: str, country_code: str, emoji: str) -> str:
    return f"{emoji} {country_code} {original_name}".strip()


def decorate_link_with_country(link: str, country_code: str) -> str:
    payload = parse_vmess_link(link)
    payload["ps"] = decorate_node_name(str(payload.get("ps", "")), country_code, country_to_emoji(country_code))
    return generate_vmess_link(payload)


def resolve_host_to_ip(host: str) -> str:
    try:
        socket.inet_aton(host)
        return host
    except OSError:
        return socket.gethostbyname(host)


def normalize_country_code(country_code: str) -> str:
    normalized = str(country_code or "").strip().upper()
    if len(normalized) != 2 or not normalized.isalpha():
        return UNKNOWN_COUNTRY_CODE
    return normalized


def _require_country_code(country_code: str) -> str:
    normalized = normalize_country_code(country_code)
    if normalized == UNKNOWN_COUNTRY_CODE:
        raise ValueError("geoip response did not contain a valid country code")
    return normalized


def _primary_geoip_is_blocked() -> bool:
    return time.monotonic() < _PRIMARY_GEOIP_BLOCKED_UNTIL


def _mark_primary_geoip_blocked(retry_after_seconds: float | None) -> None:
    global _PRIMARY_GEOIP_BLOCKED_UNTIL
    cooldown = retry_after_seconds if retry_after_seconds is not None else PRIMARY_GEOIP_COOLDOWN_SECONDS
    _PRIMARY_GEOIP_BLOCKED_UNTIL = time.monotonic() + max(cooldown, PRIMARY_GEOIP_COOLDOWN_SECONDS)


def _extract_retry_after_seconds(exc: Exception) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", {}) or {}
    retry_after = headers.get("Retry-After")
    if retry_after is None:
        return None
    try:
        return float(str(retry_after).strip())
    except ValueError:
        return None


def _status_code(exc: Exception) -> int | None:
    response = getattr(exc, "response", None)
    status_code = getattr(response, "status_code", None)
    return int(status_code) if status_code is not None else None


def _new_geoip_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = False
    return session


def _lookup_country_code_from_ipwho(ip: str) -> str:
    session = _new_geoip_session()
    response = session.get(f"https://ipwho.is/{ip}", timeout=20)
    response.raise_for_status()
    payload = response.json()
    return _require_country_code(str(payload.get("country_code", "")))


def _lookup_country_code_from_ipapi(ip: str) -> str:
    session = _new_geoip_session()
    response = session.get(f"https://ipapi.co/{ip}/json/", timeout=20)
    response.raise_for_status()
    payload = response.json()
    if payload.get("error"):
        raise ValueError(str(payload.get("reason") or "ipapi lookup failed"))
    return _require_country_code(str(payload.get("country_code", "")))


def _lookup_country_code_with_primary_retry(ip: str) -> str:
    last_error: Exception | None = None
    for attempt, delay_seconds in enumerate((0.0, *PRIMARY_GEOIP_RETRY_DELAYS)):
        if attempt > 0:
            time.sleep(delay_seconds)
        try:
            return _lookup_country_code_from_ipwho(ip)
        except (ValueError, requests.RequestException) as exc:
            last_error = exc
            if _status_code(exc) == 429 and attempt == len(PRIMARY_GEOIP_RETRY_DELAYS):
                _mark_primary_geoip_blocked(_extract_retry_after_seconds(exc))
    if last_error is not None:
        raise last_error
    raise RuntimeError("primary geoip lookup failed without an exception")


@lru_cache(maxsize=2048)
def lookup_country_code(host: str) -> str:
    try:
        ip = resolve_host_to_ip(host)
    except OSError:
        return UNKNOWN_COUNTRY_CODE
    if not _primary_geoip_is_blocked():
        try:
            return _lookup_country_code_with_primary_retry(ip)
        except (ValueError, requests.RequestException):
            pass
    try:
        return _lookup_country_code_from_ipapi(ip)
    except (ValueError, requests.RequestException):
        return UNKNOWN_COUNTRY_CODE


def select_links_by_country_limit(
    ranked_links: list[tuple[str, object, str]],
    filters: FilterConfig,
) -> list[str]:
    limits = dict(filters.per_country_limit)
    counters: dict[str, int] = {}
    selected: list[str] = []

    for link, _result, country_code in ranked_links:
        if country_code in filters.excluded_country_codes:
            continue
        if country_code in limits:
            current = counters.get(country_code, 0)
            if current >= limits[country_code]:
                continue
            counters[country_code] = current + 1
        selected.append(link)
    return selected
