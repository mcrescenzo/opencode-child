# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/mcrescenzo/opencode-child/releases/tag/v0.1.1
[0.1.0]: https://github.com/mcrescenzo/opencode-child/releases/tag/v0.1.0
