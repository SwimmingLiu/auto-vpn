import json
import os
import shutil
import subprocess
import inspect
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import requests

from vpn_automation.config.models import resolve_repo_anchor
from vpn_automation.config.models import AvailabilityTargetConfig
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

BROWSER_LIKE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

CHALLENGE_PHRASES = (
    "just a moment",
    "checking your browser",
    "verify you are human",
    "enable javascript and cookies",
)

CLAUDE_BLOCKED_CODES = {"AF", "BY", "CN", "CU", "HK", "IR", "KP", "MO", "RU", "SY"}
GEMINI_BLOCKED_CODES = {"CHN", "RUS", "BLR", "CUB", "IRN", "PRK", "SYR", "HKG", "MAC"}
GEMINI_REGION_MARKERS = (',2,1,200,"', ',2,1,200,\\"')

NODE_BINARY_CANDIDATES = (
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
)


def _emit_event(
    event_callback: Callable[[str, dict[str, Any]], None] | None,
    event_type: str,
    **payload: Any,
) -> None:
    if event_callback:
        event_callback(event_type, payload)


def _host_is_allowed(hostname: str, allowed_hosts: tuple[str, ...]) -> bool:
    host = hostname.lower()
    return any(host == allowed or host.endswith(f".{allowed}") for allowed in allowed_hosts)


def normalize_provider_targets(
    targets: dict[str, AvailabilityTargetConfig] | tuple[ProviderTarget, ...] | list[ProviderTarget] | None = None,
) -> tuple[ProviderTarget, ...]:
    if targets is None:
        return PROVIDER_TARGETS
    if isinstance(targets, tuple) and all(isinstance(target, ProviderTarget) for target in targets):
        return tuple(targets)
    if isinstance(targets, list) and all(isinstance(target, ProviderTarget) for target in targets):
        return tuple(targets)

    normalized_targets: list[ProviderTarget] = []
    for name, config in dict(targets).items():
        if not getattr(config, "enabled", True):
            continue
        url = str(getattr(config, "url", "") or "").strip()
        if not url:
            continue
        allowed_hosts = tuple(
            str(host).strip().lower()
            for host in getattr(config, "allowed_hosts", [])
            if str(host).strip()
        )
        if not allowed_hosts:
            host = urlparse(url).hostname or ""
            allowed_hosts = (host.lower(),) if host else ()
        normalized_targets.append(
            ProviderTarget(
                name=str(name),
                url=url,
                allowed_hosts=allowed_hosts,
                negative_phrases=tuple(
                    str(phrase).strip()
                    for phrase in getattr(config, "negative_phrases", [])
                    if str(phrase).strip()
                ),
            )
        )
    return tuple(normalized_targets)


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
    for phrase in CHALLENGE_PHRASES:
        if phrase in content:
            return ProviderCheckResult(
                provider=target.name,
                passed=False,
                reason="challenge_page",
                status_code=status_code,
                final_url=final_url,
                matched_phrase=phrase,
            )

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


def _target_key(target: ProviderTarget) -> str:
    return target.name.strip().lower().replace("-", "_").replace(" ", "_")


def _request_provider_url(
    session: requests.Session,
    proxies: dict[str, str],
    url: str,
    timeout_seconds: int,
):
    return session.get(
        url,
        proxies=proxies,
        timeout=timeout_seconds,
        verify=True,
        allow_redirects=True,
        headers=BROWSER_LIKE_HEADERS,
    )


def _response_text(response: Any) -> str:
    return str(getattr(response, "text", "") or "")


def _response_status_code(response: Any) -> int:
    return int(getattr(response, "status_code", 0) or 0)


def _response_url(response: Any, fallback: str) -> str:
    return str(getattr(response, "url", "") or fallback)


def _extract_trace_loc(body: str) -> str:
    for line in body.splitlines():
        if line.startswith("loc="):
            return line.removeprefix("loc=").strip().upper()
    return ""


