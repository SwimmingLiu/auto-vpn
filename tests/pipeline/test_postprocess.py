from vpn_automation.config.models import FilterConfig
from vpn_automation.pipeline.postprocess import decorate_node_name, select_links_by_country_limit
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
