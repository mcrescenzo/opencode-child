# OpenCode Child Orchestration Plan

## Purpose

Build an OpenCode orchestration plugin/toolset that lets a primary OpenCode agent start, control, inspect, restart, and stop separate full-powered OpenCode child servers.

The immediate use case is testing new OpenCode plugins, tools, commands, agents, and configuration changes without closing or restarting the user's main OpenCode TUI session.

The key design choice is to manage disposable child OpenCode backend processes through the documented server API, not to automate tmux or terminal keystrokes.

## Current Hardening Policy

The implementation now follows these defaults:

- Child servers bind to loopback only unless `allowNonLoopback: true` is explicitly approved.
- Every child gets HTTP Basic auth by default via generated `OPENCODE_SERVER_PASSWORD`; clients use Basic auth and redact passwords from tool output.
- `safe` mode is best-effort local isolation, not a sandbox. It forces `--pure`, strips token-like inherited env by default, rejects broad allow permissions, rejects MCP config, rejects remote/npm plugin specs, and rejects custom `opencodeBin` unless explicitly unsafe-approved.
- `inherit` may inherit config/env/MCP behavior, but keeps child XDG data/cache/state isolated by default. Auth-file provider state requires `inheritData: true` and approval.
- The default registry is user-private XDG state namespaced by project path, not project `.opencode/opencode-child`.
- Caller-supplied config/data/cache/state dirs are rejected by default because `configDir` writes `opencode.json`.
- Stop-all requires an explicit `childId: "all"` plus confirmation at the tool boundary.
- Registry-only stale PIDs are not signaled by default; live plugin-managed processes remain the normal stop path.

Sections below are retained as design history. Prefer this status section plus `README.md`, `docs/usage.md`, and current source/tests for implementation truth.

## Goals

- Let an orchestrator create isolated OpenCode child runtimes on demand.
- Let child runtimes load changed plugins/tools from disk at startup.
- Let the orchestrator restart only the child runtime to test reload behavior.
- Exercise real OpenCode behavior: plugin startup, hooks, tools, commands, agents, permissions, events, shell, diffs, and sessions.
- Keep the user's primary OpenCode TUI alive and untouched.
- Provide enough inspection to diagnose plugin/tool failures without manually opening another TUI.
- Prefer minimal, explicit, local tools over broad automation.

## Non-Goals

- Do not hot-reload plugins inside the current running OpenCode process unless OpenCode later documents a stable reload API.
- Do not control the user's main TUI server unless the user explicitly provides that server URL and asks for it.
- Do not use tmux or terminal keystroke automation as the primary control plane.
- Do not default to `--dangerously-skip-permissions`.
- Do not mutate global OpenCode config as part of normal tests.
- Do not hide child process state, logs, ports, or temp paths from the user.

## Core Model

The orchestrator manages child instances. A child instance is a real `opencode serve` process with a child-specific config directory and a localhost server URL.

Verified against local OpenCode `1.17.7`: this control-plane model is feasible, but `OPENCODE_CONFIG_DIR` should be treated as a child-specific config location/overlay, not as a proven hermetic config sandbox. Global OpenCode config, commands, agents, and permissions may still load unless OpenCode provides and verifies a stronger isolation switch. The orchestrator must report what actually loaded at startup.

```ts
type ChildInstance = {
  id: string
  baseUrl: string
  pid: number
  port: number
  projectDir: string
  configDir: string
  env: Record<string, string>
  trustMode: "safe" | "inherit" | "full-trust"
  startedAt: string
  status: "starting" | "ready" | "failed" | "stopped"
  pluginUnderTest?: string
  notes?: string
}
```

The orchestrator should keep a registry of child instances in memory and persist a small crash-recovery registry under a local plugin state directory if needed.

## Lifecycle

1. Build a child spec.
2. Create temp config and optional scratch project directories.
3. Write minimal `opencode.json` and plugin/tool files or references.
4. Start `opencode serve` with `OPENCODE_CONFIG_DIR=<temp-config>`.
5. Wait for `GET /global/health`.
6. Inspect loaded config, commands, agents, tools, permissions, and MCP status.
7. Create one or more sessions.
8. Send prompts, commands, shell calls, or async messages.
9. Watch events and collect logs.
10. Inspect messages, diffs, todos, file status, and permission prompts.
11. Restart the child after plugin/tool changes to reload startup-loaded code.
12. Stop the child and optionally clean temp resources.

## Server API Control Plane

Use HTTP or the OpenCode SDK as the primary transport.

