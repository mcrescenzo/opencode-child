// Pure plugin factory for opencode-child.
//
// This module deliberately does NOT import the opencode plugin runtime package.
// The only thing it needs from that package is the `tool` helper (an identity
// function whose `tool.schema` is the zod schema builder). That helper is
// injected via `createOpenCodeChildPlugin(tool)`, which keeps this module
// runnable without any opencode infrastructure so the contract tests can
// target it directly. The thin entry (`./index.js`) binds the real helper.
import { ChildRegistry, TERMINAL_STATUSES, defaultStateDir } from "./registry.js";
import { MAX_LIVE_CHILDREN_CEILING, MAX_TOOL_TIMEOUT_MS, collectStartRisks, disposeLifecycleState, eventsChild, restartApprovalMetadata, restartChild, startChild, statusChild, stopChild } from "./lifecycle.js";
import { commandSession, createSession, inspectSession, permissionSession, promptSession, shellSession } from "./session.js";
import { NotificationManager } from "./notifications.js";
import { runSmoke } from "./smoke-core.js";
import { childOwnerFromContext, childOwnerMatches, publicRedact, truncate } from "./util.js";
import { createChildDiagnostics } from "./diagnostics.js";

// opencode double-instantiates plugin factories and keeps the process alive
// across many tool calls, so these caches (keyed by project state directory)
// must be the single source of truth AND bounded: a long-lived parent that
// drives children across distinct project directories/worktrees would otherwise
// grow these Maps without limit. Registry entries are LRU-capped directly.
// Notification managers are capacity-pruned only when their registry has no
// non-terminal child rows, because evicting one tears down childOwners/watches/
// pending bookkeeping. The `dispose` hook clears both caches on shutdown.
// ChildRegistry entries are pure in-memory caches over the on-disk children.json,
// so dropping one only forces a reload — no state is lost.
const MAX_TRACKED_PROJECTS = 64;
const RESULT_OUTPUT_MAX = 20000;
export const MAX_TOOL_ARG_STRING_CHARS = 65536;
export const MAX_TOOL_ARG_JSON_CHARS = 262144;
export const MAX_TOOL_ARG_TOTAL_CHARS = 524288;
const METADATA_MAX_STRING = 4000;
const METADATA_MAX_ARRAY = 50;
const METADATA_MAX_OBJECT_KEYS = 100;
const METADATA_MAX_DEPTH = 8;

// Access-ordered LRU over a Map: a `get`/`set` moves the key to the most-recent
// end, and growing past `limit` evicts the oldest entry (invoking `onEvict` so
// the dropped value can release its own resources). Exported for unit testing.
export function createBoundedMap(limit, onEvict) {
  const map = new Map();
  const evict = (value, key) => {
    try {
      onEvict?.(value, key);
    } catch {
      /* eviction cleanup is best-effort; never let it break the caller */
    }
  };
  return {
    has: (key) => map.has(key),
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      while (map.size > limit) {
        const oldestKey = map.keys().next().value;
        const oldestValue = map.get(oldestKey);
        map.delete(oldestKey);
        evict(oldestValue, oldestKey);
      }
      return this;
    },
    delete: (key) => map.delete(key),
    entries: () => map.entries(),
    values: () => map.values(),
    clear(runEvict = false) {
      if (runEvict) for (const [key, value] of map) evict(value, key);
      map.clear();
    },
    get size() {
      return map.size;
    },
  };
}

const registries = createBoundedMap(MAX_TRACKED_PROJECTS);
const notificationManagers = createBoundedMap(Number.POSITIVE_INFINITY, (manager) => manager?.dispose?.());

function registryFor(context) {
  const stateDir = defaultStateDir(context?.directory || process.cwd());
  let registry = registries.get(stateDir);
  if (!registry) {
    registry = new ChildRegistry(stateDir);
    registries.set(stateDir, registry);
  }
  return registry;
}

function activeChildRow(child) {
  return child && !child.expectedStop && !TERMINAL_STATUSES.has(child.status);
}

