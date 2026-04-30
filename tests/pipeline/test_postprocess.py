from types import SimpleNamespace

import requests

from vpn_automation.config.models import FilterConfig
from vpn_automation.pipeline.postprocess import (
    decorate_link_with_country,
    decorate_node_name,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.speedtest import SpeedTestResult
from vpn_automation.pipeline.vmess import generate_vmess_link, parse_vmess_link


def test_decorate_node_name_prefixes_emoji_and_country() -> None:
    updated = decorate_node_name("Node-1", "US", "🇺🇸")
    assert updated == "🇺🇸 US Node-1"


def test_select_links_by_country_limit_filters_cn_and_limits_hk() -> None:
    ranked = [
        ("vmess://1", SpeedTestResult(link="vmess://1", reachable=True, average_download_mb_s=8.0, latency_ms=100), "HK"),
        ("vmess://2", SpeedTestResult(link="vmess://2", reachable=True, average_download_mb_s=7.0, latency_ms=100), "HK"),
        ("vmess://3", SpeedTestResult(link="vmess://3", reachable=True, average_download_mb_s=9.0, latency_ms=90), "CN"),
        ("vmess://4", SpeedTestResult(link="vmess://4", reachable=True, average_download_mb_s=6.0, latency_ms=80), "US"),
    ]

    selected = select_links_by_country_limit(
        ranked,
        FilterConfig(excluded_country_codes=["CN"], per_country_limit={"HK": 1}),
    )

    assert selected == ["vmess://1", "vmess://4"]


def test_lookup_country_code_uses_secondary_service_after_primary_rate_limit(monkeypatch) -> None:
    primary_calls: list[str] = []
    secondary_calls: list[str] = []
    sleep_calls: list[float] = []

    class PrimaryResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("429")
            error.response = SimpleNamespace(status_code=429, headers={"Retry-After": "300"})
            raise error

        def json(self) -> dict[str, str]:
            return {}

    class SecondaryResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, str]:
            return {"country_code": "US"}

    class FakeSession:
        def __init__(self) -> None:
            self.trust_env = True

        def get(self, url: str, timeout: int) -> PrimaryResponse | SecondaryResponse:
            assert timeout == 20
            if url == "https://ipwho.is/23.224.112.134":
                primary_calls.append(url)
                return PrimaryResponse()
            if url == "https://ipapi.co/23.224.112.134/json/":
                secondary_calls.append(url)
                return SecondaryResponse()
            raise AssertionError(f"unexpected url: {url}")

    cache_clear = getattr(lookup_country_code, "cache_clear", None)
    if callable(cache_clear):
        cache_clear()
    monkeypatch.setattr("vpn_automation.pipeline.postprocess._PRIMARY_GEOIP_BLOCKED_UNTIL", 0.0, raising=False)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.requests.Session", FakeSession)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.time.sleep", sleep_calls.append)

    assert lookup_country_code("23.224.112.134") == "US"
    assert primary_calls == ["https://ipwho.is/23.224.112.134"] * 4
    assert secondary_calls == ["https://ipapi.co/23.224.112.134/json/"]
    assert sleep_calls == [0.5, 1.0, 2.0]


def test_lookup_country_code_returns_us_when_both_geoip_services_fail(monkeypatch) -> None:
    primary_calls: list[str] = []
    secondary_calls: list[str] = []
    sleep_calls: list[float] = []

    class PrimaryResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("429")
            error.response = SimpleNamespace(status_code=429, headers={"Retry-After": "300"})
            raise error

        def json(self) -> dict[str, str]:
            return {}

    class SecondaryResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("503")
            error.response = SimpleNamespace(status_code=503, headers={})
            raise error

        def json(self) -> dict[str, str]:
            return {}

    class FakeSession:
        def __init__(self) -> None:
            self.trust_env = True

        def get(self, url: str, timeout: int) -> PrimaryResponse | SecondaryResponse:
            assert timeout == 20
            if url == "https://ipwho.is/23.224.112.135":
                primary_calls.append(url)
                return PrimaryResponse()
            if url == "https://ipapi.co/23.224.112.135/json/":
                secondary_calls.append(url)
                return SecondaryResponse()
            raise AssertionError(f"unexpected url: {url}")

    cache_clear = getattr(lookup_country_code, "cache_clear", None)
    if callable(cache_clear):
        cache_clear()
    monkeypatch.setattr("vpn_automation.pipeline.postprocess._PRIMARY_GEOIP_BLOCKED_UNTIL", 0.0, raising=False)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.requests.Session", FakeSession)
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.time.sleep", sleep_calls.append)

    assert lookup_country_code("23.224.112.135") == "US"
    assert primary_calls == ["https://ipwho.is/23.224.112.135"] * 4
    assert secondary_calls == ["https://ipapi.co/23.224.112.135/json/"]
    assert sleep_calls == [0.5, 1.0, 2.0]


def test_decorate_link_with_country_normalizes_invalid_codes_to_us() -> None:
    link = generate_vmess_link(
        {
            "v": "2",
            "ps": "sample-node",
            "add": "1.1.1.1",
            "port": "443",
            "id": "418048af-a293-4b99-9b0c-98ca3580dd24",
            "aid": "0",
            "scy": "none",
            "net": "ws",
            "type": "dtls",
            "host": "www.example.com",
            "path": "/path/demo",
            "tls": "tls",
            "sni": "www.example.com",
        }
    )

    updated = decorate_link_with_country(link, "ZZ")

    assert parse_vmess_link(updated)["ps"] == "🇺🇸 US sample-node"