Endpoint status verified against local OpenCode `1.17.7`: the short routes below exist for the MVP surface, including `/session`, `/session/status`, `/session/:id/message`, `/session/:id/todo`, `/session/:id/diff`, `/command`, `/agent`, `/mcp`, `/lsp`, `/formatter`, `/experimental/tool/ids`, `/experimental/tool`, `/path`, `/project/current`, `/config`, `/global/health`, and `/instance/dispose`.

Implementation note: keep all endpoint paths in a small API client wrapper and probe support at child startup. OpenCode docs and source also show project-scoped routes in some contexts, so raw endpoint assumptions should not be scattered across tools.

Important endpoints:

- `GET /global/health`: verify server readiness.
- `GET /global/event`: subscribe to server-sent events.
- `GET /project/current`: confirm project context.
- `GET /path`: confirm server path context.
- `GET /config`: inspect resolved config.
- `GET /command`: list available slash commands.
- `GET /agent`: list available agents.
- `GET /mcp`: inspect MCP status.
- `GET /lsp`: inspect LSP status.
- `GET /formatter`: inspect formatter status.
- `GET /experimental/tool/ids`: list registered tool IDs.
- `GET /experimental/tool?provider=<p>&model=<m>`: inspect tool schemas for a model.
- `POST /session`: create a session.
- `GET /session`: list sessions.
- `GET /session/status`: inspect running/idle status.
- `GET /session/:id`: inspect a session.
- `GET /session/:id/children`: inspect subagent child sessions.
- `GET /session/:id/todo`: inspect todos.
- `GET /session/:id/message`: list messages.
- `GET /session/:id/message/:messageID`: inspect a specific message.
- `POST /session/:id/message`: send a prompt and wait for response.
- `POST /session/:id/prompt_async`: send a prompt asynchronously.
- `POST /session/:id/command`: execute a slash command.
- `POST /session/:id/shell`: run shell through the child OpenCode session.
- `GET /session/:id/diff`: inspect file changes caused by the session.
- `POST /session/:id/abort`: abort a running session.
- `POST /session/:id/permissions/:permissionID`: respond to permission prompts.
- `POST /session/:id/revert`: revert a message.
- `POST /session/:id/unrevert`: restore reverted messages.
- `POST /instance/dispose`: ask the child server to shut down.

Verified caveat: in one local probe, `POST /instance/dispose` returned `true` but the `opencode serve` process did not exit. Treat dispose as an advisory cleanup request, not the source of truth for lifecycle. The child PID/process group is authoritative for stop and restart.

Useful CLI equivalents:

- `opencode serve --hostname 127.0.0.1 --port <port>`
- `opencode run --attach http://localhost:<port> --format json ...`
- `opencode run --attach http://localhost:<port> --command <name> ...`
- `opencode debug config`
- `opencode debug startup`
- `opencode agent list`
- `opencode session list`

## Reload Strategy

OpenCode documents plugin, tool, command, and agent loading as startup behavior. The reliable reload boundary is a process restart.

The orchestrator should therefore implement reload as:

1. Stop child server with `POST /instance/dispose`.
2. Verify whether the child PID/process group actually exited.
3. If still running, terminate the child process.
4. Start a fresh child server with the same child spec.
5. Re-run registry inspections.
6. Recreate sessions as needed.

This should be called restart or reload-child, not hot-reload, to avoid implying unsupported runtime behavior.

## Isolation Strategy

Default child launch should use:

- `OPENCODE_CONFIG_DIR=<temp-dir>` to provide a child-specific config directory for generated agents, commands, plugins, skills, and tools.
- `--hostname 127.0.0.1` to avoid network exposure.
- A free random port.
- Optional `OPENCODE_SERVER_PASSWORD=<random>` if we expose reusable URLs.
- A scratch project directory when testing file edits.
- A dedicated git worktree when testing against a real repository with edits.
- Explicit permissions in generated config.
- Optional `--pure` or `OPENCODE_PURE=1` for negative-control tests that disable external plugins.

Isolation caveats:

- `OPENCODE_CONFIG_DIR` does not currently prove hermetic isolation from global config in local OpenCode `1.17.7`; global commands, agents, and permissions may still appear.
- Provider auth may still come from environment or OpenCode auth storage.
- Project-level `opencode.json` and `.opencode` may still matter if the child runs in a real project directory.
- Environment variables can leak credentials into child processes.
- MCP servers can add latency, nondeterminism, and network side effects.
- Custom tools can shadow built-ins, including dangerous tools like `bash`.

