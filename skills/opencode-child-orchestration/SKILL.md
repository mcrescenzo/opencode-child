---
name: opencode-child-orchestration
description: Use when starting, inspecting, restarting, stopping, or prompting disposable child opencode servers with the opencode-child plugin tools.
---

# opencode Child Orchestration

Use child servers when testing opencode plugins, commands, agents, tools, permissions, or config changes without restarting the parent opencode TUI.

If you are testing a plugin under active development, point `oc_child_start`'s `projectDir` (and `configDir`, if the plugin registers through project config) at that plugin's own checkout so the child loads the changed code from disk. Prefer a scratch project directory or a git worktree when the child run may edit files, so parent-repo state stays untouched.

Standard workflow:

- Start with `oc_child_start`, usually `trustMode: "inherit"` for realistic behavior or `trustMode: "safe"` for conservative local probes.
- Inspect startup with `oc_child_status` before prompting.
- Create sessions with `oc_session_create`.
- Use `oc_prompt` for bounded async prompts and `oc_inspect` for evidence.
- Stop with `oc_child_stop`; do not rely on `/instance/dispose` alone.

Safety notes:

- `safe` is not a security sandbox.
- Child servers may inherit auth, env, config, MCP, commands, agents, skills, and tools.
- Use scratch project directories or git worktrees for tests that may edit files.
- Always report child ID, PID, port, project dir, config dir, trust mode, and stop evidence.
