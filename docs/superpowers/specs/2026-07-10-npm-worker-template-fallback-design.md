# npm Worker Template Fallback Design

## Problem

The globally installed npm CLI resolves `projectRoot` to the server working directory. The render paths in run, retry, and resume then read `templates/vmess_node.js` only from that directory. The npm package does not include the template, so a clean global install fails with `ENOENT` even though earlier pipeline stages succeed.

## Decision

Ship the default Worker template inside `@swimmingliu/autovpn` and resolve it through one shared runtime helper. A project-local `templates/vmess_node.js` remains the first choice so source checkouts and intentional overrides retain their current behavior. When that file does not exist, the helper returns the template packaged beside the compiled npm distribution.

The render paths and doctor check will use the same helper. Missing-template errors will name both searched locations, making packaging regressions diagnosable without exposing profile data.

## Package Layout

The npm build copies the canonical root templates into `dist/templates/`, which is already part of the package `files` allowlist. Repository tests compare both packaged Worker templates byte-for-byte with their canonical sources so generated distribution assets cannot drift silently.

## Verification

Automated coverage will prove project override precedence, packaged fallback behavior, doctor acceptance of the fallback, and tarball inclusion. Existing npm, Electron, Python, end-to-end, and visual checks will run before delivery.

The server test will install a locally packed `.tgz`, not a registry release. It will retry from the failed render artifact and exercise render, obfuscate, deploy, and verify with the server's existing redacted profile. Only after the server run succeeds will the patch be submitted through PR review, merged, and released as `v1.6.6`.

## Operational Safety

The test will preserve the currently published npm version until the fix is proven. SSH output will exclude credentials, source URLs, subscription links, node links, and deployment tokens. The prior globally installed package can be restored from npm if the local tarball test fails.
