# AGENTS.md

**Contract version:** `@opencode-ai/plugin@1.17.7` (declared range: `^1.17.7`)
**Verified against runtime:** opencode 1.17.13

## Scope

- This is a standalone, independently-published npm package (`@mcrescenzo/opencode-child`). Commit plugin changes in this repo.
- `opencode-child.js` is only a re-export. The plugin implementation starts at `src/index.js` and registers all `oc_*` tools there.
- `.opencode/`, `node_modules/`, logs, and any local Beads/Dolt state under `.beads/` are local runtime state and are gitignored; do not treat them as source.

## Commands

- Run deterministic tests with `npm test` (`node --test tests/*.test.mjs`).
- Run a focused test file with `node --test tests/session.test.mjs` or another file under `tests/`.
- Run the live lifecycle smoke test with `npm run smoke`; it starts a disposable child server and does not require model completion.
- Smoke env knobs: `OPENCODE_CHILD_PROJECT_DIR=/path/to/project npm run smoke` and `OPENCODE_CHILD_TRUST_MODE=safe|inherit|full-trust npm run smoke`.

## Architecture Notes

- Core modules: `src/lifecycle.js` starts/stops/restarts child `opencode serve` processes, `src/session.js` wraps child session/prompt/command/shell/permission endpoints, `src/client.js` is the HTTP client, `src/registry.js` persists child registry state, `src/notifications.js` handles parent notifications, and `src/smoke-core.js` backs both `npm run smoke` and `oc_plugin_smoke_test`.
- The default registry is a user-private XDG state directory namespaced by project path, not project `.opencode/`; `OPENCODE_CHILD_STATE_DIR` is only for explicit fixture/debug use.
- Registry/log/event state may contain child auth material before redaction boundaries; keep it local and do not expose or commit it.
- `POST /instance/dispose` is advisory only. Stop/restart success must be verified by PID/process-group liveness, as implemented in `src/lifecycle.js`.
- Plugin disposal stops live plugin-managed children and aborts SSE event readers before clearing registry/notification caches.

## Safety And Behavior

- Child servers bind to loopback and get generated HTTP Basic auth by default; non-loopback requires `allowNonLoopback: true` plus parent approval.
- `safe` trust mode is best-effort local isolation, not a sandbox. It forces `--pure` and rejects broad permissions, MCP config, remote/npm plugin specs, token-like env overrides, full env inheritance, and custom `opencodeBin` unless explicitly unsafe-approved.
- `inherit` can load normal project/global config and env behavior, but child data/cache/state stay isolated unless `inheritData: true` is approved.
- Caller-supplied `configDir`, `dataDir`, `cacheDir`, or `xdgStateDir` are rejected by default because `configDir` writes an `opencode.json`.
- opencode loads plugins at process startup. After editing this plugin, test through a restarted child process or restart the parent opencode session to load the changed plugin.

## Source Of Truth

- Prefer executable source and tests over `PLAN.md`; `PLAN.md` is design history unless its current-status section matches source.
- API endpoint behavior was last documented in `docs/api-findings.md` against opencode `1.17.13`; re-verify before depending on undocumented route shapes.