async function managerHasActiveChildren(manager) {
  const children = await manager?.registry?.list?.();
  return Array.isArray(children) && children.some(activeChildRow);
}

async function pruneNotificationManagers(protectedStateDir) {
  while (notificationManagers.size > MAX_TRACKED_PROJECTS) {
    let evicted = false;
    for (const [stateDir, manager] of notificationManagers.entries()) {
      if (stateDir === protectedStateDir) continue;
      const active = await managerHasActiveChildren(manager).catch(() => true);
      if (active) continue;
      notificationManagers.delete(stateDir);
      manager?.dispose?.();
      evicted = true;
      break;
    }
    if (!evicted) break;
  }
}

async function notificationManagerFor(registry, pluginContext) {
  let manager = notificationManagers.get(registry.stateDir);
  if (!manager) {
    manager = new NotificationManager(pluginContext, registry);
    notificationManagers.set(registry.stateDir, manager);
    await pruneNotificationManagers(registry.stateDir);
  }
  return manager;
}

// Tear down every live lifecycle resource, cached NotificationManager, and
// registry cache. Shared by the `dispose` hook; size accessor below is tests only.
async function disposeModuleState() {
  await disposeLifecycleState();
  notificationManagers.clear(true);
  registries.clear();
}

// Test-only introspection of the module-level caches. Not used by the plugin
// runtime; exported so the contract suite can assert bounded growth + teardown
// without reaching into closure state.
export function __moduleStateSizes() {
  return { registries: registries.size, notificationManagers: notificationManagers.size };
}

export function __hasNotificationManagerForTest(stateDir) {
  return notificationManagers.has(stateDir);
}

function boundMetadata(value, seen = new WeakSet(), depth = 0) {
  if (typeof value === "string") return truncate(value, METADATA_MAX_STRING);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= METADATA_MAX_DEPTH) return "[max-depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, METADATA_MAX_ARRAY).map((item) => boundMetadata(item, seen, depth + 1));
    if (value.length > METADATA_MAX_ARRAY) out.push(`[${value.length - METADATA_MAX_ARRAY} more items]`);
    return out;
  }
  const out = Object.create(null);
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, METADATA_MAX_OBJECT_KEYS)) {
    out[key] = boundMetadata(item, seen, depth + 1);
  }
  if (entries.length > METADATA_MAX_OBJECT_KEYS) out.__truncated_entries = entries.length - METADATA_MAX_OBJECT_KEYS;
  return out;
}

function result(value) {
  const safe = publicRedact(value);
  return { output: truncate(safe, RESULT_OUTPUT_MAX), metadata: typeof safe === "object" ? boundMetadata(safe) : undefined };
}

function jsonCharLength(value, path) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    throw new Error(`${path} must be JSON-serializable`);
  }
}

export function assertToolArgsWithinBounds(toolName, args = {}) {
  const root = args && typeof args === "object" ? args : {};
  const total = jsonCharLength(root, `${toolName}.args`);
  if (total > MAX_TOOL_ARG_TOTAL_CHARS) {
    throw new Error(`${toolName}.args exceeds max argument payload size (${total}/${MAX_TOOL_ARG_TOTAL_CHARS} chars)`);
  }

  const seen = new WeakSet();
  const visit = (value, path) => {
    if (typeof value === "string") {
      if (value.length > MAX_TOOL_ARG_STRING_CHARS) {
        throw new Error(`${path} exceeds max argument string length (${value.length}/${MAX_TOOL_ARG_STRING_CHARS} chars)`);
      }
      return;
    }
    if (value === null || value === undefined || typeof value !== "object") return;
    if (seen.has(value)) throw new Error(`${path} must be JSON-serializable`);
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    for (const [key, item] of Object.entries(value)) visit(item, `${path}.${key}`);
  };

  for (const [key, value] of Object.entries(root)) {
    if (value && typeof value === "object") {
      const size = jsonCharLength(value, `${toolName}.${key}`);
      if (size > MAX_TOOL_ARG_JSON_CHARS) {
        throw new Error(`${toolName}.${key} exceeds max argument JSON size (${size}/${MAX_TOOL_ARG_JSON_CHARS} chars)`);
      }
    }
    visit(value, `${toolName}.${key}`);
  }
}

