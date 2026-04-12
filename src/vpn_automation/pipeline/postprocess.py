import socket

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


def lookup_country_code(host: str) -> str:
    ip = resolve_host_to_ip(host)
    session = requests.Session()
    session.trust_env = False
    response = session.get(f"https://ipwho.is/{ip}", timeout=20)
    response.raise_for_status()
    payload = response.json()
    return str(payload.get("country_code", "")).upper()


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
