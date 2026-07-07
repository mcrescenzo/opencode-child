---
name: opencode-sandbox-safety
description: Use when evaluating safety, isolation, temp dirs, secrets, MCP side effects, or worktree choices for opencode-child runs.
---

# opencode Sandbox Safety

`opencode-child` starts real local opencode processes. Treat plugins and child prompts as arbitrary local code execution.

When a child run may edit files (plugin authoring, config changes, or prompts that call file-editing tools), point it at a scratch project directory or a git worktree instead of a directory you care about, so an unexpected edit or permission grant cannot touch real work.

Use these defaults:

- Bind to `127.0.0.1`.
- Use random ports.
- Prefer scratch project dirs or worktrees for edit tests.
- Keep `dangerouslySkipPermissions` off unless `trustMode` is explicitly `full-trust`.
- Stop every child and verify the PID is gone.

`safe` mode is best-effort local isolation, not a security sandbox. It may still inherit auth, environment, config, commands, agents, tools, or MCP behavior depending on opencode and project configuration.
