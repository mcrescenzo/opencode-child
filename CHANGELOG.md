# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-07-22

### Fixed

- **Concurrency (high):** Plugin disposal now waits a bounded time for child
  process exit-handler completion before clearing notification-manager state,
  preventing a late `handleProcExit` from reading already-cleared
  watches/owners/pending notifications (`am1`).
- **Concurrency (high):** Pending lifecycle-queue entries survive plugin disposal;
  `withChildLifecycle` remains the sole queue-entry owner, so new operations for
  the same child chain behind pending work instead of running concurrently (`1v1`).
- **Concurrency (low):** Child startup serialization is now scoped per registry
  `stateDir` instead of a single global queue, eliminating head-of-line blocking
  across unrelated projects (`9i0`).
- **Bad-state:** `handleProcExit` and the stop transition use a new nonce-aware,
  terminal-guarded `registry.conditionalPatch` that refuses to overwrite fresh
  fields or replacement rows from a stale or reused child ID (`19n`).
- **Bad-state:** Stop warning and cleanup-skip log messages are now persisted on
  the intended child instance via nonce-guarded patch, surviving in `children.json`
  and later status reads (`3gb`).
- **Bad-state:** Restart follows an explicit non-fidelity contract — it never
  reproduces custom config or secret-bearing environment overrides from the
  original start, starts from persisted non-secret identity plus caller-supplied
  config (default empty), and emits a diagnostic when prior config/env was
  intentionally dropped. No plaintext secret is persisted (`qff`).
- **Resource-leak:** Port-allocation failure now cleans every attempt-owned
  managed directory before rethrowing, leaving no unreachable temp directories (`0q3`).
- **Resource-leak:** Validation or config-write failure after provisioning now
  cleans only the directories created by the rejected attempt (`48i`).
- **Resource-leak:** Notification-manager cache is capped at 64 tracked projects
  with explicit admission refusal (no eviction, no silent state loss). Cached
  managers rebind to the newest `ChildRegistry` instance via a generation guard.
  Disposal awaits each manager's `dispose()` (`6f6`).
- **Error-handling:** Bulk stop uses `Promise.allSettled` and throws a typed
  `BulkStopError` carrying bounded, redacted per-target outcomes, so mixed-success
  and cancellation outcomes expose completed side effects without raw child/auth/
  logs/stacks. Single-child stop is unchanged (`f1p`).
- **Error-handling:** Failed-start cleanup reports incomplete directory deletion
  through one consistent bounded redacted error contract across all cleanup paths (`h15`).
- **Null-empty:** `oc_prompt` failure diagnostics now resolve `sessionID` and
  `childID` through the same helper as success/warning branches, preserving a
  caller-provided fallback `sessionId` (`doo`).
- **Boundary:** Diagnostic truncation suffix reports the exact number of UTF-16
  code units excluded at a surrogate boundary, matching the shared `truncate`
  helper (`sky`).
- **Boundary:** `isLoopbackHostname` validates IPv4 octets properly, rejecting
  malformed numeric hostnames like `127.0.0.999`. Preflight rejects dotted-numeric
  hostnames that are not valid IP literals before spawn or approval (`j3t`).
- **Boundary:** Oversized SSE frames emit one bounded error marker and are
  discarded to the next block boundary, preventing mid-data-line corruption while
  allowing later valid frames to parse normally (`8a2`).

### Changed

- Research beads `sxp`, `l70`, `xx0`, `c7k` documented the design decisions
  behind the restart-fidelity contract, notification-manager capacity policy,
  bulk-stop error contract, and cross-platform authenticated startup readiness.

## [0.1.1] - 2026-07-08

### Changed

- Documentation-only release: README now leads with the isolated child-session
  use case and a four-tool Quick Start (`oc_child_start` → `oc_prompt` →
  `oc_inspect` → `oc_child_stop`), with a "Safety at a glance" summary and a
  "For AI agents" note pointing at the bundled skills.
- Relocated trust modes, safety defaults, configuration, model selection, and
  notification detail to `docs/safety.md`; hooks to `docs/hooks.md`; the skills
  overview to `docs/agents.md`; CI detail to `CONTRIBUTING.md`. No runtime
  changes.

## [0.1.0] - 2026-07-07

### Added

- Initial public release of `opencode-child`, an opencode plugin for starting, inspecting, and controlling disposable child `opencode serve` processes from a parent opencode session.
- `oc_child_start`, `oc_child_status`, `oc_child_stop`, `oc_child_restart` lifecycle tools with loopback-by-default binding, generated HTTP Basic auth, and PID/process-group-verified stop behavior.
- `oc_session_create`, `oc_prompt`, `oc_inspect`, `oc_events`, `oc_command`, `oc_shell`, `oc_permission` tools for driving and inspecting child sessions.
- `oc_plugin_smoke_test` tool and `npm run smoke` script for a deterministic local lifecycle smoke test.
- `inherit`, `safe`, and `full-trust` trust modes with safe-mode isolation (`--pure`, stripped token-like env, rejected MCP/plugin/config overrides) unless explicitly unsafe-approved.
- `OPENCODE_CHILD_MAX_LIVE` concurrency cap, `OPENCODE_CHILD_STATE_DIR` registry override, and `OPENCODE_PLUGIN_DIAGNOSTICS_DIR` / `OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED` diagnostics knobs.
- Four agent skills under `skills/` documenting child orchestration, sandbox safety, permission triage, and server API debugging workflows.

[0.2.0]: https://github.com/mcrescenzo/opencode-child/releases/tag/v0.2.0
[0.1.1]: https://github.com/mcrescenzo/opencode-child/releases/tag/v0.1.1
[0.1.0]: https://github.com/mcrescenzo/opencode-child/releases/tag/v0.1.0
