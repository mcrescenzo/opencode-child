# Exhaustive Bughunt Plan

This document tracks a repo-wide bughunt for the `opencode-child` plugin.
It is intended to be executable: each checklist item should either be verified,
converted into a bug with reproduction steps, or explicitly deferred with a reason.

## Scope

- **Repo:** `plugins/opencode-child`
- **Primary source:** `src/*.js`, `opencode-child.js`, `scripts/smoke.js`
- **Tests:** `tests/*.test.mjs`
- **Docs/runbooks:** `README.md`, `docs/*.md`, `AGENTS.md`, this file
- **Out of scope by default:** unrelated global OpenCode configuration, parent repo
  changes, and live model/provider behavior unless required to prove plugin behavior.

## Audit Artifacts

For each discovered issue, record:

- severity: `critical`, `high`, `medium`, `low`
- affected module/tool
- minimal reproduction steps
- expected versus actual behavior
- security/privacy impact, if any
- regression-test strategy
- fix status or deferral reason

## Baseline Commands

Run these at the start of each major phase and capture results:

```sh
git status --short
npm test
npm run smoke
```

Notes:

- `npm test` is expected to be token-free and deterministic.
- `npm run smoke` starts a disposable child server and verifies live lifecycle
  behavior; keep it separate from the default test suite.
- If the worktree is dirty, record whether failures apply to the dirty tree or
  clean `HEAD`.

## Bughunt Log

### 2026-06-25 initial setup

- **Start commit:** `a9596d3 chore: initialize opencode-child as standalone repo`
- **Initial worktree state:** dirty before this plan was added. Pre-existing
  modified files were `.gitignore`, `src/lifecycle.js`, `src/notifications.js`,
  `src/registry.js`, `tests/lifecycle-robustness.test.mjs`,
  `tests/notifications.test.mjs`, and `tests/registry.test.mjs`; `AGENTS.md`
  was untracked. This plan added `BUGHUNT.md`.
- **Baseline deterministic tests:** `npm test` passed, 72/72 tests.
- **Baseline live smoke:** `npm run smoke` passed. The smoke output showed a
  healthy OpenCode child (`version: 1.17.7`) and cleanup with
  `stopped: true`, `processAlive: false`, `disposeStatus: 200`.
- **Test-script audit:** all files under `tests/*.mjs` currently match the
  `npm test` glob (`tests/*.test.mjs`); `scripts/smoke.js` is intentionally
  separate and run by `npm run smoke`.

Initial read-only coverage exploration found the highest-yield next targets to
be contract-level `src/index.js` tool execution tests, end-to-end redaction of
HTTP/SSE/tool outputs, lifecycle partial-failure cleanup, event-tail reconnect
and malformed-event handling, session endpoint degradation, registry corruption,
and trust-mode/security boundary fuzzing.

### 2026-06-25 Phase 0 contract/redaction pass

- Added `tests/index-contract.test.mjs`, a fake plugin-context harness for
  public `src/index.js` tool `execute()` paths.
- Initial tests caught public-boundary leaks: `oc_shell` approval metadata and
  `oc_child_status`/`oc_events` outputs exposed freeform `Bearer`, `Basic`,
  `sk-*`, and child-password values when those secrets appeared under generic
  keys such as `command`, `logs.stdout`, `data.message`, or `raw`.
- Fixed public redaction by scrubbing freeform string values after key-based
  redaction in `src/index.js`; `eventsChild()` also now scrubs event strings
  with the child auth password before returning event history.
- **Targeted verification:** `node --test tests/index-contract.test.mjs` passed,
  4/4 tests.
- Chose a fail-closed registry corruption policy for malformed JSON and invalid
  child rows. Added tests that assert corrupt `children.json` is not overwritten
  and malformed rows are rejected with a clear error.
- **Registry verification:** `node --test tests/registry.test.mjs` passed, 7/7
  tests.
- Added notification redaction coverage for child error data delivered back to
  the parent session; child error summaries now scrub common token shapes and
  the child auth password before they are embedded in parent prompts.
- **Notification verification:** `node --test tests/notifications.test.mjs`
  passed, 18/18 tests.
- Fixed prompt polling degradation: an accepted `prompt_async` is no longer
  reported as settled when every `/session/status` poll fails; it now remains
  pending until timeout so callers get an explicit `timedOut: true` result.
- **Session verification:** `node --test tests/session.test.mjs` passed, 13/13
  tests.
- **Full deterministic verification:** `npm test` passed, 80/80 tests.
- **Live smoke verification:** `npm run smoke` passed with healthy OpenCode
  `1.17.7` child and cleanup with `stopped: true`, `processAlive: false`,
  `disposeStatus: 200`.
