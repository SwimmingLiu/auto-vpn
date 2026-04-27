from types import SimpleNamespace

import requests

from vpn_automation.config.models import FilterConfig
from vpn_automation.pipeline.postprocess import (
    decorate_node_name,
    lookup_country_code,
    select_links_by_country_limit,
)
from vpn_automation.pipeline.speedtest import SpeedTestResult


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


def test_lookup_country_code_returns_zz_when_geoip_service_is_rate_limited(monkeypatch) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            error = requests.HTTPError("429")
            error.response = SimpleNamespace(status_code=429)
            raise error

    class FakeSession:
        def __init__(self) -> None:
            self.trust_env = True

        def get(self, url: str, timeout: int) -> FakeResponse:
            assert url == "https://ipwho.is/23.224.112.134"
            assert timeout == 20
            return FakeResponse()

    cache_clear = getattr(lookup_country_code, "cache_clear", None)
    if callable(cache_clear):
        cache_clear()
    monkeypatch.setattr("vpn_automation.pipeline.postprocess.requests.Session", FakeSession)

    assert lookup_country_code("23.224.112.134") == "ZZ"
