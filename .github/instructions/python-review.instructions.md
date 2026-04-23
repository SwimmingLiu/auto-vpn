---
applyTo: "src/vpn_automation/**/*.py tests/**/*.py pyproject.toml"
---

Review Python changes for:

- runtime profile loading, path resolution, and repo-anchor behavior
- missing validation around empty source data, timeouts, retries, and partial failure handling
- unsafe subprocess execution, missing stdout / stderr checks, and weak error propagation
- secret handling around Cloudflare tokens and deployment configuration
- regressions in the pipeline stage order, stage status reporting, and artifact generation
- tests that miss failure-path coverage or only assert happy paths

