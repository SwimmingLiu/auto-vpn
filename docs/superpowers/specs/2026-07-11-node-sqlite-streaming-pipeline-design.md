# Node SQLite Streaming Pipeline Design

## Context and root cause

The Node pipeline already runs source extractors concurrently and overlaps successful full-download speed tests with availability checks. It does not, however, start speed testing while extraction is still running. The orchestrator accumulates links from all extract callbacks, waits for `Promise.all()` across every source, performs a global latency probe and ranking pass, and only then starts bounded full-download tests. This global `max_download_candidates` selection is the direct reason the `extract -> speedtest` boundary cannot stream: the best candidates are unknowable until extraction ends.

The current artifact files are also poor coordination state for a streaming pipeline. Multiple workers must update partial results, canonical dedupe must be atomic across concurrent sources, and an interrupted run must distinguish queued, running, passed, and failed nodes. Rewriting whole text and JSON files after each result serializes I/O in application code and makes crash recovery ambiguous.

## Goals

- Submit each newly extracted node to canonical dedupe immediately.
- Submit every unique node to speed probing and full-download testing without waiting for extraction to finish.
- Submit every speed-qualified node to availability checking immediately.
- Keep extraction, speed testing, and availability worker pools active at the same time.
- Persist every node transition durably in a run-local SQLite database.
- Preserve existing user-visible stage names, events, summary fields, artifact filenames, retry commands, and resume commands.
- Keep bounded concurrency and deterministic exported artifact ordering.

## Non-goals

- Streaming `postprocess`, `render`, `obfuscate`, `deploy`, or `verify`. These stages consume the final set and remain serial.
- A shared database across runs or machines.
- A background database service or a new native npm dependency.
- Preserving global latency ranking or `max_download_candidates` as an admission limit. Those semantics conflict with immediate processing and are removed from pipeline selection.

## Options considered

### Recommended: run-local SQLite plus bounded worker pools

Use Node's built-in `node:sqlite` `DatabaseSync`, one `run.db` per artifact directory, and explicit speed and availability pools. Extraction callbacks atomically insert canonical nodes; successful inserts are submitted immediately. SQLite is the source of truth and legacy artifacts are projections.

This meets the streaming and recovery requirements without an external dependency. Synchronous statements are short local operations and are acceptable at the expected node volume. WAL mode and prepared statements keep writes predictable.

### In-memory queues plus periodic SQLite snapshots

This reduces the number of synchronous writes, but a crash can lose accepted nodes and completed work between snapshots. Resume semantics become timing-dependent, which is not acceptable for a long-running network pipeline.

### In-memory streaming with existing text and JSON artifacts

This is the smallest code change, but canonical dedupe is not atomic across sources, whole-file rewrites grow with every result, and reliable resume still requires reconstructing uncertain state. It does not solve the persistence problem.

## Architecture

Introduce two focused modules:

- `pipeline/run-store.ts`: owns the SQLite schema, prepared statements, transactions, node state transitions, stage checkpoints, summary queries, and compatibility export queries.
- `pipeline/streaming-coordinator.ts`: owns bounded speed and availability worker pools, task lifetimes, backpressure, completion draining, and failure propagation. It knows pipeline callbacks but not SQLite details beyond the `RunStore` interface.

The existing orchestrator remains responsible for profiles, events, stage status, downstream serial stages, retry/resume entrypoints, and final artifacts. Its extraction section creates both modules and wires source callbacks into the coordinator.

The implementation uses the built-in `node:sqlite` API already required by the project, so no package dependency or native build step is added.

## SQLite model

Each artifact directory contains `run.db`. Initialization enables WAL mode, foreign keys, and a finite busy timeout.

### `run_metadata`

- `key TEXT PRIMARY KEY`
- `value_json TEXT NOT NULL`

Stores schema version, run status, timestamps, profile snapshot metadata, and retry context.

### `stage_status`

- `stage TEXT PRIMARY KEY`
- `status TEXT NOT NULL`
- `started_at TEXT`
- `finished_at TEXT`
- `error TEXT NOT NULL DEFAULT ''`

### `source_progress`

- `source_name TEXT PRIMARY KEY`
- extraction counters and last error

### `pipeline_nodes`

- `id INTEGER PRIMARY KEY`
- `sequence INTEGER NOT NULL UNIQUE`
- `canonical_key TEXT NOT NULL UNIQUE`
- `link TEXT NOT NULL`
- `source_name TEXT NOT NULL`
- `state TEXT NOT NULL`
- probe, speed, availability, and error columns
- JSON columns for provider results where the shape is dynamic
- created and updated timestamps

