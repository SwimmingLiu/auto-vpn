from pathlib import Path
import zipfile

import pytest

from scripts.ci.install_xray import (
    extract_expected_sha256,
    safe_extract_zip,
    validate_version,
)


def test_validate_version_accepts_semver_tags() -> None:
    assert validate_version("v1.2.3") == "v1.2.3"


def test_validate_version_rejects_untrusted_input() -> None:
    with pytest.raises(ValueError, match="Invalid xray version"):
        validate_version('v1.2.3"\nrm -rf /')


def test_extract_expected_sha256_reads_release_digest() -> None:
    digest_text = "SHA256 (Xray-linux-64.zip) = " + ("a" * 64)
    assert extract_expected_sha256(digest_text, "Xray-linux-64.zip") == "a" * 64


def test_safe_extract_zip_rejects_path_escape(tmp_path: Path) -> None:
    archive_path = tmp_path / "xray.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("../escape.txt", "nope")

    with pytest.raises(ValueError, match="Unsafe path"):
        safe_extract_zip(archive_path, tmp_path / "extract")
