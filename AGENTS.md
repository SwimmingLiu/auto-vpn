# Delivery Workflow

After code changes are complete, follow this default workflow:

1. Run unit tests, e2e tests, and pixel-level / visual regression tests.
2. Open a PR.
3. Request `@Copilot` review.
4. Apply review feedback.
5. If code changes again, rerun unit tests, e2e tests, and pixel-level / visual regression tests.
6. Repeat until the PR is ready, then merge it.

After merge, package the application into a runnable binary/app or installable package.