def _build_provider_result(
    target: ProviderTarget,
    *,
    passed: bool,
    reason: str,
    status_code: int = 0,
    final_url: str = "",
    matched_phrase: str = "",
) -> ProviderCheckResult:
    return ProviderCheckResult(
        provider=target.name,
        passed=passed,
        reason=reason,
        status_code=status_code,
        final_url=final_url,
        matched_phrase=matched_phrase,
    )


def _request_error_result(
    target: ProviderTarget,
    url: str,
    exc: requests.RequestException,
) -> ProviderCheckResult:
    return _build_provider_result(
        target,
        passed=False,
        reason=exc.__class__.__name__.lower(),
        final_url=url,
    )


def _check_chatgpt_unlock(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult:
    trace_url = "https://chat.openai.com/cdn-cgi/trace"
    try:
        _request_provider_url(session, proxies, trace_url, timeout_seconds)
    except requests.RequestException:
        pass

    web_url = "https://api.openai.com/compliance/cookie_requirements"
    try:
        response = _request_provider_url(session, proxies, web_url, timeout_seconds)
    except requests.RequestException as exc:
        return _request_error_result(target, web_url, exc)

    status_code = _response_status_code(response)
    final_url = _response_url(response, web_url)
    body_lower = _response_text(response).lower()
    if "unsupported_country" in body_lower:
        return _build_provider_result(
            target,
            passed=False,
            reason="unsupported_region",
            status_code=status_code,
            final_url=final_url,
            matched_phrase="unsupported_country",
        )

    if status_code >= 500:
        return _build_provider_result(
            target,
            passed=False,
            reason="http_error",
            status_code=status_code,
            final_url=final_url,
        )

    return _build_provider_result(
        target,
        passed=True,
        reason="ok",
        status_code=status_code,
        final_url=final_url,
    )


def _check_claude_unlock(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult:
    trace_url = "https://claude.ai/cdn-cgi/trace"
    try:
        response = _request_provider_url(session, proxies, trace_url, timeout_seconds)
    except requests.RequestException as exc:
        return _request_error_result(target, trace_url, exc)

    status_code = _response_status_code(response)
    final_url = _response_url(response, trace_url)
    country_code = _extract_trace_loc(_response_text(response))
    if not country_code:
        return _build_provider_result(
            target,
            passed=False,
            reason="parse_error",
            status_code=status_code,
            final_url=final_url,
        )

    if country_code in CLAUDE_BLOCKED_CODES:
        return _build_provider_result(
            target,
            passed=False,
            reason="unsupported_region",
            status_code=status_code,
            final_url=final_url,
            matched_phrase=country_code,
        )

    return _build_provider_result(
        target,
        passed=True,
        reason="ok",
        status_code=status_code,
        final_url=final_url,
        matched_phrase=country_code,
    )


def _extract_gemini_country_code(body: str) -> str:
    for marker in GEMINI_REGION_MARKERS:
        index = body.find(marker)
        if index == -1:
            continue
        start = index + len(marker)
        country_code = body[start:start + 3]
        if len(country_code) == 3 and country_code.isascii() and country_code.isupper():
            return country_code
    return ""


def _check_gemini_unlock(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult:
    url = "https://gemini.google.com/"
    try:
        response = _request_provider_url(session, proxies, url, timeout_seconds)
    except requests.RequestException as exc:
        return _request_error_result(target, url, exc)

    status_code = _response_status_code(response)
    final_url = _response_url(response, url)
    country_code = _extract_gemini_country_code(_response_text(response))
    if not country_code:
        return _build_provider_result(
            target,
            passed=False,
            reason="parse_error",
            status_code=status_code,
            final_url=final_url,
        )

    if country_code in GEMINI_BLOCKED_CODES:
        return _build_provider_result(
            target,
            passed=False,
            reason="unsupported_region",
            status_code=status_code,
            final_url=final_url,
            matched_phrase=country_code,
        )

    return _build_provider_result(
        target,
        passed=True,
        reason="ok",
        status_code=status_code,
        final_url=final_url,
        matched_phrase=country_code,
    )


def _fetch_unlock_provider_result(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult | None:
    key = _target_key(target)
    if key in {"chatgpt", "chatgpt_web"}:
        return _check_chatgpt_unlock(session, proxies, target, timeout_seconds)
    if key == "claude":
        return _check_claude_unlock(session, proxies, target, timeout_seconds)
    if key == "gemini":
        return _check_gemini_unlock(session, proxies, target, timeout_seconds)
    return None


def fetch_provider_result(
    session: requests.Session,
    proxies: dict[str, str],
    target: ProviderTarget,
    timeout_seconds: int,
) -> ProviderCheckResult:
    unlock_result = _fetch_unlock_provider_result(session, proxies, target, timeout_seconds)
    if unlock_result is not None:
        return unlock_result

    try:
        response = _request_provider_url(
            session,
            proxies,
            target.url,
            timeout_seconds,
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


def should_retry_with_browser(result: ProviderCheckResult) -> bool:
    return result.reason in {"http_error", "challenge_page", "unexpected_host"}


def resolve_node_binary(extra_candidates: tuple[str, ...] = ()) -> str:
    candidates = [
        os.environ.get("VPN_AUTOMATION_NODE_PATH", "").strip(),
        shutil.which("node") or "",
        *extra_candidates,
        *NODE_BINARY_CANDIDATES,
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return candidate
    raise FileNotFoundError("node binary not found")


def fetch_provider_results_with_browser(
    proxies: dict[str, str],
    targets: tuple[ProviderTarget, ...],
    timeout_seconds: int,
    project_root: str = "",
) -> dict[str, ProviderCheckResult]:
    proxy_server = proxies.get("http") or proxies.get("https")
    if not proxy_server:
        raise RuntimeError("proxy server is missing for browser probe")

    repo_root = Path(project_root) if project_root else resolve_repo_anchor(Path(__file__))
    script = r"""
import { chromium } from 'playwright';
const proxyServer = process.argv[1];
const timeoutMs = Number(process.argv[2]);
const targets = JSON.parse(process.argv[3]);
const browser = await chromium.launch({ headless: true, proxy: { server: proxyServer } });
const context = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  locale: 'en-US',
});
for (const target of targets) {
  const page = await context.newPage();
  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForTimeout(5000);
    const title = await page.title();
    const finalUrl = page.url();
    const body = (await page.textContent('body')) || '';
    console.log(JSON.stringify({
      provider: target.name,
      status_code: response?.status() ?? 0,
      final_url: finalUrl,
      title,
      body: body.slice(0, 5000),
    }));
  } catch (error) {
    console.log(JSON.stringify({ provider: target.name, error: String(error) }));
  } finally {
    await page.close();
  }
}
await context.close();
await browser.close();
"""
    target_payload = json.dumps([{"name": target.name, "url": target.url} for target in targets], ensure_ascii=False)
    timeout_budget = max(timeout_seconds * len(targets) + 45, 60)
    result = subprocess.run(
        [resolve_node_binary(), "--input-type=module", "-e", script, proxy_server, str(timeout_seconds * 1000), target_payload],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        timeout=timeout_budget,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "browser probe failed")

    browser_results: dict[str, ProviderCheckResult] = {}
    for line in result.stdout.splitlines():
        payload = json.loads(line)
        provider = payload["provider"]
        if "error" in payload:
            browser_results[provider] = ProviderCheckResult(
                provider=provider,
                passed=False,
                reason="browser_probe_error",
                final_url=next(target.url for target in targets if target.name == provider),
                matched_phrase=payload["error"],
            )
            continue

        target = next(target for target in targets if target.name == provider)
        browser_results[provider] = evaluate_provider_response(
            target,
            final_url=payload["final_url"],
            status_code=int(payload["status_code"]),
            title=str(payload.get("title", "")),
            body=str(payload.get("body", "")),
        )
    return browser_results


def _build_runtime_error_result(
    speed_result: SpeedTestResult,
    reason: str,
    targets: tuple[ProviderTarget, ...] | None = None,
) -> AvailabilityResult:
    active_targets = normalize_provider_targets(targets)
    provider_results = {
        target.name: ProviderCheckResult(
            provider=target.name,
            passed=False,
            reason="runtime_error",
            final_url=target.url,
            matched_phrase=reason,
        )
        for target in active_targets
    }
    return AvailabilityResult(speed_result=speed_result, provider_results=provider_results)


def check_link_availability(
    speed_result: SpeedTestResult,
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
    targets: dict[str, AvailabilityTargetConfig] | tuple[ProviderTarget, ...] | list[ProviderTarget] | None = None,
) -> AvailabilityResult:
    active_targets = normalize_provider_targets(targets)
    if not active_targets:
        return AvailabilityResult(speed_result=speed_result, provider_results={})
    try:
        with open_proxy_runtime(
            speed_result.link,
            startup_wait_seconds=config.startup_wait_seconds,
            runtime_path=runtime_path,
        ) as runtime:
            provider_results = {
                target.name: fetch_provider_result(runtime.session, runtime.proxies, target, config.timeout_seconds)
                for target in active_targets
            }
            fallback_targets = tuple(
                target for target in active_targets if should_retry_with_browser(provider_results[target.name])
            )
            if fallback_targets:
                try:
                    browser_results = fetch_provider_results_with_browser(
                        runtime.proxies,
                        fallback_targets,
                        config.timeout_seconds,
                    )
                    provider_results.update(browser_results)
                except Exception as exc:
                    for target in fallback_targets:
                        provider_results[target.name] = ProviderCheckResult(
                            provider=target.name,
                            passed=False,
                            reason="browser_probe_error",
                            status_code=provider_results[target.name].status_code,
                            final_url=provider_results[target.name].final_url or target.url,
                            matched_phrase=str(exc),
                        )
        return AvailabilityResult(speed_result=speed_result, provider_results=provider_results)
    except Exception as exc:
        return _build_runtime_error_result(speed_result, str(exc), active_targets)


def _worker_accepts_targets(worker: Callable[..., Any]) -> bool:
    signature = inspect.signature(worker)
    return (
        "targets" in signature.parameters
        or any(parameter.kind == inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values())
    )


def check_link_availability_batch(
    results: list[SpeedTestResult],
    config: SpeedTestConfig,
    *,
    runtime_path: str = "",
    targets: dict[str, AvailabilityTargetConfig] | tuple[ProviderTarget, ...] | list[ProviderTarget] | None = None,
    progress_callback: Callable[[str], None] | None = None,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> list[AvailabilityResult]:
    if not results:
        return []

    active_targets = normalize_provider_targets(targets)
    accepts_targets = _worker_accepts_targets(check_link_availability)
    collected: list[AvailabilityResult | None] = [None] * len(results)
    with ThreadPoolExecutor(max_workers=max(1, config.concurrency)) as executor:
        future_map = {}
        for index, result in enumerate(results):
            kwargs: dict[str, Any] = {"runtime_path": runtime_path}
            if accepts_targets:
                kwargs["targets"] = active_targets
            future_map[executor.submit(check_link_availability, result, config, **kwargs)] = index
        for completed_index, future in enumerate(as_completed(future_map), start=1):
            index = future_map[future]
            speed_result = results[index]
            try:
                availability = future.result()
            except Exception as exc:
                availability = _build_runtime_error_result(speed_result, str(exc), active_targets)
            collected[index] = availability
            if progress_callback:
                statuses = " ".join(
                    f"{name}={'ok' if provider.passed else provider.reason}"
                    for name, provider in availability.provider_results.items()
                )
                progress_callback(f"[availability] {completed_index}/{len(results)} {statuses}")
            _emit_event(
                event_callback,
                "availability_link_result",
                completed=completed_index,
                total=len(results),
                link=availability.link,
                all_passed=availability.all_passed,
                provider_results={
                    name: asdict(provider) for name, provider in availability.provider_results.items()
                },
            )
    return [item for item in collected if item is not None]
