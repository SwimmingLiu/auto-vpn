# v3 Node Custom Domain Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Cloudflare Pages custom-domain attach/detach and DNS CNAME upsert into the Node CLI deploy backend.

**Architecture:** Extend the existing Node `CloudflareDeployClient` with Pages domain and DNS mutation methods, then wire custom-domain binding into `deployPagesWithBackend()` at the same points as Python: during primary blocked-project fallback and after successful deploy. Keep all behavior inside the current deploy stage boundary.

**Tech Stack:** TypeScript, Cloudflare Pages REST API, Cloudflare DNS REST API, Wrangler CLI via existing command runner, `node:test`.

---

## File Map

- Modify `npm/autovpn-cli/src/pipeline/deploy.ts`
  - Add `listPagesDomains`, `attachCustomDomain`, `detachCustomDomain`, and `upsertSubdomainCname`.
  - Add `ensureCustomDomainBound`.
  - Wire custom-domain attach/DNS into Node deploy result fields.
- Modify `npm/autovpn-cli/test/pipeline/deploy.test.mjs`
  - Add Node deploy custom-domain success, fallback rebind, DNS failure, and HTTP client DNS upsert tests.
  - Remove the old custom-domain Python-only rejection test.
- Modify `README.md`, `npm/autovpn-cli/README.md`, and prior v3 plan notes to update the Node/Python boundary.

## Tasks

- [ ] Add failing deploy tests for custom-domain success, fallback rebind, and DNS failure.
- [ ] Add failing Cloudflare HTTP client tests for Pages domain attach/list and DNS CNAME upsert.
- [ ] Implement Node Cloudflare client methods.
- [ ] Implement `ensureCustomDomainBound` and deploy result wiring.
- [ ] Update docs to state custom-domain attach/DNS are Node-native.
- [ ] Run full validation: npm CLI, Electron tests, Python pytest, and npm pack dry-run.
- [ ] Commit, review, PR, merge, clean branches/worktrees, and package latest main.

## Completion Criteria

- Node deploy no longer rejects `custom_domain`.
- Custom-domain result fields match Python: `custom_domain`, `custom_domain_dns_name`, `custom_domain_dns_target`, `custom_domain_dns_proxied`, and `custom_domain_dns_ok`.
- DNS upsert errors append `custom domain dns binding failed: ...` and force `returncode: 1`.
- Primary fallback rebinds the custom domain from the blocked project to the fallback project before fallback deploy.
- Full validation and GitHub CI pass.
