import json
from pathlib import Path

import pytest

from vpn_automation.backend_resume import retry_pipeline_from_stage
from vpn_automation.pipeline.run_store import RunStore


def test_retry_pipeline_marks_stage_failed_in_report_when_retry_stage_raises(
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_root = tmp_path / "vpn-subscription-automation"
    source_artifact_dir = project_root / "artifacts" / "20260427-081718"
    retry_artifact_dir = project_root / "artifacts" / "20260427-090000"
    template_dir = project_root / "templates"

    source_artifact_dir.mkdir(parents=True)
    retry_artifact_dir.mkdir(parents=True)
    template_dir.mkdir(parents=True)
    (project_root / "pyproject.toml").write_text("[project]\nname='test'\nversion='0.0.0'\n", encoding="utf-8")
    (template_dir / "vmess_node.js").write_text("const MainData = `__MAIN_DATA__`;", encoding="utf-8")
    (source_artifact_dir / "vpn_node_emoji.txt").write_text("demo-link\n", encoding="utf-8")
    (source_artifact_dir / "pipeline_report.json").write_text(
        json.dumps(
            {
                "artifact_dir": str(source_artifact_dir),
                "run_status": "failed",
                "stage_status": {
                    "doctor": "success",
                    "extract": "success",
                    "dedupe": "success",
                    "speedtest": "success",
                    "availability": "success",
                    "postprocess": "success",
                    "render": "failed",
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    RunStore(source_artifact_dir / "run.db").initialize(artifact_dir=str(source_artifact_dir))

    monkeypatch.setattr(
        "vpn_automation.backend_resume._create_retry_artifact_dir",
        lambda project_root: retry_artifact_dir,
    )
    monkeypatch.setattr(
        "vpn_automation.pipeline.controller.replace_main_data",
        lambda template, links: (_ for _ in ()).throw(RuntimeError("render boom")),
    )

    with pytest.raises(RuntimeError, match="render boom"):
        retry_pipeline_from_stage(
            source_artifact_dir,
            stage_name="render",
            project_root=project_root,
        )

    report = json.loads((retry_artifact_dir / "pipeline_report.json").read_text(encoding="utf-8"))

    assert report["stage_status"]["render"] == "failed"
    assert report["run_status"] == "failed"
    assert report["error"] == "RuntimeError: render boom"
