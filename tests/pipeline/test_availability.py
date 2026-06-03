from types import SimpleNamespace

import pytest

from vpn_automation.pipeline.availability import (
    AvailabilityResult,
    ProviderCheckResult,
    ProviderTarget,
    PROVIDER_TARGETS,
    check_link_availability_batch,
    check_link_availability,
    fetch_provider_result,
    evaluate_provider_response,
    normalize_provider_targets,
    resolve_node_module_dir,
    resolve_node_binary,
)
from vpn_automation.config.models import AvailabilityTargetConfig, SpeedTestConfig
from vpn_automation.pipeline.speedtest import SpeedTestResult


def test_evaluate_provider_response_rejects_challenge_page() -> None:
    target = ProviderTarget(
        name="custom",
        url="https://custom.example/",
        allowed_hosts=("custom.example",),
        negative_phrases=(),
    )

    result = evaluate_provider_response(
        target,
        final_url="https://custom.example/",
        status_code=200,
        title="Just a moment",
        body="Checking your browser before accessing this site.",
    )

    assert result.passed is False
    assert result.reason == "challenge_page"


def test_evaluate_provider_response_rejects_redirect_outside_allowed_hosts() -> None:
    target = ProviderTarget(
        name="claude",
        url="https://claude.ai/",
        allowed_hosts=("claude.ai",),
        negative_phrases=("unavailable in your region",),
    )

    result = evaluate_provider_response(
        target,
        final_url="https://example.com/blocked",
        status_code=302,
        title="redirect",
        body="redirect",
    )

    assert result.passed is False
    assert result.reason == "unexpected_host"


def test_availability_result_requires_all_providers_to_pass() -> None:
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=3.5, latency_ms=80)
    result = AvailabilityResult(
        speed_result=speed,
        provider_results={
            "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
            "chatgpt_web": ProviderCheckResult(provider="chatgpt_web", passed=False, reason="unsupported_region"),
            "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
        },
    )

    assert result.all_passed is False
    assert result.link == "vmess://node"


def test_normalize_provider_targets_uses_custom_profile_targets() -> None:
    targets = normalize_provider_targets(
        {
            "gemini": AvailabilityTargetConfig(
                url="https://gemini.example/",
                enabled=False,
                allowed_hosts=["gemini.example"],
                negative_phrases=["blocked"],
            ),
            "tmailor": AvailabilityTargetConfig(
                url="https://tmailor.example/",
                enabled=True,
                allowed_hosts=["tmailor.example"],
                negative_phrases=["not supported"],
            ),
        }
    )

    assert [target.name for target in targets] == ["tmailor"]
    assert targets[0].url == "https://tmailor.example/"
    assert targets[0].allowed_hosts == ("tmailor.example",)
    assert targets[0].negative_phrases == ()


def test_check_link_availability_only_checks_enabled_targets(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=1,
        urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
    )
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=2.0, latency_ms=50)
    checked_targets: list[str] = []

    class DummyRuntime:
        def __init__(self) -> None:
            self.session = object()
            self.proxies = {"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_fetch_provider_result(session, proxies, target, timeout_seconds):
        checked_targets.append(target.name)
        return ProviderCheckResult(
            provider=target.name,
            passed=True,
            reason="ok",
            status_code=200,
            final_url=target.url,
        )

    monkeypatch.setattr("vpn_automation.pipeline.availability.open_proxy_runtime", lambda *args, **kwargs: DummyRuntime())
    monkeypatch.setattr("vpn_automation.pipeline.availability.fetch_provider_result", fake_fetch_provider_result)
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_results_with_browser",
        lambda proxies, targets, timeout_seconds, project_root='': {},
    )

    result = check_link_availability(
        speed,
        config,
        targets=normalize_provider_targets(
            {
                "gemini": AvailabilityTargetConfig(
                    url="https://gemini.example/",
                    enabled=False,
                    allowed_hosts=["gemini.example"],
                    negative_phrases=[],
                ),
                "tmailor": AvailabilityTargetConfig(
                    url="https://tmailor.example/",
                    enabled=True,
                    allowed_hosts=["tmailor.example"],
                    negative_phrases=[],
                ),
            }
        ),
    )

    assert checked_targets == ["tmailor"]
    assert list(result.provider_results) == ["tmailor"]
    assert result.all_passed is True


def test_fetch_provider_result_uses_chatgpt_ios_unlock_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[tuple[str, dict]] = []

    class FakeResponse:
        def __init__(self, url: str, text: str, status_code: int = 200) -> None:
            self.url = url
            self.text = text
            self.status_code = status_code

    class FakeSession:
        def get(self, url, **kwargs):
            captured.append((url, kwargs))
            if url == "https://chat.openai.com/cdn-cgi/trace":
                return FakeResponse(url, "loc=US\n")
            assert url == "https://ios.chat.openai.com/"
            return FakeResponse(url, "request is not allowed. please try again later.")

    result = fetch_provider_result(
        FakeSession(),
        {"https": "http://127.0.0.1:18080"},
        ProviderTarget(
            name="chatgpt_ios",
            url="https://ios.chat.openai.com/",
            allowed_hosts=("ios.chat.openai.com",),
            negative_phrases=(),
        ),
        20,
    )

    assert result.passed is True
    assert result.reason == "ok"
    assert result.final_url == "https://ios.chat.openai.com/"
    assert result.matched_phrase == "US"
    assert [item[0] for item in captured] == [
        "https://chat.openai.com/cdn-cgi/trace",
        "https://ios.chat.openai.com/",
    ]
    assert all(item[1]["verify"] is True for item in captured)


