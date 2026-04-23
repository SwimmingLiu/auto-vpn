from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import urllib.request
import zipfile
from pathlib import Path


VERSION_PATTERN = re.compile(r"^v\d+\.\d+\.\d+$")
SHA_PATTERN = re.compile(r"\b([0-9a-fA-F]{64})\b")


def validate_version(tag: str) -> str:
    if not VERSION_PATTERN.fullmatch(tag):
        raise ValueError("Invalid xray version. Expected format: vMAJOR.MINOR.PATCH")
    return tag


def extract_expected_sha256(digest_text: str, archive_name: str) -> str:
    for line in digest_text.splitlines():
        if archive_name not in line:
            continue
        match = SHA_PATTERN.search(line)
        if match:
            return match.group(1).lower()
    raise ValueError(f"Unable to find SHA-256 digest for {archive_name}")


def verify_sha256(archive_path: Path, expected_sha256: str) -> None:
    actual = hashlib.sha256(archive_path.read_bytes()).hexdigest().lower()
    if actual != expected_sha256.lower():
        raise ValueError(f"Checksum verification failed for {archive_path.name}")


def safe_extract_zip(archive_path: Path, extract_root: Path) -> None:
    extract_root.mkdir(parents=True, exist_ok=True)
    root_resolved = extract_root.resolve()
    with zipfile.ZipFile(archive_path) as archive:
        for member in archive.infolist():
            target = (extract_root / member.filename).resolve()
            if target != root_resolved and root_resolved not in target.parents:
                raise ValueError(f"Unsafe path in archive: {member.filename}")
        archive.extractall(extract_root)


def install_binary(binary_path: Path, install_dir: Path) -> Path:
    install_dir.mkdir(parents=True, exist_ok=True)
    target = install_dir / binary_path.name
    shutil.copy2(binary_path, target)
    target.chmod(0o755)
    return target


def build_release_url(version: str, file_name: str) -> str:
    return f"https://github.com/XTLS/Xray-core/releases/download/{version}/{file_name}"


def download_file(url: str, destination: Path) -> None:
    with urllib.request.urlopen(url) as response, destination.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def install_xray(version: str, archive_path: Path, digest_path: Path, extract_root: Path, install_dir: Path) -> Path:
    validate_version(version)
    archive_name = archive_path.name
    expected_sha256 = extract_expected_sha256(digest_path.read_text(encoding="utf-8"), archive_name)
    verify_sha256(archive_path, expected_sha256)
    safe_extract_zip(archive_path, extract_root)
    return install_binary(extract_root / "xray", install_dir)


def main() -> int:
    parser = argparse.ArgumentParser(description="Safely install xray from a GitHub release asset.")
    parser.add_argument("--version", required=True)
    parser.add_argument("--archive-path", required=True)
    parser.add_argument("--digest-path", required=True)
    parser.add_argument("--extract-root", required=True)
    parser.add_argument("--install-dir", required=True)
    args = parser.parse_args()

    install_path = install_xray(
        version=args.version,
        archive_path=Path(args.archive_path),
        digest_path=Path(args.digest_path),
        extract_root=Path(args.extract_root),
        install_dir=Path(args.install_dir),
    )
    print(str(install_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