### Trust Modes

The orchestrator should make trust posture explicit instead of hard-coding one safety model.

#### `safe`

Opt-in conservative mode. Use localhost, random port, child-specific config, conservative generated permissions, bounded logs, and best-effort suppression of inherited side-effecting services such as MCP. Do not use `--dangerously-skip-permissions`. Report any global config, MCP servers, tools, commands, agents, or permissions that still load.

This is safer local execution, not a security sandbox.

#### `inherit`

Default mode. Intentionally inherit the user's normal OpenCode environment, global config, commands, agents, skills, plugins, permissions, and MCP behavior where OpenCode does so naturally. Child data/cache/state remain isolated by default, so auth-file provider state requires explicitly approved `inheritData: true`. Keep permission prompts/config behavior intact unless explicitly overridden. Use this for realistic reproduction of the parent environment without automatically bypassing permission checks.

#### `full-trust`

Intentionally give the child the same operational latitude as the parent session, suitable for secure environments where guard rails can be removed. This mode may inherit global config/auth/env/MCP and may set `permission: "allow"` or use `--dangerously-skip-permissions` when explicitly requested.

Status output must make this unmistakable: trust mode, inherited config/env/MCP/auth posture, permission mode, PID, port, project dir, config dir, and loaded registries.

## Proposed Tool Surface

### `oc_child_start`

Start a child OpenCode server.

Inputs:

- `projectDir`: project or scratch directory.
- `pluginPaths`: local plugin files or directories to load.
- `toolPaths`: local tool files or directories to load.
- `config`: inline OpenCode config overrides.
- `env`: child environment overrides.
- `model`: optional default model.
- `agent`: optional default agent.
- `permissions`: explicit permission config.
- `trustMode`: `safe`, `inherit`, or `full-trust`.
- `dangerouslySkipPermissions`: only honored when explicitly requested, normally with `trustMode: "full-trust"`.
- `inheritEnv`: whether to inherit the parent environment wholesale or pass a bounded environment.
- `inheritGlobalConfig`: whether inherited global OpenCode config is intentional.
- `inheritMcp`: whether inherited MCP servers are intentional.
- `pure`: whether to run without external plugins.
- `timeoutMs`: startup timeout.
- `cleanupPolicy`: `keep` or `delete-on-stop`.

Output:

- child ID.
- base URL.
- PID.
- port.
- config dir.
- project dir.
- startup health result.
- initial command/agent/tool summary.
- trust/isolation summary, including any detected inherited global config or MCP.

Default `projectDir`: the current working directory. Callers may specify a different project or scratch directory when they want stronger isolation or fixture-based tests.

### `oc_child_status`

Report current child state.

Output:

- health.
- process state.
- sessions.
- recent events.
- recent stderr/stdout.
- resolved config summary.
- loaded commands.
- loaded agents.
- loaded tools.
- pending permissions.

### `oc_child_stop`

Stop one child or all children.

Behavior:

- Try `POST /instance/dispose` first.
- Wait briefly for process exit.
- Check child PID/process group liveness.
- Terminate if still running.
- Escalate only if normal termination fails.
- Clean temp dirs according to policy.

### `oc_child_restart`

Restart a child with the same spec.

Output:

- old PID and new PID.
- new health result.
- registry differences for commands, agents, and tools.
- startup logs.

### `oc_session_create`

Create a session in a child server.

Inputs:

- `childId`.
- `title`.
- `parentID` if supported for child sessions.

Output:

- session ID.
- initial session object.

### `oc_prompt`

Send a prompt to a child session.

Inputs:

- `childId`.
- `sessionId`.
- `text` or structured `parts`.
- `model` as `provider/model-id`, or explicit `providerID` and `modelID`.
- `agent` or `mode` after exact API mapping is verified.
- `system`.
- `tools`.
- `noReply`.
- `async`.
- `timeoutMs`.

Output:

- message summary.
- assistant parts.
- tool calls if visible.
- completion status.

Verified payload shape: the current implementation sends `POST /session/:id/message` and `/prompt_async` with `parts` plus optional nested `model: { providerID, modelID }`, `agent`, `system`, `tools`, and `noReply`. It normalizes `model: "provider/model-id"` or explicit `providerID`/`modelID` into that nested `model` object.

### `oc_command`

Execute a slash command in a child session through `POST /session/:id/command`.

Inputs:

- `childId`.
- `sessionId`.
- `command`.
- `arguments`.
- `agent`.
- `model`.

