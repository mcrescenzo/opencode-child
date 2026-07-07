---
name: opencode-permission-triage
description: Use when a child opencode session has pending permission requests or permission-related hangs during opencode-child testing.
---

# opencode Permission Triage

Use `oc_inspect` first to collect session status, messages, todos, logs, and registries.

Permission responses use:

- `once`: approve the specific request once.
- `always`: persistently approve when the child opencode API accepts it.
- `reject`: deny the request.

Prefer rejecting unexpected or broad requests. Do not switch to `full-trust` or `dangerouslySkipPermissions` unless the test explicitly requires parent-like power.
