# Task 8 Report: Per-Source Canonical Dedupe Counts

## RED evidence

Command:

`rtk npm run build && rtk node --test test/pipeline/run-store.test.mjs test/pipeline/orchestrator.test.mjs ../../electron/tests/ui-state.test.mjs`

Observed four expected failures before implementation:

- `RunStore.sourceDedupedCounts is not a function`.
- Normal pipeline result omitted `source_counts.fixture.deduped_links`.
- Resume result omitted persisted source ownership counts.
- Legacy renderer markup omitted unknown per-source dedupe data instead of showing `—`.

## Data-flow root cause

`raw_observations` persisted source identity, but `pipeline_nodes` persisted only the canonical key/link/sequence. Once duplicates collapsed, canonical ownership was lost. The orchestrator built `source_counts` from extraction results and never merged canonical counts from SQLite. Renderer normalization then converted a missing `deduped_links` property into numeric zero, destroying the distinction between historical unknown data and a real zero.

## Implementation

- Added nullable `pipeline_nodes.first_source` schema v3 migration.
- Backfilled historical ownership from the earliest canonical-matching raw observation where possible; malformed historical observations are skipped.
- Canonical insertion and raw observation now occur in the existing `BEGIN IMMEDIATE` transaction, so only the winning canonical insert records ownership and duplicate observations cannot replace it.
- Added SQLite-authoritative `sourceDedupedCounts()` and `sourceRawCounts()` queries.
- Retry seeding now preserves raw sources and canonical first-source ownership instead of rewriting everything as `retry-seed`.
- Normal, retry, speed-resume, and pipeline-resume summaries refresh source counts from SQLite; final reports therefore carry `deduped_links` consistently.
- Renderer normalization preserves absent legacy fields. The source metric view renders absence as `—` and preserves numeric zero as `0`.

## Tests and migration verification

Final focused command:

`rtk npm run build && rtk node --test test/pipeline/run-store.test.mjs test/pipeline/orchestrator.test.mjs ../../electron/tests/ui-state.test.mjs && rtk git diff --check`

Result: exit 0; build succeeded; 104 tests passed, 0 failed; diff check clean.

Coverage includes first-observer ownership `{ A: 2, B: 1 }`, equality with global canonical count after reopen, normal and resume returned/report summaries, historical minimal-schema migration to user version 3 with `first_source='legacy'`, retry persistence behavior through existing tests, and legacy renderer unknown display.

## Self-review and concerns

- `electron/renderer/views.js` required a small change beyond the brief's enumerated files because `app.js` can preserve missingness but the view is the layer that renders `—`.
- Focused automated renderer markup coverage passed. No pixel-level browser run was performed in this subtask; the parent delivery workflow still needs the repository-wide browser/manual/visual verification and PR review sequence.

## Commit

`fix: report per-source dedupe counts` (exact hash recorded in the task handoff).

## Review follow-up

The P1 failure path now drains active streaming workers, re-reads global and per-source raw/deduped counts from SQLite, and only then writes the failed report and emits the terminal `summary` / `run_failed` events. RED tests covered both a partially persisted streaming extraction (`raw=3`, canonical `2`) and a zero-link extraction with explicit numeric zero source counts.

The P2 v3 backfill now scans ordered raw observations once to build a `(run_id, canonical_key) -> earliest source` map, then performs one lookup per canonical node. It no longer reparses all raw observations for every node. A 200-node / 400-observation migration fixture verifies earliest ownership distribution, and legacy import was also changed to build canonical raw keys once.

Follow-up verification:

`rtk npm run build && rtk node --test test/pipeline/run-store.test.mjs test/pipeline/orchestrator.test.mjs ../../electron/tests/ui-state.test.mjs && rtk git diff --check`

Result: exit 0; 107 tests passed, 0 failed; build and diff check passed.