### `oc_shell`

Run shell through the child OpenCode session, not through the parent process.

This is important because it exercises child permissions, plugin hooks, shell env hooks, and session logging.

Inputs:

- `childId`.
- `sessionId`.
- `command`.
- `agent`.
- `model`.

### `oc_inspect`

Aggregate inspection data.

Inputs:

- `childId`.
- `sessionId` optional.
- `includeMessages`.
- `includeDiff`.
- `includeEvents`.
- `includeTools`.
- `includeLogs`.

Output:

- child status.
- session status.
- messages.
- diffs.
- todos.
- pending permissions.
- command registry.
- agent registry.
- tool registry.
- recent events.
- logs.

### `oc_events`

Return normalized event history or tail events for a child.

Inputs:

- `childId`.
- `sessionId` filter.
- `types` filter.
- `since` timestamp or event index.
- `limit`.

### `oc_permission`

Respond to a pending permission request.

Inputs:

- `childId`.
- `sessionId`.
- `permissionID`.
- `response`: `once`, `always`, or `reject` if accepted by current API mapping.
- `remember`.
- `reason`.

### `oc_plugin_smoke_test`

High-level helper after low-level tools are stable.

Inputs:

- `pluginPath`.
- `projectDir`.
- `prompt`.
- `expectedCommands`.
- `expectedTools`.
- `expectedEvents`.
- `expectedMessageText`.
- `expectedDiffText`.
- `restartAndRepeat`.

Output:

- pass/fail summary.
- child ID.
- session ID.
- evidence snippets.
- logs on failure.

## Proposed Skills

### `opencode-child-orchestration`

Use when starting, controlling, restarting, inspecting, or stopping child OpenCode servers through the child orchestration tools.

Contents should cover:

- When to use child servers.
- Standard lifecycle.
- How to avoid the user's main TUI.
- How to interpret child sessions and event output.
- Cleanup expectations.

### `opencode-plugin-test`

Use when testing OpenCode plugins, commands, custom tools, agents, MCP config, or hooks.

Contents should cover:

- Building isolated plugin test specs.
- Verifying plugin load and startup failures.
- Verifying command and tool registration.
- Triggering hook types with appropriate API calls.
- Restarting child servers after edits.
- Collecting evidence.

### `opencode-permission-triage`

Use when child sessions request permissions.

Contents should cover:

- Default deny/ask posture.
- How to approve only specific safe requests.
- How to reject dangerous or unexpected operations.
- How to avoid blanket permission escalation.

### `opencode-sandbox-safety`

Use when running untrusted or newly edited plugins/tools.

Contents should cover:

- Temp config dirs.
- Scratch project dirs.
- Worktree use.
- Secrets and environment handling.
- Localhost binding.
- Process cleanup.
- Network and MCP risk.

### `opencode-server-api-debugging`

Use when child server startup, event streams, sessions, or API calls fail.

Contents should cover:

- Health checks.
- Startup logs.
- Config validation.
- SSE reconnect behavior.
- Stuck sessions.
- Permission deadlocks.
- Registry inspection.

## Orchestration Agent Design

Create a specialized primary or subagent named something like `opencode-orchestrator`.

Recommended role:

- Owns child OpenCode lifecycle.
- Designs plugin/tool test scenarios.
- Starts isolated child servers.
- Drives child sessions through API calls.
- Restarts children after plugin edits.
- Produces evidence-backed test reports.
- Avoids direct edits unless explicitly asked or delegated.

Recommended permissions:

- Allow orchestration tools.
- Allow read/glob/grep in plugin repos.
- Ask for edit unless implementing the plugin itself.
- Ask or allow constrained bash only for safe commands needed to start/stop child servers.
- Deny dangerous shell patterns.
- Deny external directory access except approved temp/config/project roots.

## Implementation Phases

### Phase 1: Design and Skeleton

- Create plugin package structure under `~/.config/opencode/plugins/opencode-child`.
- Add plugin entry file.
- Add state directory conventions.
- Add helper for child registry.
- Add helper for HTTP requests to child servers.
- Add helper for free port allocation.
- Add helper for temp config creation.

### Phase 2: Minimal Lifecycle Tools

- Implement `oc_child_start`.
- Implement `oc_child_status`.
- Implement `oc_child_stop`.
- Implement `oc_child_restart`.
- Capture stdout/stderr.
- Verify health checks.
- Persist a minimal child registry for crash recovery and orphan cleanup.
- Include trust mode and loaded-registry summaries in status output.
- Add basic tests around process lifecycle if feasible.

