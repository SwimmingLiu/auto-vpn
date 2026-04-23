---
applyTo: ".github/workflows/**/*.yml .github/**/*.md"
---

Review workflow and repository automation changes for:

- least-privilege permissions, especially around `contents`, `security-events`, and release scopes
- unsafe shell usage, unpinned or weakly trusted supply-chain steps, and artifact integrity gaps
- missing verification gates before packaging or deployment
- cache poisoning risk, secret leakage into logs, and accidental writes of runtime secrets into tracked files
- whether the PR body and repository instructions still give Copilot enough context to review the change intelligently