- Remaining Phase 0 targets: lifecycle post-spawn partial-failure cleanup,
  permission fallback narrowing, and event-tail malformed/reconnect behavior.

## Source Risk Map

| Module | Primary risks to audit |
| --- | --- |
| `src/index.js` | tool registration shape, approval gates, output redaction/truncation, parent-context assumptions |
| `src/lifecycle.js` | start/stop/restart races, trust-mode validation, process cleanup, PID/process-group liveness, managed-dir cleanup, event tailing |
| `src/session.js` | session/prompt polling, command/shell/permission route fallbacks, malformed child responses, timeout behavior, inspect aggregation |
| `src/client.js` | HTTP timeout/error handling, Basic auth, JSON parse failures, sensitive error text |
| `src/registry.js` | durable writes, corrupt files, file modes, concurrent writers, stale/duplicate entries |
| `src/notifications.js` | event normalization, queue/dedupe/retry, parent-idle detection, expected-stop suppression, secret redaction |
| `src/smoke-core.js` | live startup assumptions, cleanup guarantees, route/registry evidence quality |
| `src/util.js` | secret scrubbing, loopback checks, sandboxed deletion, process signaling helpers, model/text helpers |

## Public Tool Coverage Matrix

Mark each cell as `covered`, `partial`, `missing`, or `deferred`.

- Use `covered` only for a direct assertion through the public `execute()` path
  or a live runtime proof.
- Use `partial` for module-level tests that cover underlying behavior but do not
  exercise the public tool contract.
- Use `deferred` only with an explicit reason, especially for token-spending or
  runtime-only behavior.

| Tool | Happy path | Invalid args | Dead/unknown child | Timeout/error | Safety/approval | Redaction | Cleanup evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `oc_child_start` |  |  |  |  |  |  |  |
| `oc_child_status` |  |  |  |  |  |  |  |
| `oc_child_restart` |  |  |  |  |  |  |  |
| `oc_child_stop` |  |  |  |  |  |  |  |
| `oc_session_create` |  |  |  |  |  |  |  |
| `oc_prompt` |  |  |  |  |  |  |  |
| `oc_command` |  |  |  |  |  |  |  |
| `oc_shell` |  |  |  |  |  |  |  |
| `oc_permission` |  |  |  |  |  |  |  |
| `oc_events` |  |  |  |  |  |  |  |
| `oc_inspect` |  |  |  |  |  |  |  |
| `oc_plugin_smoke_test` |  |  |  |  |  |  |  |

## Existing Test Areas To Confirm

- utility helpers: IDs/auth headers/redaction/loopback/sandboxed deletion
- HTTP client: JSON handling, Basic auth, timeout behavior
- registry: persistence, private modes, same-process and multi-process writes
- lifecycle validation: non-loopback rejection, config-dir rejection, unsafe safe-mode overrides, failed-start cleanup
- lifecycle cleanup/robustness: stale PIDs, terminal entries, caps, monotonic events, graceful termination, restart preservation
- session wrappers: dead child handling, prompt failures, model payloads, auth-isolation diagnostics, permission fallback
- notifications: normalization, idle detection, queue/dedupe/retry/prune, expected-stop/noReply suppression

## Phase 0 Gate: Prove The Harness Can Catch High-Risk Bugs

Before broad implementation, add or identify tests that exercise these contracts
directly. This prevents the bughunt from becoming only a checklist without
observable failure modes.

- [x] Initial `src/index.js` public tool `execute()` harness: instantiate the plugin with
  a fake OpenCode context, fake `context.ask`, and deterministic child/session
  stubs. Current coverage includes approval fail-closed behavior for restart,
  shell approval metadata, permission approval policy, status output, and events
  output.
- [x] Public redaction tests for final tool output, metadata, approval prompts,
  logs, events, and registry summaries.
- [x] Notification-specific public redaction tests for queued/delivered parent
  notifications.
- [ ] Lifecycle post-spawn partial-failure cleanup tests: registry write failure,
  health timeout, startup inspection failure, capability probe failure, and
  EADDRINUSE retry cleanup.
- [x] Registry corruption policy test: fail closed on malformed JSON and invalid
  child rows while preserving the corrupt file for manual recovery.
- [ ] Session/permission degradation tests: malformed status data,
  route-not-found fallback, and non-404 permission failures.
- [x] Accepted-then-status-error prompt polling remains pending until timeout
  instead of reporting a false settled result.

### Decisions To Make Before Fixing

- **Redaction boundary:** decide whether low-level client/registry/event state may
  contain local-sensitive raw secrets, or whether secrets must be scrubbed before
  storage as well as before public tool output.
