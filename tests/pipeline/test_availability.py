from vpn_automation.pipeline.availability import (
    AvailabilityResult,
    ProviderCheckResult,
    ProviderTarget,
    evaluate_provider_response,
)
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
