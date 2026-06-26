import base64
import json
from pathlib import Path

from vpn_automation import cli


def _vmess_link(name: str, address: str = "1.2.3.4") -> str:
    payload = {
        "v": "2",
        "ps": name,
        "add": address,
        "port": "443",
        "id": "node-secret-id",
        "aid": "0",
        "net": "ws",
        "path": "/secret-path",
        "tls": "tls",
    }
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii").rstrip("=")
    return f"vmess://{encoded}"


def test_artifacts_preview_returns_safe_summary_without_node_contents(tmp_path: Path, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "20260626-153012"
    artifact_dir.mkdir(parents=True)
    (artifact_dir / "vpn_node_emoji.txt").write_text(
        f"{_vmess_link('US node secret')}\n{_vmess_link('JP node secret', '2.3.4.5')}\n",
        encoding="utf-8",
    )
    (artifact_dir / "vpn_node_raw.txt").write_text("vmess://raw-secret\n", encoding="utf-8")
    (artifact_dir / "_worker.js").write_text("worker bundle", encoding="utf-8")
    (artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "run_status": "success",
                "stage_status": {"deploy": "success", "verify": "success"},
                "counts": {"final_links": 2},
                "source_counts": {"leiting": {"raw_links": 10}},
                "deployment": {
                    "project_name": "sub-nodes",
                    "subscription_url": "https://sub.example/sub?token=SUB-SECRET",
                    "secret_query": "serect_key=SECRET",
                    "stdout": "deployed https://sub.example/sub?token=STDOUT-SECRET",
                    "stderr": "verify failed serect_key=STDERR-SECRET",
                },
                "retry_context": {"start_stage": "deploy"},
                "error": "failed https://verify.example/sub?token=ERROR-SECRET",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    code = cli.main(["artifacts", "preview", str(artifact_dir), "--project-root", str(project_root), "--json"])

    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    serialized = json.dumps(payload, ensure_ascii=False)
    assert code == 0
    assert payload["ok"] is True
    assert payload["artifact_dir"] == str(artifact_dir.resolve())
    assert payload["run_status"] == "success"
    assert payload["counts"]["final_links"] == 2
    assert payload["safe_node_counts"]["node_source"] == "vpn_node_emoji.txt"
    assert payload["safe_node_counts"]["final_node_count"] == 2
    assert payload["safe_node_counts"]["regions"] == [{"region_code": "JP", "count": 1}, {"region_code": "US", "count": 1}]
    assert any(item["name"] == "_worker.js" for item in payload["files"])
    assert "vmess://" not in serialized
    assert "SUB-SECRET" not in serialized
    assert "serect_key=SECRET" not in serialized
    assert "STDOUT-SECRET" not in serialized
    assert "STDERR-SECRET" not in serialized
    assert "ERROR-SECRET" not in serialized
    assert "node-secret-id" not in serialized


def test_artifacts_preview_missing_artifact_returns_ok_false(tmp_path: Path, capsys) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    artifact_dir = project_root / "artifacts" / "missing"

    code = cli.main(["artifacts", "preview", str(artifact_dir), "--project-root", str(project_root), "--json"])

    payload = json.loads(capsys.readouterr().out)
    assert code == 0
    assert payload == {"ok": False, "artifact_dir": str(artifact_dir.resolve())}
