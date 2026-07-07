export const SUPPORTED_OPENCODE_VERSION = "1.17.13";

const route = (method, path, category, purpose, options = {}) => Object.freeze({
  method,
  path,
  category,
  purpose,
  probe: false,
  ...options,
});

export const ROUTE_COMPATIBILITY = Object.freeze([
  route("GET", "/global/health", "required-startup", "startup health checks and live status probes", { probe: true }),
  route("GET", "/session", "required-startup", "startup/session inventory used by inspection and smoke", { probe: true }),
  route("GET", "/session/status", "required-startup", "async prompt polling and session liveness", { probe: true }),

  route("POST", "/session", "required-per-tool", "oc_session_create"),
  route("POST", "/session/:id/prompt_async", "required-per-tool", "oc_prompt async submission"),
  route("POST", "/session/:id/message", "required-per-tool", "oc_prompt synchronous submission"),
  route("POST", "/session/:id/command", "required-per-tool", "oc_command"),
  route("POST", "/session/:id/shell", "required-per-tool", "oc_shell"),
  route("POST", "/session/:id/permissions/:permissionID", "required-per-tool", "oc_permission documented primary route"),
  route("POST", "/permission/:requestID/reply", "required-per-tool", "oc_permission observed compatibility fallback"),
  route("POST", "/instance/dispose", "required-per-tool", "oc_child_stop advisory dispose before PID verification"),

  route("GET", "/path", "optional-inspection", "startup path summary", { probe: true }),
  route("GET", "/project/current", "optional-inspection", "startup project summary", { probe: true }),
  route("GET", "/config", "optional-inspection", "startup config summary", { probe: true }),
  route("GET", "/command", "optional-inspection", "command registry summary", { probe: true }),
  route("GET", "/agent", "optional-inspection", "agent registry summary", { probe: true }),
  route("GET", "/mcp", "optional-inspection", "MCP registry summary", { probe: true }),
  route("GET", "/lsp", "optional-inspection", "LSP registry summary", { probe: true }),
  route("GET", "/formatter", "optional-inspection", "formatter registry summary", { probe: true }),
  route("GET", "/experimental/tool/ids", "optional-inspection", "tool id registry summary", { probe: true }),
  route("GET", "/session/:id", "optional-inspection", "target session inspection"),
  route("GET", "/session/:id/children", "optional-inspection", "target session child list"),
  route("GET", "/session/:id/todo", "optional-inspection", "target session todo list"),
  route("GET", "/session/:id/message", "optional-inspection", "target session messages"),
  route("GET", "/session/:id/diff", "optional-inspection", "target session diff"),

  route("GET", "/global/event", "notification-only", "best-effort SSE child event tail"),
]);

export const PROBED_CAPABILITY_ROUTES = Object.freeze(
  ROUTE_COMPATIBILITY.filter((entry) => entry.probe).map((entry) => entry.path),
);

export const REQUIRED_STARTUP_ROUTES = Object.freeze(
  ROUTE_COMPATIBILITY.filter((entry) => entry.category === "required-startup"),
);

export function formatRoute(entry) {
  return `${entry.method} ${entry.path}`;
}

export function missingRequiredStartupRoutes(capabilities = {}) {
  return REQUIRED_STARTUP_ROUTES
    .map((entry) => ({ entry, response: capabilities[entry.path] }))
    .filter(({ response }) => !response?.ok);
}

export function assertRequiredStartupRoutes(capabilities = {}) {
  const missing = missingRequiredStartupRoutes(capabilities);
  if (!missing.length) return;
  const details = missing.map(({ entry, response }) => {
    const status = response?.status ? `status ${response.status}` : "not probed";
    const error = response?.error ? `: ${response.error}` : "";
    return `${formatRoute(entry)} (${status}${error})`;
  });
  throw new Error(
    `OpenCode ${SUPPORTED_OPENCODE_VERSION} compatibility check failed: missing required startup route(s): ${details.join(", ")}. ` +
    `This plugin supports the OpenCode ${SUPPORTED_OPENCODE_VERSION} route contract; update OpenCode or disable this plugin for incompatible servers.`,
  );
}
