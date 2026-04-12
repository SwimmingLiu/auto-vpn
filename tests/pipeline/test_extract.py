from pathlib import Path

from vpn_automation.config.models import SourceConfig
from vpn_automation.pipeline.extract import (
    build_runtime_source_url,
    build_source_script_path,
    extract_links_from_plaintext,
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
