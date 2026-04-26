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
3. Run a local code review before merging.
   - Prefer `superpowers:requesting-code-review` when available.
   - If a dedicated reviewer subagent is unavailable, perform a local review against the implementation plan and current diff, then record the review result in the task summary.
4. Apply review feedback and update the code.
5. If any file changes again after review, repeat the workflow:
   - rerun the browser-based H5 front-end test round first
   - rerun one manual browser test round
   - rerun unit tests
   - rerun e2e tests
   - rerun pixel-level / visual regression tests
   - re-run Playwright or Computer Use verification after each follow-up UI/UX change
   - do not stop after writing code; verification is required every time the UI/UX or task behavior changes
   - update the PR and rerun local review when needed
6. Merge the PR only after the required tests pass and the review feedback is resolved.

After the PR is merged, package the application into a runnable binary/app or installable package.
