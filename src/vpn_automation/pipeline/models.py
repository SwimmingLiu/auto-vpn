from dataclasses import dataclass


@dataclass(frozen=True)
class CanonicalNodeKey:
    add: str
    port: str
    node_id: str
    net: str
    host: str
    path: str
    tls: str
    sni: str