Phase 2 stop/restart must verify PID exit. `/instance/dispose` alone is insufficient.

### Phase 3: Trust Profiles

- Implement `safe`, `inherit`, and `full-trust` startup profiles.
- Make environment inheritance explicit.
- Make global config inheritance explicit.
- Make MCP inheritance explicit.
- Make `permission: "allow"` and `--dangerously-skip-permissions` explicit full-trust options.
- Report inherited commands, agents, tools, permissions, and MCP in `oc_child_status`.

`inherit` is the default trust profile. `safe` is available for conservative tests. `full-trust` is available for secure environments where guard rails should be removable.

### Phase 4: Session Control

- Implement `oc_session_create`.
- Implement `oc_prompt`.
- Implement `oc_inspect` for messages and diffs.
- Normalize prompt payloads to `parts` plus optional nested `model: { providerID, modelID }`.
- Defer `oc_command`, `oc_shell`, async prompt, and permission response until their exact request/response shapes are live-verified.

### Phase 5: Events, Commands, Shell, and Permissions

- Add SSE event reader.
- Store bounded event history per child.
- Detect pending permission requests.
- Implement `oc_command`.
- Implement `oc_shell`.
- Implement `oc_permission`.
- Add stuck-session diagnostics.

### Phase 6: Plugin Test Helpers

- Implement `oc_plugin_smoke_test`.
- Add test fixtures for harmless plugins.
- Verify command registration.
- Verify tool registration.
- Verify hook behavior.
- Verify restart reloads changed plugin code.

### Phase 7: Skills and Agent

- Add orchestration skills.
- Add an `opencode-orchestrator` agent definition.
- Configure permissions conservatively.
- Document example workflows.

### Phase 8: Hardening

- Improve cleanup of orphaned child processes.
- Improve child registry recovery after parent restart.
- Add timeouts and max-output limits.
- Add auth support for child servers.
- Add cost and token reporting if available.
- Add worktree support for tests that edit real repositories.

## First Smoke Test Scenario

Use a harmless local plugin fixture that adds a custom tool named `hello_child` returning a fixed string.

Test steps:

1. Start child with fixture plugin.
2. Verify `/global/health` succeeds.
3. Verify `hello_child` appears in `GET /experimental/tool/ids`.
4. Create session.
5. Prompt child agent to call `hello_child`.
6. Inspect message output for expected text.
7. Stop child.
8. Modify fixture response text.
9. Restart child.
10. Prompt again.
11. Verify updated response text appears.

This proves child process isolation, plugin startup load, tool registration, session prompting, inspection, and restart-based reload.

## Open Questions

- Should `safe` mode attempt stronger global-config suppression if OpenCode adds a verified switch in a future version?
- Should the orchestrator expose one high-level `oc_test` tool after low-level tools are stable, or keep tests composed from lower-level tools indefinitely?
- How should permission responses map exactly to the current server API values across OpenCode versions?
- How should `agent` map onto the current message API's `mode` field, and is that stable across OpenCode versions?

## Safety Rules

- Bind child servers to `127.0.0.1` by default.
- Use random ports by default.
- Never restart or dispose the user's main TUI server unless explicitly requested.
- Never use `--dangerously-skip-permissions` by default.
- Use the current directory by default. Prefer explicit scratch dirs or worktrees for tests that should avoid editing the current repository.
- Show child PID, port, config dir, and project dir in status output.
- Keep bounded stdout/stderr logs for debugging.
- Provide `stop_all` behavior before adding concurrency.
- Require explicit allowlists for dangerous shell and external directory access.
- Treat plugins under test as arbitrary code.
- Allow explicit `full-trust` mode for secure environments where the user wants child sessions to inherit parent-like power and optionally skip permission prompts.
- Never make `full-trust` implicit; always show it in startup and status output.

## Plugin Scope

This is intended to be a global OpenCode plugin once implemented. During development it may be tested from the project directory, but the target install location and user experience should assume global availability.

## Recommended MVP

Implement only these first:

- `oc_child_start`
- `oc_child_status`
- `oc_child_restart`
- `oc_child_stop`
- `oc_session_create`
- `oc_prompt`
- `oc_inspect`

Include minimal persistent registry, PID-verified stop behavior, default `inherit` trust-mode behavior, current-directory project default, and trust-mode reporting in the MVP. Defer permissions, event tailing, shell execution, slash commands, async prompts, and high-level smoke tests until basic child lifecycle and message prompting are reliable.