- **Registry corruption policy:** fail closed, quarantine corrupt files, or salvage
  valid rows. Each choice has cleanup and live-child-discovery tradeoffs.
- **Route drift policy:** prefer narrow fallbacks with explicit evidence over broad
  compatibility fallbacks that may hide unrelated failures.

## High-Priority Bughunt Passes

### 1. Tool-surface and approval tests

- [ ] Drive real `src/index.js` tool `execute()` paths through a fake plugin context.
- [ ] Verify high-risk tools ask for parent approval before risky behavior.
- [ ] Verify approval metadata redacts nested secrets and auth material.
- [ ] Verify every public tool has at least one contract-level test.

### 2. Redaction and privacy boundaries

- [ ] HTTP error bodies containing `Bearer`, `Basic`, `sk-*`, passwords, or tokens are scrubbed before output.
- [ ] Parsed SSE JSON events with secrets under generic keys such as `message` or `error` are scrubbed.
- [ ] Registry/log/event summaries returned by tools do not expose child auth material.
- [ ] Startup failure paths do not leak generated usernames/passwords or temp paths that should remain internal.

### 3. Lifecycle fault injection

- [ ] Spawn failure cleans up managed directories and registry state.
- [ ] Registry write failure after spawn terminates the child process.
- [ ] Health timeout terminates the child process and leaves no live-process entry.
- [ ] Startup inspection/capability-probe failure cannot leave a silently running unmanaged child.
- [ ] Stop/restart are idempotent and report accurate liveness.
- [ ] Restart cannot silently escalate trust mode, env inheritance, data/cache/state inheritance, or unsafe overrides.

### 4. Event tailing and notifications

- [ ] SSE stream reconnect/drop behavior is bounded and observable.
- [ ] Malformed JSON and very large events are handled without crashing or leaking secrets.
- [ ] Event writes stop after expected child stop or terminal registry state.
- [ ] Notification retry/dedupe logic cannot spam stale sessions.

### 5. Session endpoint robustness

- [ ] Malformed `/session/status` data is classified safely.
- [ ] Prompt async polling handles accepted-then-timeout and repeated endpoint errors.
- [ ] `oc_command`, `oc_shell`, and `oc_permission` validate body shapes and route fallbacks consistently.
- [ ] Permission fallback is used only for the intended route-not-found case, not unrelated failures.

### 6. Registry durability and corruption

- [ ] Truncated or malformed `children.json` recovers safely.
- [ ] Malformed child rows cannot crash status/stop/restart.
- [ ] Duplicate IDs and missing IDs are handled deterministically.
- [ ] Write/rename/chmod failures preserve previous valid state where possible.
- [ ] Multi-process lost-update windows are documented, fixed, or covered by regression tests.

### 7. Trust-mode and security boundaries

- [ ] `safe` rejects remote/npm plugin specs, MCP config, broad permissions, unsafe dirs, token-like env, full env inheritance, and custom binaries by default.
- [ ] `inherit` loads intended config while keeping child data/cache/state isolated unless explicitly approved.
- [ ] Non-loopback binding requires explicit approval and cannot be enabled accidentally.
- [ ] Stale PID signaling and external-directory cleanup require explicit, scoped approval.
- [ ] Full-trust/dangerous permissions are not reachable through ambiguous input.

### 8. Live runtime verification

Use disposable child sessions only for behavior that mocks cannot prove.

- [ ] Plugin loads in a real OpenCode child.
- [ ] Expected tools are registered.
- [ ] Session creation works against the live child.
- [ ] Stop verifies process death, not only `POST /instance/dispose` success.
- [ ] Restart reloads changed plugin code when relevant.
- [ ] Safe-mode runtime rejects unsafe config/env/plugin inputs.

Evidence to capture for live checks:

- child ID, PID, port, trust mode
- plugin/config path under test
- startup health
- relevant registry entries
- exercised endpoint/tool/command
- cleanup result including `processAlive: false`

## Triage Workflow

For every confirmed bug:

1. Write or identify the smallest failing test.
2. Confirm the test fails without the fix when practical.
3. Apply the narrowest fix.
4. Run the targeted test file.
5. Run `npm test`.
6. Run `npm run smoke` only if live child behavior or startup behavior changed.
7. Update docs if the public contract changed.

## Completion Criteria

- [ ] Baseline checks recorded.
- [ ] Public tool coverage matrix filled.
- [ ] High-priority bughunt passes completed or explicitly deferred.
- [ ] All critical/high bugs fixed or tracked with reproduction steps.
- [ ] All security-sensitive rejection paths have regression tests or documented live-test coverage.
- [ ] Docs match current behavior.
- [ ] Any live child processes used during the audit are stopped and verified dead.
