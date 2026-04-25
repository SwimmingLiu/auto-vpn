import pytest
from requests.exceptions import SSLError

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


def test_fetch_source_links_returns_partial_results_when_requests_start_failing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=5,
        plateau_limit=8,
        failure_limit=2,
    )

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    responses = iter([FakeResponse(), SSLError("boom"), SSLError("boom")])

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        response = next(responses)
        if isinstance(response, Exception):
            raise response
        return response

    extracted = iter([["vmess://first"]])

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: next(extracted, []),
    )

    result = fetch_source_links("leiting", source)

    assert result.successful_iterations == 1
    assert result.failed_iterations == 2
    assert result.links == ["vmess://first"]


def test_fetch_source_links_stops_when_runtime_budget_is_exceeded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=10,
        plateau_limit=99,
        max_runtime_seconds=1.0,
    )

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    calls = {"count": 0}
    times = iter([0.0, 0.0, 0.4, 0.9, 1.1])

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        calls["count"] += 1
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: [f"vmess://{calls['count']}"],
    )
    monkeypatch.setattr("vpn_automation.pipeline.extract.time.monotonic", lambda: next(times))

    result = fetch_source_links("leiting", source)

    assert calls["count"] == 3
    assert result.links == ["vmess://1", "vmess://2", "vmess://3"]


def test_fetch_source_links_honors_min_iterations_before_plateau_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=10,
        min_iterations=5,
        plateau_limit=2,
        max_runtime_seconds=0,
    )

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    calls = {"count": 0}

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        calls["count"] += 1
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: ["vmess://first"] if calls["count"] == 1 else [],
    )

    result = fetch_source_links("leiting", source)

    assert calls["count"] == 5
    assert result.links == ["vmess://first"]


def test_fetch_source_links_honors_min_iterations_before_failure_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=10,
        min_iterations=4,
        plateau_limit=99,
        failure_limit=2,
        max_runtime_seconds=0,
    )

    calls = {"count": 0}

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        calls["count"] += 1
        raise SSLError("boom")

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.resolve_upstream_proxy_url", lambda: "")

    result = fetch_source_links("leiting", source)

    assert calls["count"] == 4
    assert result.failed_iterations == 4


def test_fetch_source_links_retries_with_upstream_proxy_after_direct_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=1,
    )
    calls: list[dict] = []

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        calls.append({"url": url, "proxies": proxies})
        if len(calls) == 1:
            raise SSLError("direct failed")
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: ["vmess://first"],
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.resolve_upstream_proxy_url",
        lambda: "http://127.0.0.1:7897",
    )

    result = fetch_source_links("leiting", source)

    assert result.links == ["vmess://first"]
    assert calls[0]["proxies"] is None
    assert calls[1]["proxies"] == {
        "http": "http://127.0.0.1:7897",
        "https": "http://127.0.0.1:7897",
    }


def test_fetch_source_links_emits_structured_extract_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = SourceConfig(
        url="https://example.com/api?t=123",
        key="abcdabcdabcdabcd",
        max_iterations=1,
    )
    events: list[dict] = []

    class FakeResponse:
        text = "cipher"

        def raise_for_status(self) -> None:
            return None

    def fake_get(self, url: str, timeout: int, verify: bool, proxies=None):
        return FakeResponse()

    monkeypatch.setattr("vpn_automation.pipeline.extract.requests.Session.get", fake_get)
    monkeypatch.setattr("vpn_automation.pipeline.extract.decrypt_payload", lambda text, key: "plaintext")
    monkeypatch.setattr(
        "vpn_automation.pipeline.extract.extract_links_from_plaintext",
        lambda source_name, plaintext: ["vmess://first"],
    )

    result = fetch_source_links(
        "leiting",
        source,
        event_callback=lambda event_type, payload: events.append({"type": event_type, **payload}),
    )

    assert result.links == ["vmess://first"]
    assert [event["type"] for event in events] == [
        "extract_source_started",
        "extract_request_result",
        "extract_decrypt_result",
        "extract_iteration",
        "extract_source_completed",
    ]
    assert events[1]["success"] is True
    assert events[2]["success"] is True
    assert events[3]["new_items"] == 1
    assert events[3]["total_links"] == 1
