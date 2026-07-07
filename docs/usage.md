# Usage

Start a child in the current project:

```text
oc_child_start({ "trustMode": "inherit" })
```

`inherit` may inherit normal config/env/MCP behavior, but it uses isolated child data/cache/state by default. Pass `inheritData: true` only when provider/model prompts need real opencode auth-file storage, and expect a parent approval prompt.

Start a conservative disposable child:

```text
oc_child_start({ "trustMode": "safe", "cleanupPolicy": "delete-on-stop" })
```

Safe mode binds to loopback by default, starts with generated HTTP Basic auth, forces `--pure`, rejects token-like env and MCP config by default, and is still only best-effort local isolation rather than a sandbox. Non-loopback safe-mode starts remain high-risk and approval-visible, but the plugin refuses plaintext HTTP child connections until a TLS-backed path exists.

`inheritGlobalConfig: false` and `inheritMcp: false` are only accepted in safe mode (the `--pure` child); `inherit` and `full-trust` reject them, so omit those flags outside safe mode.

Inspect and stop:

```text
oc_child_status({ "childId": "child_..." })
oc_child_stop({ "childId": "child_..." })
```

Create and inspect a session:

```text
oc_session_create({ "childId": "child_...", "title": "probe" })
oc_inspect({ "childId": "child_...", "sessionId": "ses_..." })
oc_events({ "childId": "child_...", "limit": 20 })
```

Prompt with bounded async polling:

```text
oc_prompt({
  "childId": "child_...",
  "sessionId": "ses_...",
  "model": "openai/gpt-5.5",
  "text": "Say ok",
  "timeoutMs": 30000
})
```

`oc_prompt`, `oc_shell`, and `oc_command` accept the model as a combined `"provider/model-id"` string (as above) or as separate `providerID` and `modelID` fields:

```text
oc_shell({
  "childId": "child_...",
  "sessionId": "ses_...",
  "providerID": "openai",
  "modelID": "gpt-5.5",
  "command": "echo ok"
})
```

Bare model IDs without a provider (for example `"gpt-5.5"`) are rejected.
`oc_prompt` and `oc_shell` send the nested child API model shape; `oc_command` sends the command endpoint's plain `"provider/model-id"` string.

By default, `oc_prompt` watches the child session and queues a best-effort parent-session notification when that session becomes idle, reports an error, appears permission-blocked, or the child process exits unexpectedly. The notification tells the parent to inspect the child; it does not include full logs or messages.

Disable notifications for one prompt:

```text
oc_prompt({
  "childId": "child_...",
  "sessionId": "ses_...",
  "text": "Run this quietly",
  "notify": false
})
```

`noReply: true` prompts do not notify unless you also pass `notify: true`.

Use `oc_child_stop({ "childId": "all", "confirmAll": true })` to stop all registered children in this plugin state namespace. The default registry is user-private XDG state, not project `.opencode/`.

Non-loopback child servers are disabled. `allowNonLoopback: true` remains visible in approval metadata for compatibility, but current spawned children only expose `http://`; the plugin refuses to send child Basic auth over non-loopback plaintext HTTP.
