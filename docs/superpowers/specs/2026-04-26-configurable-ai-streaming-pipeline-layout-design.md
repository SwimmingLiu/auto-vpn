# Configurable AI Availability, Streaming Pipeline, Artifact Retention, and Layout Design

## Outcome

Add configurable AI availability targets, make the heavy backend stages overlap as a streaming pipeline, merge dedupe into extraction with a run-local database uniqueness constraint, keep only the latest artifact by default, and tighten the Electron window layout so the macOS traffic-light controls have a dedicated titlebar row.

## Requirements

- The availability check must default to `gemini`, `chatgpt`, and `claude`.
- Every availability target must be user editable. Users can enable, disable, modify, delete, and add targets such as `tmailor`.
- Backend profile loading and saving must persist the target list in TOML.
- Pipeline mode must stream nodes from `extract` into `speedtest`, then into `availability`, instead of waiting for all extraction to finish before starting later heavy stages.
- Dedupe must happen during extract by using the run database. A canonical vmess key is unique per run; duplicates from the same run are discarded before entering speedtest.
- Artifact retention defaults to one latest run result. A new run may keep its own artifact directory and remove older sibling run directories.
- The client should show the latest existing artifact result on startup; if no result exists, it keeps the current initialized empty/demo values.
- Electron must open at an appropriate non-fullscreen desktop size and must not maximize by default.
- The macOS window controls must not overlap page content. The UI should reserve a top titlebar/safe-area row.
- The large blank bottom area in the subscriptions page should be removed by shrinking content to the available window and leaving only normal margin.
- The repository workflow must use local review instead of `@Copilot` review.

## Architecture

### Profile and availability target model

Introduce an `AvailabilityTargetConfig` dataclass in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`. `AppProfile` gains an `availability_targets` mapping. `create_default_profile()` populates editable defaults for `gemini`, `chatgpt`, and `claude`. `ProfileStore` renders and loads `[availability_targets.<name>]` TOML tables.

The existing `ProviderTarget` runtime object remains in `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/pipeline/availability.py`, but it is constructed from profile config. Availability checks accept an optional target list. If none is supplied, the module uses default targets for backwards compatibility with current tests and call sites.

### Streaming pipeline

Keep the current controller entrypoint and summary format. Replace the serial `extract -> dedupe -> speedtest -> availability` block with a streaming implementation inside `PipelineController.run()`:

1. Start speedtest worker threads and availability worker threads.
2. Run existing source extractors in parallel.
3. Each raw link callback writes to `RunStore.record_raw_link()` with a canonical vmess key.
4. Only newly inserted links are submitted to speedtest.
5. Speedtest results are persisted as they finish; passing results are submitted to availability.
6. Availability results are persisted as they finish; fully passing nodes become postprocess input.

The `dedupe` stage remains in the stage list for compatibility and UI continuity. In streaming mode it is marked `success` immediately after starting extract and logs that dedupe is handled by the extract DB index.

### Run database uniqueness

Extend `raw_links` with a `canonical_key` column and create `UNIQUE(canonical_key)`. For older DBs, initialization adds the column when missing. `record_raw_link()` returns `True` when the link is new for this run and `False` when a duplicate was ignored. It derives the canonical key with `canonical_key(parse_vmess_link(link))` and falls back to the link string if parsing fails.

### Artifact retention and latest preview

Add retention helpers in `PipelineController` to prune old artifact run directories after creating a new artifact directory. Default retention is one latest directory. Do not prune on resume.

Add a backend `artifact-latest` command returning the latest artifact preview metadata, and expose it through Electron IPC. The renderer calls this once after profile load and hydrates `artifactDir`, counts, and preview rows when a latest artifact exists.

### Electron layout

Switch `buildWindowOptions()` to calculate a non-fullscreen default size from the primary display work area. Use approximately 86% of width and 88% of height capped to a comfortable desktop size, with minimum size unchanged. Keep `center: true` and do not call maximize.

Change the titlebar strategy from `hiddenInset` overlap to a dedicated draggable `.window-titlebar` row above the app content. The main shell uses `grid-template-rows: 38px minmax(0, 1fr)` so content starts below the macOS controls. Page content height is content-aware, with normal bottom padding instead of a large empty region.

## Testing

- Python unit tests:
  - profile store roundtrip for `availability_targets`
  - availability target selection and custom target checks
  - run store canonical dedupe
  - controller streaming overlap
  - artifact cleanup/latest artifact lookup
- Electron unit tests:
  - settings view renders AI target editor
  - settings draft supports target add/delete/edit
  - window config produces fit-to-display non-fullscreen dimensions
  - latest artifact IPC preview helper
- E2E/visual:
  - run H5 renderer with Playwright first
  - run Electron renderer e2e and visual hash tests
  - update visual baselines after verified layout changes

## Workflow

`/Users/swimmingliu/data/VPN/AGENTS.md` and repository-local `/Users/swimmingliu/data/VPN/vpn-subscription-automation/AGENTS.md` now require local review instead of `@Copilot` review. The final workflow is tests, local review, PR, merge, then package.
