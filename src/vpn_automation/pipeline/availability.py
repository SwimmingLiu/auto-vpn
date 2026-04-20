from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from typing import Callable
from urllib.parse import urlparse

import requests

from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.proxy_runtime import open_proxy_runtime
from vpn_automation.pipeline.speedtest import SpeedTestResult


@dataclass(frozen=True)
class ProviderTarget:
    name: str
    url: str
    allowed_hosts: tuple[str, ...]
    negative_phrases: tuple[str, ...]


@dataclass
class ProviderCheckResult:
    provider: str
    passed: bool
    reason: str
    status_code: int = 0
    final_url: str = ""
    matched_phrase: str = ""


@dataclass
class AvailabilityResult:
    speed_result: SpeedTestResult
    provider_results: dict[str, ProviderCheckResult]

    @property
    def all_passed(self) -> bool:
        return all(result.passed for result in self.provider_results.values())

    @property
    def link(self) -> str:
        return self.speed_result.link

    def to_dict(self) -> dict:
        return {
            "link": self.link,
            "reachable": self.speed_result.reachable,
            "average_download_mb_s": self.speed_result.average_download_mb_s,
            "latency_ms": self.speed_result.latency_ms,
            "all_passed": self.all_passed,
            "provider_results": {
                name: asdict(result) for name, result in self.provider_results.items()
            },
        }


PROVIDER_TARGETS: tuple[ProviderTarget, ...] = (
    ProviderTarget(
        name="gemini",
        url="https://gemini.google.com/",
        allowed_hosts=("gemini.google.com", "accounts.google.com"),
        negative_phrases=(
            "not available in your country",
            "not available in your country or territory",
            "isn't available in your country",
            "not available in your region",
        ),
    ),
    ProviderTarget(
        name="chatgpt",
        url="https://chatgpt.com/",
        allowed_hosts=("chatgpt.com", "chat.openai.com", "auth.openai.com", "login.openai.com"),
        negative_phrases=(
            "unsupported country",
            "unsupported region",
            "country, region, or territory",
            "not available in your country",
        ),
    ),
    ProviderTarget(
        name="claude",
        url="https://claude.ai/",
        allowed_hosts=("claude.ai", "support.anthropic.com"),
        negative_phrases=(
            "unavailable in your region",
            "supported regions",
            "physically located in one of our supported regions",
            "outside of our supported locations",
        ),
    ),
)


def _host_is_allowed(hostname: str, allowed_hosts: tuple[str, ...]) -> bool:
    host = hostname.lower()
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in allowed_hosts)


def evaluate_provider_response(
    target: ProviderTarget,
    *,
    final_url: str,
    status_code: int,
    title: str,
    body: str,
) -> ProviderCheckResult:
    host = urlparse(final_url).hostname or ""
    if not host or not _host_is_allowed(host, target.allowed_hosts):
        return ProviderCheckResult(
            provider=target.name,
            passed=False,
            reason="unexpected_host",
            status_code=status_code,
            final_url=final_url,
        )

    if status_code >= 400:
        return ProviderCheckResult(
            provider=target.name,
            passed=False,
            reason="http_error",
            status_code=status_code,
            final_url=final_url,
        )

    content = f"{title}\n{body}".lower()
    for phrase in target.negative_phrases:
        if phrase.lower() in content:
            return ProviderCheckResult(
                provider=target.name,
                passed=False,
                reason="negative_phrase",
                status_code=status_code,
                final_url=final_url,
                matched_phrase=phrase,
            )

    return ProviderCheckResult(
        provider=target.name,
        passed=True,
        reason="ok",
        status_code=status_code,
        final_url=final_url,
    )


def fetch_provider_result(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult:
    try:
        response = session.get(
            target.url,
            proxies=proxies,
            timeout=timeout_seconds,
            verify=False,
            allow_redirects=True,
        )
        return evaluate_provider_response(
            target,
            final_url=response.url,
            status_code=response.status_code,
            title=response.text[:512],
            body=response.text,
        )
    except requests.RequestException as exc:
        return ProviderCheckResult(
            provider=target.name,
            passed=False,
            reason=exc.__class__.__name__.lower(),
            final_url=target.url,
        )


def check_link_availability(
    speed_result: SpeedTestResult,
    config: SpeedTestConfig,
    *,
    xray_path: str = "",
) -> AvailabilityResult:
    with open_proxy_runtime(
        speed_result.link,
        startup_wait_seconds=config.startup_wait_seconds,
        xray_path=xray_path,
    ) as runtime:
        provider_results = {
            target.name: fetch_provider_result(runtime.session, runtime.proxies, target, config.timeout_seconds)
            for target in PROVIDER_TARGETS
        }
    return AvailabilityResult(speed_result=speed_result, provider_results=provider_results)


def check_link_availability_batch(
    results: list[SpeedTestResult],
    config: SpeedTestConfig,
    *,
    xray_path: str = "",
    progress_callback: Callable[[str], None] | None = None,
) -> list[AvailabilityResult]:
    if not results:
        return []

    collected: list[AvailabilityResult | None] = [None] * len(results)
    with ThreadPoolExecutor(max_workers=max(1, config.concurrency)) as executor:
        future_map = {
            executor.submit(check_link_availability, result, config, xray_path=xray_path): index
            for index, result in enumerate(results)
        }
        for completed_index, future in enumerate(as_completed(future_map), start=1):
            index = future_map[future]
            availability = future.result()
            collected[index] = availability
            if progress_callback:
                statuses = " ".join(
                    f"{name}={'ok' if provider.passed else provider.reason}"
                    for name, provider in availability.provider_results.items()
                )
                progress_callback(f"[availability] {completed_index}/{len(results)} {statuses}")
    return [item for item in collected if item is not None]
