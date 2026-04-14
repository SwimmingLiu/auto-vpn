from vpn_automation.pipeline.speedtest import aggregate_speed_measurements, build_xray_runtime_config


def test_build_xray_runtime_config_uses_http_inbound_and_vmess_outbound() -> None:
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

    config = build_xray_runtime_config(payload, http_port=18080, socks_port=18081)

    assert config["inbounds"][0]["protocol"] == "http"
    assert config["outbounds"][0]["protocol"] == "vmess"
    assert config["outbounds"][0]["streamSettings"]["wsSettings"]["path"] == "/footers"


def test_aggregate_speed_measurements_uses_average_of_successful_sources() -> None:
    value = aggregate_speed_measurements([1.2, 2.4, 3.0])
    assert value == 2.2
