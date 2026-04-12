import base64
import json

from vpn_automation.pipeline.models import CanonicalNodeKey


def _pad_base64(encoded: str) -> str:
    return encoded + "=" * (-len(encoded) % 4)


def parse_vmess_link(link: str) -> dict:
    encoded = _pad_base64(link.removeprefix("vmess://"))
    return json.loads(base64.urlsafe_b64decode(encoded).decode("utf-8"))


def generate_vmess_link(payload: dict) -> str:
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("utf-8")
    return f"vmess://{encoded}"


def transform_node_id(original: str) -> str:
    parts = original.split("-")
    swapped_parts: list[str] = []
    for part in parts:
        chunks = [part[index : index + 4] for index in range(0, len(part), 4)]
        swapped_parts.append("".join(chunk[2:] + chunk[:2] for chunk in chunks if chunk))
    return "-".join(swapped_parts)


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
