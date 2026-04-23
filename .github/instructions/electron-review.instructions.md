---
applyTo: "electron/**/* package.json"
---

Review Electron changes for:

- preload and IPC boundary safety; do not expose more renderer surface than needed
- locale persistence, default language behavior, and renderer state consistency
- run / stop button state transitions, progress rendering, and stale event listeners
- visual regressions that would break the mockup-driven workspace or existing screenshot hashes
- packaging changes that could break the packaged app's ability to find the backend or profile