`sequence` is allocated in the same insert transaction and defines deterministic artifact ordering. A duplicate canonical key returns the existing row without re-enqueueing it. States progress monotonically through `deduped`, `speed_running`, `speed_failed` or `speed_passed`, then `availability_running`, `availability_failed` or `availability_passed`.

All dynamic JSON is parsed and validated at the RunStore boundary. Secrets are not stored beyond the existing node links already present in compatibility artifacts, and errors pass through existing redaction before persistence.

## Streaming data flow

1. The orchestrator initializes `run.db`, marks `extract`, `dedupe`, `speedtest`, and `availability` running, and starts bounded worker pools before source extraction.
2. Source extractors continue to run concurrently.
3. Every extractor `onLinks` callback processes links individually. `RunStore.recordExtractedNode()` computes the canonical vmess key and atomically inserts it.
4. Duplicate inserts update optional source observations only and stop. A new row is submitted to the speed pool immediately.
5. A speed worker performs the per-node reachability probe. Reachable nodes proceed directly to the full-download test. The former global ranking and `max_download_candidates` selection are not used.
6. A node meeting `min_download_mb_s` is persisted as `speed_passed` and submitted immediately to the availability pool. Other results are persisted as terminal speed failures.
7. An availability worker checks all configured providers for that node and persists the result.
8. After every source finishes, the orchestrator marks extraction complete and closes speed input. It drains the speed pool, closes availability input, and drains availability.
9. SQLite queries produce ordered raw, deduped, speed, and availability artifacts. The orchestrator then runs `postprocess -> render -> obfuscate -> deploy -> verify` serially.

The pools use bounded pending capacity. When the speed queue is full, the extraction callback awaits capacity, providing backpressure instead of accumulating an unbounded number of promises. Availability uses the same rule. Concurrency comes from `speed_test.concurrency`; pending capacity defaults to twice that value and remains an internal implementation detail unless evidence shows a user setting is needed.

## Stage and event semantics

The four streaming stages may all display `running` concurrently. Their success transitions remain dependency-aware:

- `extract`: success after all sources finish.
- `dedupe`: success after extraction finishes and all inserts are committed.
- `speedtest`: success after the speed input is closed and every accepted unique node reaches a terminal speed state.
- `availability`: success after the availability input is closed and every speed-qualified node reaches a terminal availability state.

Existing per-node progress events remain. Totals are allowed to increase while extraction is active, so event consumers must treat `total` as the current discovered total rather than a final fixed denominator. Existing stage and summary event names remain unchanged.

## Failure, cancellation, and resume

- A source failure follows existing aggregate extraction rules; nodes already emitted remain durable and continue through downstream pools while other sources run.
- A worker error is recorded on the node. Expected network failures are terminal node results, not pipeline crashes.
- Infrastructure or invariant failures stop queue admission, drain or cancel workers safely, mark active stages failed, persist a redacted run error, and reject the run.
- Stop requests prevent new admission, allow in-flight statements to finish, persist `stopped`, and leave queued/running states resumable.
- Resume resets interrupted `speed_running` and `availability_running` rows to queued states, then schedules only incomplete work from SQLite.
- Retry-stage continues to create a new artifact directory, seeds its `run.db` from the source run database or compatibility artifacts, and executes from the requested boundary.
- Legacy artifact directories without `run.db` remain readable. Resume or retry imports their text/JSON files into a newly initialized database before continuing.

## Compatibility artifacts

The following files remain generated with their current names and shapes:

- `vpn_node_raw.txt`
- `vpn_node_deduped.txt`
- `vpn_node_speedtest.txt`
- `vpn_node_speedtest_report.json`
- `vpn_node_availability.txt`
- `vpn_node_availability_report.json`
- `pipeline_report.json`

During a live run, SQLite is authoritative. Compatibility files are refreshed at bounded checkpoints and always regenerated from SQLite at stage completion and run termination. Readers prefer `run.db` and fall back to existing files for older runs.

## Testing and delivery

TDD coverage must prove:

- canonical duplicates arriving concurrently from different sources produce one row and one speed task;
- the first extracted node begins speed work before its extractor and other sources finish;
- the first speed-qualified node begins availability before extraction and remaining speed work finish;
- concurrency and pending capacity remain bounded;
- exported artifacts have stable discovery order and existing shapes;
- failure, stop, resume, retry-stage, and legacy import preserve completed work;
- stage events truthfully overlap and finish in dependency order;
- no global candidate-ranking wait remains in pipeline mode.

After focused Node tests, run the repository's complete unit suite. Because behavior and Electron progress presentation change, also run the H5 renderer in a browser first, perform a manual browser test, then run Electron E2E and pixel-level visual verification. Open a PR, review it, apply feedback with complete re-verification after any behavioral change, merge only when checks pass, and package the merged application. Packaging must verify the project-derived transparent icon and absence of the default Electron icon warning.