def test_fetch_provider_result_uses_chatgpt_web_unlock_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: list[str] = []

    class FakeResponse:
        def __init__(self, url: str, text: str, status_code: int = 200) -> None:
            self.url = url
            self.text = text
            self.status_code = status_code

    class FakeSession:
        def get(self, url, **kwargs):
            captured.append(url)
            if url == "https://chat.openai.com/cdn-cgi/trace":
                return FakeResponse(url, "loc=HK\n")
            assert url == "https://api.openai.com/compliance/cookie_requirements"
            return FakeResponse(url, '{"unsupported_country":true}')

    result = fetch_provider_result(
        FakeSession(),
        {"https": "http://127.0.0.1:18080"},
        ProviderTarget(
            name="chatgpt_web",
            url="https://api.openai.com/compliance/cookie_requirements",
            allowed_hosts=("api.openai.com",),
            negative_phrases=(),
        ),
        20,
    )

    assert result.passed is False
    assert result.reason == "unsupported_region"
    assert result.final_url == "https://api.openai.com/compliance/cookie_requirements"
    assert result.matched_phrase == "HK"
    assert captured == [
        "https://chat.openai.com/cdn-cgi/trace",
        "https://api.openai.com/compliance/cookie_requirements",
    ]


def test_fetch_provider_result_uses_claude_trace_blocklist(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSession:
        def get(self, url, **kwargs):
            assert url == "https://claude.ai/cdn-cgi/trace"
            return SimpleNamespace(url=url, status_code=200, text="loc=CN\n")

    result = fetch_provider_result(
        FakeSession(),
        {"https": "http://127.0.0.1:18080"},
        ProviderTarget(
            name="claude",
            url="https://claude.ai/cdn-cgi/trace",
            allowed_hosts=("claude.ai",),
            negative_phrases=(),
        ),
        20,
    )

    assert result.passed is False
    assert result.reason == "unsupported_region"
    assert result.final_url == "https://claude.ai/cdn-cgi/trace"
    assert result.matched_phrase == "CN"


def test_fetch_provider_result_uses_gemini_region_marker(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSession:
        def get(self, url, **kwargs):
            assert url == "https://gemini.google.com"
            return SimpleNamespace(url=url, status_code=200, text='prefix,2,1,200,"CHN" suffix')

    result = fetch_provider_result(
        FakeSession(),
        {"https": "http://127.0.0.1:18080"},
        ProviderTarget(
            name="gemini",
            url="https://gemini.google.com",
            allowed_hosts=("gemini.google.com",),
            negative_phrases=(),
        ),
        20,
    )

    assert result.passed is False
    assert result.reason == "unsupported_region"
    assert result.final_url == "https://gemini.google.com"
    assert result.matched_phrase == "CHN"


def test_fetch_custom_provider_result_uses_tls_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, object] = {}

    class FakeSession:
        def get(self, url, **kwargs):
            captured["url"] = url
            captured["kwargs"] = kwargs
            return SimpleNamespace(
                url=url,
                status_code=200,
                text="<html><title>ok</title><body>ok</body></html>",
            )

    result = fetch_provider_result(
        FakeSession(),
        {"https": "http://127.0.0.1:18080"},
        ProviderTarget(
            name="custom",
            url="https://custom.example/",
            allowed_hosts=("custom.example",),
            negative_phrases=(),
        ),
        20,
    )

    assert result.passed is True
    assert captured["kwargs"]["verify"] is True


def test_check_link_availability_batch_downgrades_runtime_errors_to_failed_node(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=2,
        urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
    )
    good = SpeedTestResult(link="vmess://good", reachable=True, average_download_mb_s=2.0, latency_ms=50)
    bad = SpeedTestResult(link="vmess://bad", reachable=True, average_download_mb_s=2.0, latency_ms=50)

    def fake_check(speed_result, config, *, runtime_path="", targets=None):
        if speed_result.link == "vmess://bad":
            raise RuntimeError("proxy bootstrap failed")
        return AvailabilityResult(
            speed_result=speed_result,
            provider_results={
                "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                "chatgpt_web": ProviderCheckResult(provider="chatgpt_web", passed=True, reason="ok"),
                "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
            },
        )

    monkeypatch.setattr("vpn_automation.pipeline.availability.check_link_availability", fake_check)

    results = check_link_availability_batch([good, bad], config)

    assert len(results) == 2
    failed = next(item for item in results if item.link == "vmess://bad")
    assert failed.all_passed is False
    assert failed.provider_results["gemini"].reason == "runtime_error"


def test_check_link_availability_uses_browser_fallback_for_http_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=1,
        urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
    )
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=2.0, latency_ms=50)

    class DummyRuntime:
        def __init__(self) -> None:
            self.session = object()
            self.proxies = {"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    target = ProviderTarget(
        name="custom",
        url="https://custom.example/",
        allowed_hosts=("custom.example",),
        negative_phrases=(),
    )
    primary_results = {
        "custom": ProviderCheckResult(provider="custom", passed=False, reason="http_error", status_code=403, final_url="https://custom.example/"),
    }

    def fake_fetch_provider_result(session, proxies, target, timeout_seconds):
        return primary_results[target.name]

    browser_results = {
        "custom": ProviderCheckResult(provider="custom", passed=True, reason="ok", status_code=200, final_url="https://custom.example/"),
    }

    monkeypatch.setattr("vpn_automation.pipeline.availability.open_proxy_runtime", lambda *args, **kwargs: DummyRuntime())
    monkeypatch.setattr("vpn_automation.pipeline.availability.fetch_provider_result", fake_fetch_provider_result)
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_results_with_browser",
        lambda proxies, targets, timeout_seconds, project_root='': browser_results,
    )

    result = check_link_availability(speed, config, targets=(target,))

    assert result.all_passed is True
    assert result.provider_results["custom"].passed is True