function boundedExecute(toolName, fn) {
  return async (args = {}, context = {}) => {
    assertToolArgsWithinBounds(toolName, args);
    return await fn(args, context);
  };
}

async function requireParentApproval(context, action, metadata = {}) {
  if (typeof context?.ask !== "function") {
    throw new Error(`parent approval required for ${action}, but this OpenCode tool context does not expose context.ask`);
  }
  return await context.ask({
    permission: `opencode-child.${action}`,
    patterns: [action],
    always: [],
    metadata: publicRedact(metadata),
  });
}

async function requireChildAccess(registry, context, childId, action) {
  if (!childId || childId === "all") {
    // Bulk target: the single-child path below is skipped, so gate cross-owner
    // access here too. Any non-terminal child owned by a different caller must
    // clear a parent approval before the bulk operation touches it.
    const foreign = (await registry.list()).filter(
      (child) => !TERMINAL_STATUSES.has(child.status) && !childOwnerMatches(child.owner, context),
    );
    if (foreign.length) {
      await requireParentApproval(context, `${action}.cross-owner`, {
        childIds: foreign.map((child) => child.id),
        caller: childOwnerFromContext(context),
      });
    }
    return undefined;
  }
  const child = await registry.get(childId);
  if (childOwnerMatches(child.owner, context)) return child;
  await requireParentApproval(context, `${action}.cross-owner`, {
    childId,
    owner: child.owner,
    caller: childOwnerFromContext(context),
  });
  return child;
}

function diagnosticData(args = {}) {
  return {
    trustMode: args.trustMode,
    cleanupPolicy: args.cleanupPolicy,
    hostname: args.hostname,
    port: args.port,
    response: args.response,
  };
}

function childHttpFailure(value) {
  if (!value || typeof value !== "object") return undefined;
  if (value.ok === false) return value;
  for (const key of ["accepted", "response", "documented", "observed"]) {
    if (value[key]?.ok === false) return value[key];
  }
  return undefined;
}

function hasChildHttpFailure(value) {
  return Boolean(childHttpFailure(value));
}

function childHttpFailureData(value) {
  const failure = childHttpFailure(value);
  if (!failure) return undefined;
  return { status: failure.status, error: failure.error, data: failure.data };
}

function promptWarningData(value, args) {
  const failure = childHttpFailureData(value);
  return {
    ...(value?.diagnostic ? { diagnostic: value.diagnostic } : {}),
    timedOut: Boolean(value?.timedOut),
    async: args.async !== false,
    ...(failure ? { childHttpFailure: failure } : {}),
  };
}

// startChildUnlocked's C05 race guard (lifecycle.js) can return without throwing
// yet describe an already-torn-down child: when a concurrent oc_child_stop/restart
// marks the id terminal mid-startup, it returns {...child, ...concurrent} with a
// terminal status (stopped/stopping) or expectedStop instead of "ready", and never
// starts the event tail. Because it does not throw, withDiagnostics would otherwise
// record a clean success; this classifier flags the raced return as a warning.
export function childStartRacedStop(value) {
  return Boolean(value?.expectedStop) || Boolean(value?.status && value.status !== "ready");
}

// Resolve a diagnostics spec field that may be a plain value or a function of
// the tool result. Used for both childID and sessionID so that tools whose id
// is only minted at runtime (e.g. oc_prompt with no sessionId) still record the
// concrete id rather than undefined.
function resolveSpecField(specField, value) {
  return typeof specField === "function" ? specField(value) : specField;
}

