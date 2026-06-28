# AutoVPN Node-first Event Schema

Source files inspected:

- `src/vpn_automation/backend.py`
- `src/vpn_automation/pipeline/controller.py`
- `src/vpn_automation/pipeline/extract.py`
- `src/vpn_automation/pipeline/speedtest.py`
- `src/vpn_automation/pipeline/availability.py`
- `src/vpn_automation/backend_resume.py`
- `src/vpn_automation/jobs.py`
- `docs/superpowers/specs/2026-04-23-backend-cli-observability-design.md`
- `tests/pipeline/test_extract.py`
- `tests/backend/test_jobs_cli.py`

This document lists the current JSONL event types emitted by the Python backend and pipeline callbacks. The Node backend adapter must treat this as the minimum compatibility contract before Phase 4 starts.

Each event is a single JSON object per line with a required `type` string:

```json
{"type":"log","message":"[doctor] runtime environment loaded"}
```

## Backend Event Envelope

Events are serialized by `backend.build_event(event_type, payload)`:

```json
{"type":"<event_type>", "...payloadFields": "..."}
```

Human mode renders known events with `backend.render_human_event`; unknown events fall back to JSON string rendering.

## Event Types

| Event type | Source | Required/known fields | Notes |
| --- | --- | --- | --- |
| `run_started` | `pipeline/controller.py` through `backend.run_pipeline` | `artifact_dir`, `skip_deploy`, `skip_verify`, `resume_from` | First pipeline event for foreground and detached runs. Jobs use `artifact_dir` to reconcile state. |
| `log` | `backend.py`, pipeline log callbacks, Electron stderr conversion | `message` | Human diagnostics. Must be redacted before public output if it can contain secrets. |
| `stage` | `backend.py` stage callback | `stage`, `status` | Stage statuses include `pending`, `running`, `success`, `failed`, `skipped`. |
| `summary` | `backend._emit_summary` | `artifact_dir`, `stage_status`, `counts`, `source_counts`, `deployment`, `run_status`, `error` | Terminal event for success and failure paths. Deployment and error are redacted. |
| `run_failed` | `backend._run_with_streams` | `error` | Emitted after failed summary or exception. |
| `extract_source_started` | `pipeline/extract.py` | `source_name`, `requested_iterations`, `min_iterations`, `resume_from_iteration` | Emitted once per enabled source. |
| `extract_request_result` | `pipeline/extract.py` | `source_name`, `iteration`, `success`, `via`, `url`, optional `error`, optional `will_retry` | Direct/proxy fetch attempt result. URL may be sensitive and must be considered for redaction in public surfaces. |
| `extract_decrypt_result` | `pipeline/extract.py` | `source_name`, `iteration`, `success`, optional `error` | Decryption result for fetched source payload. |
| `extract_iteration` | `pipeline/extract.py` | `source_name`, `iteration`, `requested_iterations`, `new_items`, `extracted_links`, `total_links` | Per successful extract iteration. |
| `extract_source_completed` | `pipeline/extract.py` | `source_name`, `requested_iterations`, `successful_iterations`, `failed_iterations`, `raw_links` | Current completed event name. Do not use `extract_source_finished`. |
| `extract_source_failed` | `pipeline/controller.py` | `source_name`, `error` | Emitted when a source future raises. |
| `speedtest_runtime` | `pipeline/speedtest.py` | `runtime_core`, `probe_url`, `urls` | Announces runtime/probe configuration. |
| `speedtest_probe_result` | `pipeline/speedtest.py`, `backend_resume.py` | `completed`, `total`, `link`, `reachable`, `latency_ms`, `error` | Probe result. Link must be treated as sensitive. |
| `speedtest_selected` | `pipeline/speedtest.py`, `backend_resume.py` | `total_links`, `reachable_count`, `candidate_count` | Candidate selection summary. |
| `speedtest_result` | `pipeline/speedtest.py`, `backend_resume.py` | `completed`, `total`, `link`, `reachable`, `average_download_mb_s`, `latency_ms`, `passed_threshold`, `error` | Full download result. Link must be treated as sensitive. |
| `speedtest_resume_state` | `backend_resume.py` | `resumed_probe_count`, `resumed_full_count`, `total_links` | Resume-only event. |
| `resume_pipeline_state` | `backend_resume.py` | `speedtest_links`, `artifact_dir` | Resume-only transition from speedtest to downstream pipeline. |
| `availability_link_result` | `pipeline/availability.py` | `completed`, `total`, `link`, `all_passed`, `provider_results` | Link and provider details must be treated as sensitive public output. |

## Redaction Requirements

The event stream is consumed by both Agents and Electron. The current Python backend does not redact every low-level pipeline field before stdout; therefore Node migration must preserve compatibility while making redaction decisions explicit per surface:

- Agent JSONL stdout must remain valid JSONL.
- Electron renderer must continue to accept every event type.
- Public summaries must redact deployment fields and errors.
- Raw links, source URLs, probe URLs, and subscription URLs must not be copied into docs, issue comments, or release logs.
- Any future Node-native event formatter must be covered by fixture tests before replacing Python output.

## Fixture Expectations

The fixture directory `tests/fixtures/node-migration/` contains sample event lines for schema tests. It is intentionally small and deterministic; high-volume live output belongs in generated test artifacts, not committed fixtures.
