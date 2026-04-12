import base64
import json

from vpn_automation.pipeline.models import CanonicalNodeKey


def parse_vmess_link(link: str) -> dict:
    encoded = link.removeprefix("vmess://")
    padded = encoded + "=" * (-len(encoded) % 4)
    return json.loads(base64.b64decode(padded).decode("utf-8"))


def canonical_key(payload: dict) -> CanonicalNodeKey:
    return CanonicalNodeKey(
        add=str(payload.get("add", "")),
        port=str(payload.get("port", "")),
        node_id=str(payload.get("id", "")),
        net=str(payload.get("net", "")),
        host=str(payload.get("host", "")),
        path=str(payload.get("path", "")),
        tls=str(payload.get("tls", "")),
        sni=str(payload.get("sni", "")),
    )
