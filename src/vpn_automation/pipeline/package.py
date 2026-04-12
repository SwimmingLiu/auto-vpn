from pathlib import Path


def build_pages_bundle(worker_js: str, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / "_worker.js"
    target.write_text(worker_js, encoding="utf-8")
    return output_dir