async function withDiagnostics(context, spec, fn) {
  const diagnostics = createChildDiagnostics(context);
  const start = Date.now();
  try {
    const value = await fn();
    const childID = resolveSpecField(spec.childID, value);
    const sessionID = resolveSpecField(spec.sessionID, value);
    await diagnostics.emit(spec.warning?.(value)
      ? {
          level: "warn",
          event: spec.warningEvent,
          message: spec.warningMessage,
          sessionID,
          childID,
          tool: spec.tool,
          operation: spec.operation,
          outcome: "warning",
          durationMs: Date.now() - start,
          data: spec.warningData?.(value),
        }
      : {
          level: spec.successLevel || "info",
          event: spec.successEvent,
          message: spec.successMessage,
          sessionID,
          childID,
          tool: spec.tool,
          operation: spec.operation,
          outcome: spec.successOutcome || "success",
          durationMs: Date.now() - start,
          data: spec.data?.(value),
        });
    return value;
  } catch (error) {
    await diagnostics.emit({
      level: "error",
      event: spec.failureEvent,
      message: spec.failureMessage,
      sessionID: typeof spec.sessionID === "function" ? undefined : spec.sessionID,
      childID: typeof spec.childID === "function" ? spec.childID(undefined) : spec.childID,
      tool: spec.tool,
      operation: spec.operation,
      outcome: "failure",
      durationMs: Date.now() - start,
      error,
      data: spec.failureData,
    });
    throw error;
  }
}

async function diagnosedTool(context, spec, fn) {
  return result(await withDiagnostics(context, spec, fn));
}

async function approveStartArgs(args, context) {
  const risks = collectStartRisks(args);
  if (!risks.length) return args;
  await requireParentApproval(context, "start", { risks, child: { id: args.id, hostname: args.hostname, trustMode: args.trustMode, projectDir: args.projectDir } });
  const approved = new Set([...(args._parentApprovedRisks || []), "high-risk-start"]);
  if (risks.some((risk) => risk.id === "external-dirs")) approved.add("external-dirs");
  if (risks.some((risk) => risk.id === "unsafe-safe-overrides")) approved.add("unsafe-safe-overrides");
  if (risks.some((risk) => risk.id === "unknown-config-keys")) approved.add("unknown-config-keys");
  if (risks.some((risk) => risk.id === "dangerous-env-overrides")) approved.add("dangerous-env-overrides");
  if (risks.some((risk) => risk.id === "config-permission-allow")) approved.add("config-permission-allow");
  return { ...args, _parentApprovedRisks: [...approved] };
}

