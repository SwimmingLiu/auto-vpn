import json
from pathlib import Path

from vpn_automation.config.models import SpeedTestConfig
from vpn_automation.pipeline.proxy_runtime import (
    _register_active_proxy_runtime,
    build_mihomo_runtime_config,
    build_runtime_env,
    terminate_active_proxy_runtimes,
)
from vpn_automation.pipeline.speedtest import (
    ProbeResult,
    SpeedTestResult,
    aggregate_speed_measurements,
    probe_links,
    probe_vmess_link,
    select_speedtest_candidates,
    speedtest_links,
)


FIXTURE_DIR = Path(__file__).resolve().parents[1] / "fixtures" / "node-migration" / "pipeline" / "speedtest"


def test_build_mihomo_runtime_config_uses_mixed_port_and_ws_proxy() -> None:
    payload = {
        "add": "1.1.1.1",
        "port": "443",
        "id": "418048af-a293-4b99-9b0c-98ca3580dd24",
        "aid": "0",
        "scy": "auto",
        "net": "ws",
        "host": "www.google.com",
        "path": "/footers",
        "tls": "tls",
        "sni": "www.google.com",
    }

    config = build_mihomo_runtime_config(payload, mixed_port=18080, controller_port=19090)

    assert config["mixed-port"] == 18080
    assert config["external-controller"] == "127.0.0.1:19090"
    assert config["proxy-groups"][0]["name"] == "GLOBAL"
    assert config["proxies"][0]["type"] == "vmess"
    assert config["proxies"][0]["network"] == "ws"
    assert config["proxies"][0]["ws-opts"]["path"] == "/footers"


def test_build_runtime_env_strips_proxy_variables(monkeypatch) -> None:
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:7890")
    monkeypatch.setenv("ALL_PROXY", "socks5://127.0.0.1:7891")

    env = build_runtime_env()

    assert "HTTP_PROXY" not in env
    assert "HTTPS_PROXY" not in env
    assert "ALL_PROXY" not in env


def test_terminate_active_proxy_runtimes_terminates_process_and_unlinks_config(tmp_path) -> None:
    class DummyProcess:
        def __init__(self) -> None:
            self.terminated = False
            self.killed = False
            self.waited = False

        def poll(self):
            return None

        def terminate(self) -> None:
            self.terminated = True

        def wait(self, timeout=None) -> None:
            self.waited = True

        def kill(self) -> None:
            self.killed = True

    config_path = tmp_path / "runtime.json"
    config_path.write_text("{}", encoding="utf-8")
    process = DummyProcess()
    _register_active_proxy_runtime(process, config_path)

    cleaned = terminate_active_proxy_runtimes()

    assert cleaned == 1
    assert process.terminated is True
    assert process.waited is True
    assert process.killed is False
    assert not config_path.exists()


def test_aggregate_speed_measurements_uses_average_of_successful_sources() -> None:
    value = aggregate_speed_measurements([1.2, 2.4, 3.0])
    assert value == 2.2


def test_select_speedtest_candidates_prefers_low_latency_and_respects_limit() -> None:
    probes = [
        ProbeResult(link="vmess://slow", reachable=True, latency_ms=180),
        ProbeResult(link="vmess://fast", reachable=True, latency_ms=40),
        ProbeResult(link="vmess://down", reachable=False, latency_ms=0, error="timeout"),
        ProbeResult(link="vmess://mid", reachable=True, latency_ms=90),
    ]

    assert select_speedtest_candidates(probes, limit=2) == [
        "vmess://fast",
        "vmess://mid",
    ]


def test_speedtest_links_only_full_tests_probe_ranked_candidates(monkeypatch) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=2,
        urls=["https://speed.example/10mb"],
        max_download_candidates=2,
    )
    called: list[str] = []

    monkeypatch.setattr(
        "vpn_automation.pipeline.speedtest.probe_links",
        lambda links, config, runtime_path="", progress_callback=None: [
            ProbeResult(link="vmess://a", reachable=True, latency_ms=120),
            ProbeResult(link="vmess://b", reachable=True, latency_ms=30),
            ProbeResult(link="vmess://c", reachable=False, latency_ms=0, error="timeout"),
            ProbeResult(link="vmess://d", reachable=True, latency_ms=60),
        ],
    )

    def fake_test(link, config, *, runtime_path=""):
        called.append(link)
        from vpn_automation.pipeline.speedtest import SpeedTestResult

        return SpeedTestResult(link=link, reachable=True, average_download_mb_s=2.0, latency_ms=25)

    monkeypatch.setattr("vpn_automation.pipeline.speedtest.test_vmess_link", fake_test)

    results = speedtest_links(["vmess://a", "vmess://b", "vmess://c", "vmess://d"], config)

    assert sorted(called) == ["vmess://b", "vmess://d"]
    assert sorted(result.link for result in results) == ["vmess://b", "vmess://c", "vmess://d"]