def test_resolve_node_binary_falls_back_when_path_does_not_find_node(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    bundled_node = tmp_path / "node"
    bundled_node.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.delenv("VPN_AUTOMATION_NODE_PATH", raising=False)
    monkeypatch.setattr("vpn_automation.pipeline.availability.shutil.which", lambda _name: None)

    assert resolve_node_binary(extra_candidates=(str(bundled_node),)) == str(bundled_node)


def test_resolve_node_module_dir_prefers_bundled_runtime_vendor(tmp_path) -> None:
    project_root = tmp_path / "app"
    vendor_modules = project_root / "electron" / "runtime" / "node-vendor" / "node_modules"
    (vendor_modules / "playwright").mkdir(parents=True)

    assert resolve_node_module_dir(str(project_root)) == str(vendor_modules)


def test_check_link_availability_preserves_primary_results_when_browser_fallback_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=1,
        urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
    )
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=2.0, latency_ms=50)

    class DummyRuntime:
        def __init__(self) -> None:
            self.session = object()
            self.proxies = {"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    target = ProviderTarget(
        name="custom",
        url="https://custom.example/",
        allowed_hosts=("custom.example",),
        negative_phrases=(),
    )
    primary_results = {
        "custom": ProviderCheckResult(provider="custom", passed=False, reason="http_error", status_code=403, final_url="https://custom.example/"),
    }

    monkeypatch.setattr("vpn_automation.pipeline.availability.open_proxy_runtime", lambda *args, **kwargs: DummyRuntime())
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_result",
        lambda session, proxies, target, timeout_seconds: primary_results[target.name],
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_results_with_browser",
        lambda *args, **kwargs: (_ for _ in ()).throw(FileNotFoundError("node binary not found")),
    )

    result = check_link_availability(speed, config, targets=(target,))

    assert result.provider_results["custom"].reason == "browser_probe_error"
    assert result.provider_results["custom"].matched_phrase == "node binary not found"


def test_check_link_availability_uses_runtime_proxy_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=1,
        urls=["https://raw.githubusercontent.com/bulianglin/demo/main/10MB.bin"],
    )
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=2.0, latency_ms=50)
    captured: dict[str, object] = {}

    class DummyRuntime:
        def __init__(self) -> None:
            self.session = object()
            self.proxies = {"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_open_proxy_runtime(*args, **kwargs):
        captured["startup_wait_seconds"] = kwargs.get("startup_wait_seconds")
        return DummyRuntime()

    monkeypatch.setattr("vpn_automation.pipeline.availability.open_proxy_runtime", fake_open_proxy_runtime)
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_result",
        lambda session, proxies, target, timeout_seconds: ProviderCheckResult(
            provider=target.name,
            passed=True,
            reason="ok",
            status_code=200,
            final_url=target.url,
        ),
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.fetch_provider_results_with_browser",
        lambda proxies, targets, timeout_seconds, project_root='': {},
    )

    result = check_link_availability(speed, config)

    assert result.all_passed is True
    assert captured["startup_wait_seconds"] == config.startup_wait_seconds


def test_check_link_availability_batch_emits_link_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=2,
        urls=["https://speed.cloudflare.com/__down?bytes=5000000"],
    )
    speed = SpeedTestResult(link="vmess://node", reachable=True, average_download_mb_s=2.0, latency_ms=50)
    events: list[dict] = []

    monkeypatch.setattr(
        "vpn_automation.pipeline.availability.check_link_availability",
        lambda speed_result, config, *, runtime_path="", targets=None: AvailabilityResult(
            speed_result=speed_result,
            provider_results={
                "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
            },
        ),
    )

    results = check_link_availability_batch(
        [speed],
        config,
        event_callback=lambda event_type, payload: events.append({"type": event_type, **payload}),
    )

    assert len(results) == 1
    assert [event["type"] for event in events] == ["availability_link_result"]
    assert events[0]["all_passed"] is True
    assert events[0]["link"] == "vmess://node"
