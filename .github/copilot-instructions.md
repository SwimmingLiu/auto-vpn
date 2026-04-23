# VPN Subscription Automation review context

This repository contains a Python backend and Electron desktop frontend for VPN subscription automation. The product captures source links, deduplicates and filters them, checks provider availability, renders deployment assets, and can deploy the final output to Cloudflare Pages.

When reviewing changes in this repository:

- align the implementation with the PR body sections `Goal`, `Feature / requirement mapping`, `Security / risk review`, `Edge cases checked`, and `Verification evidence`
- check for security issues in workflow permissions, secrets handling, subprocess execution, network trust, IPC exposure, and deployment steps
- check for edge cases in locale handling, missing runtime profiles, empty extraction results, interrupted runs, flaky tests, timeout handling, and packaging failures
- expect behavior-changing changes to include test evidence, especially Python tests plus Electron e2e / visual coverage when frontend behavior is touched
- prefer findings that are concrete, reproducible, and tied to user-visible impact, deployment safety, or regression risk

