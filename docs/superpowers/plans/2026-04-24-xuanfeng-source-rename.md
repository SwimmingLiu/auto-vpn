# Xuanfeng Source Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the confusing `xuanfeng1` / `xuanfeng2` source keys to `xuanfeng-area` / `xuanfeng-all-area` while preserving backward compatibility and making the area-randomization behavior explicit.

**Architecture:** Keep the change narrow. Canonical source names move to the new keys in config/runtime/UI, while config loading accepts old keys and maps them to the new canonical keys. Monitoring output and demo profile labels are updated to match the new names.

**Tech Stack:** Python 3.12, pytest, Electron renderer JavaScript, Bash monitor script

---

### Task 1: Lock down the rename and compatibility behavior in tests

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_monitor_script.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_create_default_profile_maps_legacy_xuanfeng_sources_to_new_names(...):
    ...
    assert "xuanfeng-area" in profile.sources
    assert "xuanfeng-all-area" in profile.sources
    assert profile.sources["xuanfeng-area"].use_random_area is True
    assert profile.sources["xuanfeng-all-area"].use_random_area is False
```

```python
assert "xuanfeng-area: iter 40/100000 ..." in result.stdout
assert "Latest increase: xuanfeng-area iter 40/100000 ..." in result.stdout
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_monitor_script.py -q`

Expected: FAIL because the code still exposes `xuanfeng1` / `xuanfeng2`.

### Task 2: Implement canonical names and backward-compatible config loading

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/src/vpn_automation/config/models.py`

- [ ] **Step 1: Add canonical source names and legacy alias mapping**

```python
DEFAULT_SOURCE_ORDER = [
    "leiting",
    "heidong",
    "mifeng",
    "xuanfeng-area",
    "xuanfeng-all-area",
]

LEGACY_SOURCE_ALIASES = {
    "xuanfeng-area": ("xuanfeng2",),
    "xuanfeng-all-area": ("xuanfeng1",),
}
```

- [ ] **Step 2: Load either canonical or legacy source keys**

```python
for name in DEFAULT_SOURCE_ORDER:
    candidate_names = (name, *LEGACY_SOURCE_ALIASES.get(name, ()))
    ...
    use_random_area=name == "xuanfeng-area"
```

- [ ] **Step 3: Preserve canonical names in saved profiles**

```python
return cls(
    sources={name: SourceConfig(**value) for name, value in normalized_sources.items()},
    ...
)
```

- [ ] **Step 4: Re-run the targeted tests**

Run: `pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_monitor_script.py -q`

Expected: config tests pass; monitor test may still fail until names are updated in script output.

### Task 3: Update monitor output and renderer demo data to use the new names

**Files:**
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/scripts/monitor_run.sh`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/app.js`
- Modify: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/electron/renderer/views.js`

- [ ] **Step 1: Rename monitor source order**

```python
source_order = ["leiting", "heidong", "mifeng", "xuanfeng-area", "xuanfeng-all-area"]
```

- [ ] **Step 2: Rename renderer demo/fallback profile keys**

```javascript
xuanfeng-area: {
  ...
},
xuanfeng-all-area: {
  ...
}
```

- [ ] **Step 3: Re-run the targeted tests**

Run: `pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_runtime_paths.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/backend/test_monitor_script.py -q`

Expected: PASS

### Task 4: Run broader regression for touched areas

**Files:**
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_store.py`
- Test: `/Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_extract.py`

- [ ] **Step 1: Run nearby regression tests**

Run: `pytest /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/config/test_store.py /Users/swimmingliu/data/VPN/vpn-subscription-automation/tests/pipeline/test_extract.py -q`

Expected: PASS

- [ ] **Step 2: Summarize any remaining follow-up**

```text
- Existing external config file /Users/swimmingliu/data/VPN/vpn-catch-nodes/config/vpn_api.json still uses legacy keys.
- Runtime remains backward compatible, so migration can happen separately if desired.
```
