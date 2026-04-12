from dataclasses import dataclass


@dataclass
class SpeedTestResult:
    link: str
    reachable: bool
    average_download_mb_s: float
    latency_ms: int