def test_probe_links_emits_probe_events(monkeypatch) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=2,
        urls=["https://speed.example/10mb"],
    )
    events: list[dict] = []

    monkeypatch.setattr(
        "vpn_automation.pipeline.speedtest.probe_vmess_link",
        lambda link, config, *, runtime_path="": ProbeResult(link=link, reachable=True, latency_ms=42),
    )

    results = probe_links(
        ["vmess://a", "vmess://b"],
        config,
        event_callback=lambda event_type, payload: events.append({"type": event_type, **payload}),
    )

    assert [result.link for result in results] == ["vmess://a", "vmess://b"]
    assert [event["type"] for event in events] == [
        "speedtest_probe_result",
        "speedtest_probe_result",
    ]
    assert events[0]["completed"] == 1
    assert events[-1]["completed"] == 2


def test_probe_vmess_link_measures_reachability_through_runtime_proxy(monkeypatch) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=1,
        urls=["https://speed.example/10mb"],
    )
    captured: dict[str, object] = {}

    class DummyResponse:
        status_code = 204

    class DummySession:
        def get(self, url, *, proxies, timeout, verify):
            captured["url"] = url
            captured["proxies"] = proxies
            captured["timeout"] = timeout
            captured["verify"] = verify
            return DummyResponse()

    class DummyRuntime:
        proxies = {"http": "http://127.0.0.1:18080", "https": "http://127.0.0.1:18080"}
        session = DummySession()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(
        "vpn_automation.pipeline.speedtest.open_proxy_runtime",
        lambda *args, **kwargs: DummyRuntime(),
    )
    probe_times = iter([10.0, 10.321])
    monkeypatch.setattr("vpn_automation.pipeline.speedtest.time.perf_counter", lambda: next(probe_times))

    result = probe_vmess_link("vmess://a", config)

    assert result.reachable is True
    assert result.latency_ms == 321
    assert captured["url"] == config.probe_url
    assert captured["proxies"] == DummyRuntime.proxies
    assert captured["timeout"] == config.timeout_seconds
    assert captured["verify"] is False


def test_speedtest_links_emits_selected_and_full_test_events(monkeypatch) -> None:
    config = SpeedTestConfig(
        min_download_mb_s=1.0,
        timeout_seconds=20,
        concurrency=2,
        urls=["https://speed.example/10mb"],
        max_download_candidates=2,
    )
    events: list[dict] = []

    monkeypatch.setattr(
        "vpn_automation.pipeline.speedtest.probe_links",
        lambda links, config, runtime_path="", progress_callback=None, event_callback=None: [
            ProbeResult(link="vmess://a", reachable=True, latency_ms=120),
            ProbeResult(link="vmess://b", reachable=True, latency_ms=30),
            ProbeResult(link="vmess://c", reachable=False, latency_ms=0, error="timeout"),
        ],
    )

    def fake_test(link, config, *, runtime_path=""):
        from vpn_automation.pipeline.speedtest import SpeedTestResult

        return SpeedTestResult(link=link, reachable=True, average_download_mb_s=2.0, latency_ms=25)

    monkeypatch.setattr("vpn_automation.pipeline.speedtest.test_vmess_link", fake_test)

    speedtest_links(
        ["vmess://a", "vmess://b", "vmess://c"],
        config,
        event_callback=lambda event_type, payload: events.append({"type": event_type, **payload}),
    )

    assert events[0]["type"] == "speedtest_runtime"
    assert events[0]["runtime_core"] == "mihomo"
    assert events[1]["type"] == "speedtest_selected"
    assert events[1]["candidate_count"] == 2
    assert [event["type"] for event in events[2:]] == [
        "speedtest_result",
        "speedtest_result",
    ]


def test_speedtest_node_migration_fixture_matches_python_golden() -> None:
    payload = json.loads((FIXTURE_DIR / "input.json").read_text(encoding="utf-8"))
    expected = json.loads((FIXTURE_DIR / "output.json").read_text(encoding="utf-8"))

    probes = [ProbeResult(**item) for item in payload["probes"]]
    full_results = {item["link"]: SpeedTestResult(**item) for item in payload["full_results"]}

    selected = select_speedtest_candidates(probes, payload["config"]["max_download_candidates"])
    results = [
        SpeedTestResult(
            link=probe.link,
            reachable=False,
            average_download_mb_s=0.0,
            latency_ms=probe.latency_ms,
            error=probe.error,
        )
        for probe in probes
        if not probe.reachable
    ]
    results.extend(full_results[link] for link in selected)

    assert aggregate_speed_measurements(payload["measurements"]) == expected["average_download_mb_s"]
    assert selected == expected["selected_links"]
    assert [result.__dict__ for result in results] == expected["results"]
