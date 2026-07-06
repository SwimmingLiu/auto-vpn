DO NOT send optional commentary

# Delivery Workflow

## Project scope convention

This repository is the default "current project" inside `/Users/swimmingliu/data/VPN` unless the user explicitly says otherwise.

`/Users/swimmingliu/data/VPN/cloudflarevpn` and `/Users/swimmingliu/data/VPN/vpn-catch-nodes` are reference materials for this project.

Do not treat those reference directories as the active implementation target unless the user explicitly asks to work in them.

If a task changes files in this repository, including coding, refactoring, configuration updates, documentation edits, or packaging-related changes, follow this default workflow:

1. Run unit tests, e2e tests, and pixel-level / visual regression tests.
   - Before Electron-specific verification, first test the `electron/renderer` UI as a plain browser-based H5 front end in Codex/Playwright, then do one manual test round on that browser-rendered UI.
   - Any UI/UX change must be verified with Playwright or Computer Use before the task is considered done.
   - After every UI/UX edit, or after any task change that affects behavior, immediately rerun Playwright or Computer Use end-to-end verification plus a pixel-level / visual check before continuing.
   - Any completed task that changes behavior should include end-to-end verification plus a pixel-level / visual check, not only code-level tests.
2. Open a GitHub PR.
3. Code review.
4. Apply review feedback and update the code.
5. If any file changes again after review, repeat the workflow:
   - rerun the browser-based H5 front-end test round first
   - rerun one manual browser test round
   - rerun unit tests
   - rerun e2e tests
   - rerun pixel-level / visual regression tests
   - re-run Playwright or Computer Use verification after each follow-up UI/UX change
   - do not stop after writing code; verification is required every time the UI/UX or task behavior changes
   - update the PR
6. Merge the PR only after the required tests pass and the review feedback is resolved.

After the PR is merged, package the application into a runnable binary/app or installable package.

For every version update, keep all user-visible Electron version text and metadata in sync with the released version.

- Update the Electron sidebar/about/version description and related renderer tests whenever package, npm, Python, or release tag versions change.
- Do not ship stale Electron version text such as `v.1.3.0` when the current release is `v1.5.1`.

For packaged app branding, follow these requirements every time:

- Never ship the default Electron icon or any placeholder/non-project icon asset.
- The packaged app icon/logo must come from a logo asset checked into this repository. Default to `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/assets/vpn-auto-logo-v2-minimal.svg` unless the user explicitly selects another in-repo logo asset.
- The source logo and any generated packaging icon assets must preserve a transparent background. Do not flatten the logo onto a white, black, or other opaque background.
- Packaging verification must explicitly confirm that the build no longer reports `default Electron icon is used` and that the packaged app contains the project-derived icon resource.
