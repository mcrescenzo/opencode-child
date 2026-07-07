---
name: opencode-server-api-debugging
description: Use when child opencode server startup, health checks, event streams, session prompts, registry inspection, or stop behavior fails.
---

# opencode Server API Debugging

Start with deterministic checks:

- `oc_child_status` for PID, base URL, health, sessions, registries, trust summary, and logs.
- `oc_inspect` for session messages, todos, diffs, children, and logs.
- If prompt or shell calls hang, prefer `oc_prompt` async mode and bounded polling.
- If stop fails, call `oc_child_stop` again with `kill: true` and verify `processAlive: false`.

Known caveat: `/instance/dispose` can return success while the process remains alive. PID/process-group verification is authoritative.
