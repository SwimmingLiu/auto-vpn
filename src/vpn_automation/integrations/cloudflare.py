from pathlib import Path


def build_pages_deploy_command(bundle_dir: Path, project_name: str) -> list[str]:
    return [
        "npx",
        "wrangler",
        "pages",
        "deploy",
        str(bundle_dir),
        "--project-name",
        project_name,
    ]
