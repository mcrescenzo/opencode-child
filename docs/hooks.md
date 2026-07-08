# Hooks

The plugin registers three opencode hooks:

- `tool`: registers the `oc_*` tools listed in the README.
- `event`: forwards parent session events to per-child notification managers so `oc_prompt` can queue best-effort completion notifications.
- `dispose`: stops live plugin-managed children and aborts their SSE event readers, then clears registry/notification caches, when the plugin unloads.

See `AGENTS.md` for the module map behind these hooks (`src/lifecycle.js`, `src/session.js`, `src/client.js`, `src/registry.js`, `src/notifications.js`).
