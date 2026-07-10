# AutoVPN JSONL Event Schema

Pipeline commands write one JSON object per line when `--output jsonl` is used.

## Common Fields

Every event has a string `type`. Events may also include `stage`,
`artifact_dir`, counters, timings, a redacted `message`, or a redacted `error`.

## Lifecycle Events

- `run_started`: a new or resumed run has an artifact directory.
- `stage_started`: a pipeline stage began.
- `stage_completed`: a pipeline stage completed.
- `stage_failed`: a pipeline stage failed and includes a redacted error.
- `summary`: terminal run status and aggregate counts.

## Extraction And Measurement

- `extract_source_started`
- `extract_request_result`
- `extract_decrypt_result`
- `extract_iteration`
- `extract_source_completed`
- `extract_source_failed`
- `speedtest_runtime`
- `speedtest_probe_result`
- `speedtest_selected`
- `speedtest_result`
- `speedtest_completed`
- `availability_result`

## Resume And Retry

- `resume_pipeline_state`
- `resume_speedtest_state`
- `retry_stage_started`

Consumers must ignore unknown fields and new event types. They must not assume
all progress events arrive when a process is interrupted. The terminal summary
or durable artifact report is authoritative for completion.
