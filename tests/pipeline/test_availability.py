from types import SimpleNamespace

import pytest

from vpn_automation.pipeline.availability import (
    AvailabilityResult,
    ProviderCheckResult,
    ProviderTarget,
    PROVIDER_TARGETS,
    check_link_availability_batch,
    fetch_provider_result,
    evaluate_provider_response,
)
from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.speedtest import SpeedTestResult


def test_evaluate_provider_response_rejects_region_block_page() -> None:
    target = ProviderTarget(
        name="chatgpt",
        url="https://chatgpt.com/",
        allowed_hosts=("chatgpt.com", "chat.openai.com"),
        negative_phrases=("unsupported country",),
    )

    result = evaluate_provider_response(
        target,
        final_url="https://chatgpt.com/",
        status_code=200,
        title="ChatGPT",
        body="OpenAI services are not available in your unsupported country",
    )

    assert result.passed is False
    assert result.reason == "negative_phrase"


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
            "chatgpt": ProviderCheckResult(provider="chatgpt", passed=False, reason="negative_phrase"),
            "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
        },
    )

    assert result.all_passed is False
    assert result.link == "vmess://node"


def test_fetch_provider_result_uses_tls_verification(monkeypatch: pytest.MonkeyPatch) -> None:
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
        PROVIDER_TARGETS[0],
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

    def fake_check(speed_result, config, *, xray_path=""):
        if speed_result.link == "vmess://bad":
            raise RuntimeError("proxy bootstrap failed")
        return AvailabilityResult(
            speed_result=speed_result,
            provider_results={
                "gemini": ProviderCheckResult(provider="gemini", passed=True, reason="ok"),
                "chatgpt": ProviderCheckResult(provider="chatgpt", passed=True, reason="ok"),
                "claude": ProviderCheckResult(provider="claude", passed=True, reason="ok"),
            },
        )

    monkeypatch.setattr("vpn_automation.pipeline.availability.check_link_availability", fake_check)

    results = check_link_availability_batch([good, bad], config)

    assert len(results) == 2
    failed = next(item for item in results if item.link == "vmess://bad")
    assert failed.all_passed is False
    assert failed.provider_results["gemini"].reason == "runtime_error"
