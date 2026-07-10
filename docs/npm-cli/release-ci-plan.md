# Release and CI Plan

> Historical migration record. Use `node-first-migration-sop.md` and the current
> workflow files for release operations.

## Decision

Treat the npm wrapper as a third release artifact family:

- Electron installers
- Python wheel/sdist
- npm wrapper tarball and npm registry package

The npm wrapper should be an independent package under `npm/autovpn-cli`, not the root Electron `package.json`.

## PR CI

Extend `.github/workflows/headless-cli.yml` or add a dedicated npm wrapper workflow.

Recommended jobs:

```yaml
npm-wrapper-unit:
  runs-on: ubuntu-24.04
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with:
        node-version: 24
        cache: npm
        cache-dependency-path: npm/autovpn-cli/package-lock.json
    - run: npm ci
      working-directory: npm/autovpn-cli
    - run: npm test
      working-directory: npm/autovpn-cli
    - run: npm pack --dry-run
      working-directory: npm/autovpn-cli
```

Wheel install smoke:

```bash
python -m pip install --upgrade pip build
python -m build
python -m venv /tmp/autovpn-wheel-smoke
/tmp/autovpn-wheel-smoke/bin/python -m pip install dist/*.whl
/tmp/autovpn-wheel-smoke/bin/autovpn --help
/tmp/autovpn-wheel-smoke/bin/autovpn --version
/tmp/autovpn-wheel-smoke/bin/autovpn doctor --output json
```

Cross-platform smoke matrix:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [ubuntu-24.04, macos-latest, windows-2025]
```

Smoke commands:

```bash
npm ci --prefix npm/autovpn-cli
npm pack --prefix npm/autovpn-cli
npm install -g ./npm/autovpn-cli/*.tgz
autovpn --help
autovpn --version
autovpn doctor --project-root "$PWD" --output json
```

## Version Sync

Add `scripts/check-version-sync.mjs` or equivalent.

It should compare:

```text
pyproject.toml [project].version
package.json version
npm/autovpn-cli/package.json version
Git tag v<version>, when running in release context
```

Release workflow should fail if any value drifts.

Example shell check:

```bash
PY_VERSION="$(python - <<'PY'
import tomllib
print(tomllib.load(open("pyproject.toml", "rb"))["project"]["version"])
PY
)"
ELECTRON_VERSION="$(node -p "require('./package.json').version")"
NPM_VERSION="$(node -p "require('./npm/autovpn-cli/package.json').version")"

test "$PY_VERSION" = "$ELECTRON_VERSION"
test "$PY_VERSION" = "$NPM_VERSION"
test "$RELEASE_TAG_NAME" = "v${PY_VERSION}"
```

## Release Workflow

Extend `.github/workflows/release-electron.yml` with a `package-npm-wrapper` job.

```yaml
package-npm-wrapper:
  name: Package npm wrapper
  needs: test
  runs-on: ubuntu-24.04
  permissions:
    contents: write
    id-token: write
  steps:
    - uses: actions/checkout@v4
      with:
        ref: ${{ env.RELEASE_TAG_NAME }}
        fetch-depth: 0
    - uses: actions/setup-node@v4
      with:
        node-version: 24
        registry-url: https://registry.npmjs.org
        cache: npm
        cache-dependency-path: npm/autovpn-cli/package-lock.json
    - run: npm ci
      working-directory: npm/autovpn-cli
    - run: npm test
      working-directory: npm/autovpn-cli
    - run: npm pack
      working-directory: npm/autovpn-cli
    - uses: softprops/action-gh-release@v2
      with:
        tag_name: ${{ env.RELEASE_TAG_NAME }}
        files: npm/autovpn-cli/*.tgz
    - name: Publish npm package when needed
      run: |
        VERSION="$(node -p "require('./package.json').version")"
        if npm view "@swimmingliu/autovpn@${VERSION}" version >/tmp/autovpn-npm-version.txt 2>/dev/null; then
          echo "npm package @swimmingliu/autovpn@${VERSION} already exists; verifying metadata."
          test "$(cat /tmp/autovpn-npm-version.txt)" = "${VERSION}"
          exit 0
        fi
        npm publish --provenance --access public
      working-directory: npm/autovpn-cli
      env:
        NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Update `publish-release-notes` dependencies:

```yaml
needs:
  - package-electron
  - package-cli
  - package-npm-wrapper
```

## Release Notes

Update `scripts/generate-release-notes.mjs` to include:

```markdown
### npm / npx

- npm package: `@swimmingliu/autovpn`
- One-time Agent use:
  `npx -y @swimmingliu/autovpn doctor --project-root <path> --output json`
- Global install:
  `npm install -g @swimmingliu/autovpn`
- GitHub Release tarball:
  `swimmingliu-autovpn-<version>.tgz`
```

## Registry Strategy

Recommended:

- Publish official releases to npm registry only after the repository license decision is complete.
- Upload npm `.tgz` to GitHub Release for auditability and offline installs.
- Never publish from PR workflows.
- Use `npm publish --provenance --access public` from tag/release workflows only.

If registry publishing is deferred:

- Still upload `.tgz` to GitHub Release.
- README must state that `npx @swimmingliu/autovpn` is not available until npm publishing is enabled.

## Failure Recovery

Cases:

- GitHub Release upload fails before npm publish: fix workflow and rerun.
- GitHub Release succeeds but npm publish fails: fix npm token/provenance/package metadata and rerun npm publish.
- npm publish succeeds but GitHub Release fails: do not unpublish; repair the GitHub Release and upload missing assets.
- npm publishes bad contents: publish a patch version and deprecate the broken version.

Deprecation command:

```bash
npm deprecate @swimmingliu/autovpn@1.3.0 "Broken release, use 1.3.1"
```

Duplicate publish guard:

```bash
npm view @swimmingliu/autovpn@"$VERSION" version
```

If the version already exists, skip publish and verify registry metadata instead.

## Supply Chain Rules

- Keep npm wrapper runtime dependencies at zero unless a concrete need appears.
- Commit `npm/autovpn-cli/package-lock.json`.
- Use `npm ci` in CI.
- Use `files` allowlist in `package.json`.
- Verify tarball contents with `npm pack --json` or `tar -tf` before upload or publish.
- Avoid `postinstall` scripts that download and execute code automatically.
- Prefer first-run explicit install into user cache.
- Use minimal GitHub Actions permissions:
  - PR CI: `contents: read`
  - release asset upload: `contents: write`
  - npm provenance: `id-token: write`
- Do not expose `NPM_TOKEN` to fork PRs.

## Local Release Dry Run

```bash
./scripts/run_pytest.sh tests -v
npm run test:electron
python -m build
python -m twine check dist/*
npm ci --prefix npm/autovpn-cli
npm test --prefix npm/autovpn-cli
npm pack --dry-run --prefix npm/autovpn-cli
npm publish --dry-run --provenance --access public --prefix npm/autovpn-cli
```
