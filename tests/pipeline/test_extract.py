import pytest

from pathlib import Path

from vpn_automation.config.models import SourceConfig
from vpn_automation.pipeline.extract import (
    build_runtime_source_url,
    build_source_script_path,
    extract_links_from_plaintext,
    fetch_source_links,
)
from vpn_automation.pipeline.vmess import parse_vmess_link


def test_build_source_script_path_points_to_existing_run_script() -> None:
    sibling_root = Path("/Users/swimmingliu/data/VPN/vpn-catch-nodes")
    script_path = build_source_script_path(sibling_root, "leiting")
    assert script_path == sibling_root / "run" / "leiting.py"


def test_build_runtime_source_url_rewrites_area_for_randomized_sources() -> None:
    source = SourceConfig(
        url="https://example.com/api?area=2&t=123",
        key="abc",
        use_random_area=True,
    )

    first = build_runtime_source_url(source, iteration=0)
    built = build_runtime_source_url(source, iteration=1)

    assert "area=2" in first
    assert built.startswith("https://example.com/api?")
    assert "area=" in built
    assert "t=" in built


def test_extract_links_from_plaintext_accepts_raw_vmess() -> None:
    vmess = "vmess://eyJhZGQiOiIxLjEuMS4xIiwiYWlkIjoiNjQiLCJob3N0Ijoid3d3Lmdvb2dsZS5jb20iLCJpZCI6IjQxODA0OGFmLWEyOTMtNGI5OS05YjBjLTk4Y2EzNTgwZGQyNCIsIm5ldCI6IndzIiwicGF0aCI6IlwvZm9vdGVycyIsInBvcnQiOjQ0MywicHMiOjQzMSwidGxzIjoidGxzIiwidHlwZSI6ImR0bHMiLCJ2IjoiMiJ9"

    links = extract_links_from_plaintext("leiting", vmess)

    assert links == [vmess]


def test_extract_links_from_plaintext_converts_v2ray_json_to_vmess() -> None:
    plaintext = (
        '1019|{"outbounds":[{"protocol":"vmess","settings":{"vnext":[{"address":"8.8.8.8",'
        '"port":443,"users":[{"id":"12345678-1234-1234-1234-123456789abc","alterId":0}]}]},'
        '"streamSettings":{"network":"ws","security":"tls","wsSettings":{"path":"/ws"}}}]}'
    )

    links = extract_links_from_plaintext("heidong", plaintext)
    payload = parse_vmess_link(links[0])

    assert payload["add"] == "8.8.8.8"
    assert str(payload["port"]) == "443"
    assert payload["net"] == "ws"
    assert payload["path"] == "/ws"


def test_fetch_source_links_uses_upstream_proxy_for_every_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=2,
        min_iterations=0,
        plateau_limit=99,
    )
    calls: list[dict] = []

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        calls.append({"url": url, "proxies": proxies})
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: [f"vmess://{len(calls)}"],
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.resolve_upstream_proxy_url",
        lambda: "http://127.0.0.1:7897",
    )

    result = fetch_source_links("leiting", source)

    assert result.links == ["vmess://1", "vmess://2"]
    assert all(
        call["proxies"] == {
            "http": "http://127.0.0.1:7897",
            "https": "http://127.0.0.1:7897",
        }
        for call in calls
    )


def test_fetch_source_links_emits_checkpoint_callbacks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=2,
        min_iterations=0,
        plateau_limit=99,
    )
    progress_events: list[dict] = []
    raw_links: list[tuple[str, str]] = []

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        return FakeResponse()

    extracted = iter([["vmess://first"], ["vmess://second"]])

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: next(extracted),
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.resolve_upstream_proxy_url",
        lambda: "",
    )

    result = fetch_source_links(
        "leiting",
        source,
        progress_state_callback=lambda **payload: progress_events.append(payload),
        raw_link_callback=lambda source_name, link: raw_links.append((source_name, link)),
    )

    assert result.links == ["vmess://first", "vmess://second"]
    assert progress_events == [
        {
            "source_name": "leiting",
            "iteration": 1,
            "max_iterations": 2,
            "new_links": 1,
            "raw_links": 1,
            "successful_iterations": 1,
            "failed_iterations": 0,
        },
        {
            "source_name": "leiting",
            "iteration": 2,
            "max_iterations": 2,
            "new_links": 1,
            "raw_links": 2,
            "successful_iterations": 2,
            "failed_iterations": 0,
        },
    ]
    assert raw_links == [
        ("leiting", "vmess://first"),
        ("leiting", "vmess://second"),
    ]


def test_fetch_source_links_records_each_attempt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=2,
        min_iterations=0,
        plateau_limit=99,
    )
    attempts: list[dict] = []

    class FakeResponse:
        text = "cipher"
        status_code = 200

        def raise_for_status(self) -> None:
            return None

    extracted = iter([["vmess://first"], []])

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: next(extracted),
    )
    monkeypatch.setattr("vpn_automation.pipeline.extract.resolve_upstream_proxy_url", lambda: "http://127.0.0.1:7897")

    result = fetch_source_links(
        "leiting",
        source,
        attempt_callback=lambda **payload: attempts.append(payload),
    )

    assert result.links == ["vmess://first"]
    assert len(attempts) == 2
    assert attempts[0] == {
        "source_name": "leiting",
        "iteration": 1,
        "url": attempts[0]["url"],
        "used_proxy": True,
        "success": True,
        "http_status": 200,
        "error_type": "",
        "error_message": "",
        "returned_links": 1,
        "new_links": 1,
        "total_links": 1,
    }
    assert attempts[0]["url"].startswith("https://example.com/api?t=")
    assert attempts[1] == {
        "source_name": "leiting",
        "iteration": 2,
        "url": attempts[1]["url"],
        "used_proxy": True,
        "success": True,
        "http_status": 200,
        "error_type": "",
        "error_message": "",
        "returned_links": 0,
        "new_links": 0,
        "total_links": 1,
    }
    assert attempts[1]["url"].startswith("https://example.com/api?t=")
