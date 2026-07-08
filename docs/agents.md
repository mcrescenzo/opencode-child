# For AI Agents

This package ships four agent skills under `skills/` for coding agents (such as Claude Code) that read `SKILL.md` files from a project. They are documentation only — opencode does not load them, and they are not part of the published npm tarball.

- `opencode-child-orchestration`: the standard start/inspect/prompt/stop workflow for using this plugin's tools to test another plugin, command, agent, or config change without restarting the parent opencode TUI. Read this one first.
- `opencode-sandbox-safety`: safety defaults (loopback binding, random ports, scratch project dirs, keeping `dangerouslySkipPermissions` off) for evaluating isolation before and during a child run.
- `opencode-permission-triage`: how to read and respond to a child session's pending permission requests via `oc_inspect` and `oc_permission`.
- `opencode-server-api-debugging`: a deterministic checklist (`oc_child_status`, `oc_inspect`, async prompt/shell fallbacks, PID-verified stop) for diagnosing a child server that fails to start, hangs, or won't stop.
