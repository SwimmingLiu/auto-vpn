# Node Runtime Release SOP

This document is the active release procedure after the runtime migration.
Earlier phase documents under `docs/superpowers/` are historical records.

## Runtime Boundary

1. Require Node.js `>=22.5.0` in user and operator documentation.
2. Keep application code under `npm/autovpn-cli` and Electron integration code.
3. Keep root and npm package versions synchronized.
4. Do not add alternate backend selectors or external language runtime tooling.

## Test Gate

```bash
npm ci
npm ci --prefix npm/autovpn-cli
npm test --prefix npm/autovpn-cli
npm run test:electron
```

The Node-only boundary test scans active runtime code, workflows, manifests,
scripts, and this active documentation set. Compatibility fixture prose and
historical design records are outside that scan.

## Package Gate

1. Build the npm CLI.
2. Pack and smoke the generated `.tgz`.
3. Stage the built CLI and production dependencies for Electron.
4. Remove stale legacy vendor content from the Electron runtime tree.
5. Build platform Electron installers with project-derived icons.
6. Inspect app contents and execute the staged CLI.

## Release Gate

The release workflow validates the tag against root and npm manifests, runs the
npm CLI tests, publishes the npm package, uploads the npm tarball and Electron
platform assets, and updates GitHub Release notes. The Electron gates are not
repeated there: they run on the pull request that produced the tagged commit.

The final release job dispatches the release tag and commit to
`auto-vpn-runner`, which opens a pull request that moves its pinned
`PIPELINE_REF` to that commit. The runner never follows a release
automatically: review and merge the pin PR, then run the scheduled workflow by
hand once before the nightly schedule uses it. The dispatch needs
`AUTOVPN_RUNNER_TOKEN`, a fine-grained token scoped to `auto-vpn-runner` with
`Contents: read/write`, `Pull requests: read/write` and `Workflows: read/write`.
`Workflows` is required because the pin lives in a workflow file, which the
runner's own `GITHUB_TOKEN` cannot update.

After any behavior or packaging change, rerun the affected test and package
checks before updating the release.
