# API Findings

Verified locally against opencode `1.17.13` (`opencode --version`).

`OPENCODE_SERVER_PASSWORD` enables HTTP Basic auth. The username defaults to `opencode` unless `OPENCODE_SERVER_USERNAME` is set. Child clients and SSE event tailing must send `Authorization: Basic base64(username:password)`.

## Route Compatibility Matrix

Startup gates fail closed when any `required-startup` route is missing. `required-per-tool` routes are checked by the tool that calls them, because several are dynamic or side-effecting. `optional-inspection` routes are reported as capability or inspection errors without blocking startup. `notification-only` routes power best-effort parent notifications and event history.

| Category | Routes |
| --- | --- |
| `required-startup` | `GET /global/health`, `GET /session`, `GET /session/status` |
| `required-per-tool` | `POST /session`, `POST /session/:id/prompt_async`, `POST /session/:id/message`, `POST /session/:id/command`, `POST /session/:id/shell`, `POST /session/:id/permissions/:permissionID`, `POST /permission/:requestID/reply`, `POST /instance/dispose` |
| `optional-inspection` | `GET /path`, `GET /project/current`, `GET /config`, `GET /command`, `GET /agent`, `GET /mcp`, `GET /lsp`, `GET /formatter`, `GET /experimental/tool/ids`, `GET /session/:id`, `GET /session/:id/children`, `GET /session/:id/todo`, `GET /session/:id/message`, `GET /session/:id/diff` |
| `notification-only` | `GET /global/event` |

The following nonblocking routes returned `200` from a disposable `opencode serve --hostname 127.0.0.1 --port <port> --print-logs` process:

- `GET /global/health`
- `GET /path`
- `GET /project/current`
- `GET /config`
- `GET /command`
- `GET /agent`
- `GET /mcp`
- `GET /lsp`
- `GET /formatter`
- `GET /experimental/tool/ids`
- `GET /session`
- `GET /session/status`
- `POST /session`
- `GET /session/:id`
- `GET /session/:id/children`
- `GET /session/:id/todo`
- `GET /session/:id/message`
- `GET /session/:id/diff`

The plugin also tails `GET /global/event` as a streaming SSE route. It is not part of the nonblocking `200` route probe because successful responses are long-lived event streams.

`POST /instance/dispose` returned `200`, but the child process was still alive after 500ms in the probe. The implementation treats dispose as advisory and verifies the PID/process group before reporting stop success.

SDK type inspection confirms current request shapes for:

- `POST /session/:id/prompt_async`: body includes `parts`, optional `model: { providerID, modelID }`, `agent`, `noReply`, `system`, and `tools`.
- `POST /session/:id/message`: synchronous prompt route with the same prompt body shape as `prompt_async`.
- `POST /session/:id/command`: body includes `command`, `arguments`, optional `agent`, and optional `model: "provider/model-id"`.
- `POST /session/:id/shell`: body includes `command`, `agent`, and optional `model: { providerID, modelID }`.
- `POST /session/:id/permissions/:permissionID`: publicly documented primary route; body includes `response: "once" | "always" | "reject"` and optional `remember`.
- `POST /permission/:requestID/reply`: locally observed compatibility fallback; body includes `reply: "once" | "always" | "reject"` and optional `message`.

Current permission events include `permission.asked`, `permission.replied`, `permission.v2.asked`, and `permission.v2.replied`; older event shapes may use `permission.updated`.

Blocking prompt, command, and shell live probes can hang on model/provider/permission behavior. All plugin wrappers use explicit timeouts and `oc_prompt` prefers `prompt_async` plus polling.
