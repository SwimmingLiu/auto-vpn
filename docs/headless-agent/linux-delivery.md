# Linux Delivery

This is the active delivery contract for the headless CLI and Linux Electron
packages. Node.js `>=22.5.0` is required.

## CI Gate

```bash
npm ci
npm ci --prefix npm/autovpn-cli
npm test --prefix npm/autovpn-cli
npm run test:electron
```

The headless workflow also packs the npm CLI, runs the packed tarball, validates
JSON output with Node.js, and builds Linux `.deb` and `.rpm` packages.

## Release Assets

A release contains:

- npm CLI tarball: `swimmingliu-autovpn-<version>.tgz`
- macOS `.dmg` for x64 and ARM64
- Linux `.deb` and `.rpm` for x64 and ARM64
- Windows installer and portable executable for x64 and ARM64

The root and npm package versions must match the release tag. Release jobs use
Node.js to read both manifests and validate generated JSON.

## Electron Package Boundary

Before `electron-builder` runs, packaging stages:

- the built AutoVPN CLI and production dependencies;
- Node runtime dependencies used by browser probes;
- the share worker template;
- the sanitized bundled profile;
- project-derived transparent icon assets.

Packaging removes stale legacy runtime vendor content before collecting app
inputs. The app input list contains Electron runtime files and templates only;
source trees and unrelated manifests are not shipped.

## Verification

Confirm the package log does not report the default Electron icon. Inspect the
unpacked application for the staged CLI entry, its production dependencies,
the share worker, and the project icon resource. Run the staged CLI with
`--version` and `profile show` before publishing.