// Build the plugin factory from an injected `tool` helper.
// `tool` is an identity function over a tool definition, and `tool.schema`
// is the zod schema builder (both supplied by the opencode plugin runtime).
export function createOpenCodeChildPlugin(tool) {
  const s = tool.schema;
  const timeoutMs = () => s.number().int().positive().max(MAX_TOOL_TIMEOUT_MS).optional();

  return async function OpenCodeChildPlugin(pluginContext) {
    return {
      // Release live child lifecycle state before dropping registry/notification
      // caches, otherwise a plugin reload can leave unmanageable child processes.
      dispose: async () => disposeModuleState(),
      event: async ({ event }) => {
        await Promise.all([...notificationManagers.values()].map((manager) => manager.handleParentEvent(event).catch(() => {})));
      },
      tool: {
        oc_child_start: tool({
          description: "Start a disposable child opencode serve process on localhost and inspect its registries.",
          args: {
            id: s.string().optional(), projectDir: s.string().optional(), configDir: s.string().optional(), port: s.number().int().positive().optional(), hostname: s.string().optional(),
            trustMode: s.enum(["inherit", "safe", "full-trust"]).optional(), dangerouslySkipPermissions: s.boolean().optional(), pure: s.boolean().optional(), inheritEnv: s.boolean().optional(), inheritGlobalConfig: s.boolean().optional(), inheritMcp: s.boolean().optional(),
            config: s.any().optional(), env: s.record(s.string(), s.string()).optional(), serverUsername: s.string().optional(), serverPassword: s.string().optional(), timeoutMs: timeoutMs(), cleanupPolicy: s.enum(["keep", "delete-on-stop"]).optional(), opencodeBin: s.string().optional(),
            dataDir: s.string().optional(), cacheDir: s.string().optional(), xdgStateDir: s.string().optional(), inheritData: s.boolean().optional(), maxConcurrent: s.number().int().positive().max(MAX_LIVE_CHILDREN_CEILING).optional(), allowNonLoopback: s.boolean().optional(), allowUnsafeSafeOverrides: s.boolean().optional(), allowUnknownConfigKeys: s.boolean().optional(), allowUnsafeEnvOverrides: s.boolean().optional(), allowUnsafeConfigPermissions: s.boolean().optional(), allowExternalDirs: s.boolean().optional(),
          },
          execute: boundedExecute("oc_child_start", async (args, context) => {
            const approved = await approveStartArgs(args, context);
            const registry = registryFor(context);
            const notifier = await notificationManagerFor(registry, pluginContext);
            return diagnosedTool(context, {
              tool: "oc_child_start",
              operation: "start_child",
              successEvent: "child_start_completed",
              failureEvent: "child_start_failed",
              successMessage: "Started child OpenCode server",
              failureMessage: "Failed to start child OpenCode server",
              childID: (value) => value?.id || approved.id,
              data: (value) => ({ trustMode: value?.trustMode || approved.trustMode, port: value?.port, cleanupPolicy: value?.cleanupPolicy || approved.cleanupPolicy }),
              warning: childStartRacedStop,
              warningEvent: "child_start_raced_stop",
              warningMessage: "Child start raced a concurrent stop/restart; returned child is not ready",
              warningData: (value) => ({ status: value?.status, expectedStop: value?.expectedStop }),
              failureData: diagnosticData(approved),
            }, () => startChild(registry, approved, context, notifier));
          }),
        }),
        oc_child_status: tool({
          description: "Inspect one or all child OpenCode processes, health, sessions, trust posture, and recent logs.",
          args: { childId: s.string().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_child_status", async (args, context) => {
            const registry = registryFor(context);
            await requireChildAccess(registry, context, args.childId, "status");
            return result(await statusChild(registry, args.childId, { ...args, signal: context.abort }));
          }),
        }),
        oc_child_stop: tool({
          description: "Stop a child OpenCode process by dispose request plus PID/process-group verification; use childId=all to stop all.",
          args: { childId: s.string(), confirmAll: s.boolean().optional(), timeoutMs: timeoutMs(), disposeTimeoutMs: timeoutMs(), kill: s.boolean().optional(), cleanup: s.boolean().optional(), includeStale: s.boolean().optional(), allowRegistryPidSignal: s.boolean().optional() },
          execute: boundedExecute("oc_child_stop", async (args, context) => {
            if ((!args.childId || args.childId === "all") && args.confirmAll !== true) throw new Error("oc_child_stop stopping all children requires confirmAll=true");
            if (args.allowRegistryPidSignal) await requireParentApproval(context, "stop.registry-pid-signal", { childId: args.childId });
            const registry = registryFor(context);
            const notifier = await notificationManagerFor(registry, pluginContext);
            return diagnosedTool(context, {
              tool: "oc_child_stop",
              operation: "stop_child",
              successEvent: "child_stop_completed",
              failureEvent: "child_stop_failed",
              successMessage: "Stopped child OpenCode server",
              failureMessage: "Failed to stop child OpenCode server",
              childID: args.childId,
              warning: (value) => Array.isArray(value) ? value.some((r) => r?.processAlive) : Boolean(value?.processAlive),
              warningEvent: "child_stop_warning",
              warningMessage: "Child process still alive after stop attempt",
              warningData: (value) => (Array.isArray(value) ? value : [value]).filter((r) => r?.processAlive).map((r) => ({ id: r.id, stopOutcome: r.stopOutcome })),
              data: () => ({ cleanup: args.cleanup, kill: args.kill }),
              failureData: { cleanup: args.cleanup, kill: args.kill },
            }, async () => {
              await requireChildAccess(registry, context, args.childId, "stop");
              return stopChild(registry, args.childId, { ...args, signal: context.abort }, notifier);
            });
          }),
        }),
        oc_child_restart: tool({
          description: "Restart a child OpenCode process with its saved spec and refreshed startup inspection.",
          args: { childId: s.string(), port: s.number().int().positive().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_child_restart", async (args, context) => {
            const registry = registryFor(context);
            if (typeof context?.ask !== "function") await requireParentApproval(context, "restart", { childId: args.childId, port: args.port });
            await requireChildAccess(registry, context, args.childId, "restart");
            const target = await registry.get(args.childId);
            await requireParentApproval(context, "restart", restartApprovalMetadata(target, args));
            const notifier = await notificationManagerFor(registry, pluginContext);
            return diagnosedTool(context, {
              tool: "oc_child_restart",
              operation: "restart_child",
              successEvent: "child_restart_completed",
              failureEvent: "child_restart_failed",
              successMessage: "Restarted child OpenCode server",
              failureMessage: "Failed to restart child OpenCode server",
              childID: args.childId,
              data: (value) => ({ port: value?.port || args.port }),
              failureData: { port: args.port },
            }, () => restartChild(registry, args.childId, { ...args, signal: context.abort }, context, notifier));
          }),
        }),
        oc_session_create: tool({
          description: "Create a session in a running child OpenCode server.",
          args: { childId: s.string(), title: s.string().optional(), parentID: s.string().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_session_create", async (args, context) => {
            const registry = registryFor(context);
            await requireChildAccess(registry, context, args.childId, "session.create");
            return result(await createSession(registry, args, { signal: context.abort }));
          }),
        }),
        oc_prompt: tool({
          description: "Send a bounded prompt to a child session, preferring prompt_async and polling inspection instead of hanging indefinitely.",
          args: { childId: s.string(), sessionId: s.string().optional(), title: s.string().optional(), text: s.string().optional(), parts: s.any().optional(), model: s.string().optional(), providerID: s.string().optional(), modelID: s.string().optional(), agent: s.string().optional(), system: s.string().optional(), tools: s.record(s.string(), s.boolean()).optional(), noReply: s.boolean().optional(), notify: s.boolean().optional(), async: s.boolean().optional(), timeoutMs: timeoutMs(), httpTimeoutMs: timeoutMs(), pollIntervalMs: timeoutMs(), settleGraceMs: timeoutMs() },
          execute: boundedExecute("oc_prompt", async (args, context) => {
            const registry = registryFor(context);
            const notifier = await notificationManagerFor(registry, pluginContext);
            return diagnosedTool(context, { tool: "oc_prompt", operation: "prompt_session", successEvent: "child_prompt_completed", failureEvent: "child_prompt_failed", successMessage: "Child prompt completed", failureMessage: "Child prompt failed", childID: args.childId, sessionID: (value) => value?.sessionId || args.sessionId, warning: (value) => Boolean(value?.diagnostic) || Boolean(value?.timedOut) || hasChildHttpFailure(value), warningEvent: "child_prompt_warning", warningMessage: "Child prompt returned diagnostic", warningData: (value) => promptWarningData(value, args), failureData: { async: args.async } }, async () => {
              await requireChildAccess(registry, context, args.childId, "prompt");
              return promptSession(registry, args, context, notifier);
            });
          }),
        }),
        oc_inspect: tool({
          description: "Aggregate child/session health, status, messages, diffs, todos, registries, and logs.",
          args: { childId: s.string(), sessionId: s.string().optional(), includeMessages: s.boolean().optional(), includeDiff: s.boolean().optional(), includeTools: s.boolean().optional(), includeLogs: s.boolean().optional(), includeEvents: s.boolean().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_inspect", async (args, context) => {
            const registry = registryFor(context);
            await requireChildAccess(registry, context, args.childId, "inspect");
            return result(await inspectSession(registry, args, { signal: context.abort }));
          }),
        }),
        oc_events: tool({
          description: "Return bounded best-effort SSE event history captured from a child OpenCode server.",
          args: { childId: s.string(), types: s.union([s.string(), s.array(s.string())]).optional(), since: s.number().int().nonnegative().optional(), limit: s.number().int().positive().max(200).optional() },
          execute: boundedExecute("oc_events", async (args, context) => {
            const registry = registryFor(context);
            await requireChildAccess(registry, context, args.childId, "events");
            return result(await eventsChild(registry, args.childId, args));
          }),
        }),
        oc_command: tool({
          description: "Execute a slash command through a child session endpoint with a bounded timeout.",
          args: { childId: s.string(), sessionId: s.string(), command: s.string(), arguments: s.string().optional(), agent: s.string().optional(), model: s.string().optional(), providerID: s.string().optional(), modelID: s.string().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_command", async (args, context) => {
            const registry = registryFor(context);
            await requireParentApproval(context, "command", { childId: args.childId, sessionId: args.sessionId, command: args.command, arguments: args.arguments });
            await requireChildAccess(registry, context, args.childId, "command");
            return diagnosedTool(context, { tool: "oc_command", operation: "command_session", successEvent: "child_command_completed", failureEvent: "child_command_failed", successMessage: "Child command completed", failureMessage: "Child command failed", childID: args.childId, sessionID: args.sessionId, warning: hasChildHttpFailure, warningEvent: "child_command_warning", warningMessage: "Child command returned child HTTP failure", warningData: (value) => ({ command: args.command, childHttpFailure: childHttpFailureData(value) }), failureData: { command: args.command } }, () => commandSession(registry, args, { signal: context.abort }));
          }),
        }),
        oc_shell: tool({
          description: "Run shell through a child OpenCode session endpoint so child permissions/hooks are exercised.",
          args: { childId: s.string(), sessionId: s.string(), command: s.string(), agent: s.string().optional(), model: s.string().optional(), providerID: s.string().optional(), modelID: s.string().optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_shell", async (args, context) => {
            const registry = registryFor(context);
            await requireParentApproval(context, "shell", { childId: args.childId, sessionId: args.sessionId, command: args.command });
            await requireChildAccess(registry, context, args.childId, "shell");
            return diagnosedTool(context, { tool: "oc_shell", operation: "shell_session", successEvent: "child_shell_completed", failureEvent: "child_shell_failed", successMessage: "Child shell completed", failureMessage: "Child shell failed", childID: args.childId, sessionID: args.sessionId, warning: hasChildHttpFailure, warningEvent: "child_shell_warning", warningMessage: "Child shell returned child HTTP failure", warningData: (value) => ({ command: args.command, childHttpFailure: childHttpFailureData(value) }) }, () => shellSession(registry, args, { signal: context.abort }));
          }),
        }),
        oc_permission: tool({
          description: "Respond to a pending child session permission request using once, always, or reject.",
          args: { childId: s.string(), sessionId: s.string(), permissionID: s.string(), response: s.enum(["once", "always", "reject"]), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_permission", async (args, context) => {
            const registry = registryFor(context);
            if (args.response !== "reject") await requireParentApproval(context, "permission", { childId: args.childId, sessionId: args.sessionId, permissionID: args.permissionID, response: args.response });
            await requireChildAccess(registry, context, args.childId, "permission");
            return diagnosedTool(context, { tool: "oc_permission", operation: "permission_session", successEvent: "child_permission_completed", failureEvent: "child_permission_failed", successMessage: "Child permission response completed", failureMessage: "Child permission response failed", childID: args.childId, sessionID: args.sessionId, warning: hasChildHttpFailure, warningEvent: "child_permission_warning", warningMessage: "Child permission response returned child HTTP failure", warningData: (value) => ({ response: args.response, childHttpFailure: childHttpFailureData(value) }), failureData: { response: args.response } }, () => permissionSession(registry, args, { signal: context.abort }));
          }),
        }),
        oc_plugin_smoke_test: tool({
          description: "Run a local child lifecycle smoke test for this plugin: start, inspect routes, create session, stop, and report evidence.",
          args: { projectDir: s.string().optional(), trustMode: s.enum(["inherit", "safe", "full-trust"]).optional(), timeoutMs: timeoutMs() },
          execute: boundedExecute("oc_plugin_smoke_test", async (args, context) => {
            return result(await runSmoke(args));
          }),
        }),
      },
    };
  };
}
