import json
from pathlib import Path

from vpn_automation.config.models import WorkerBuildConfig
from vpn_automation.pipeline.worker_build import WorkerBuildArtifacts


def build_pages_bundle(
    worker_js: str,
    output_dir: Path,
    build_artifacts: WorkerBuildArtifacts | None = None,
    config: WorkerBuildConfig | None = None,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "_worker.js"
    target.write_text(worker_js, encoding="utf-8")
    if build_artifacts and config and config.emit_sidecar_modules:
        for relative_path, content in build_artifacts.modules.items():
            module_path = output_dir / relative_path
            module_path.parent.mkdir(parents=True, exist_ok=True)
            module_path.write_text(content, encoding="utf-8")
        manifest_path = output_dir / config.manifest_filename
        manifest_path.write_text(
            json.dumps(build_artifacts.manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    return output_dir
