import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildRegistry } from "./registry.js";
import { ChildHttpClient } from "./client.js";
import { startChild, statusChild, stopChild } from "./lifecycle.js";
import { createSession, inspectSession } from "./session.js";
import { ROUTE_COMPATIBILITY, formatRoute } from "./routes.js";
import { publicRedact, safeRmDir } from "./util.js";

export const DEFAULT_PLUGIN_PATH = path.resolve(import.meta.dirname, "../opencode-child.js");
export const EXPECTED_OPENCODE_CHILD_TOOLS = Object.freeze([
  "oc_child_start",
  "oc_child_status",
  "oc_child_stop",
  "oc_child_restart",
  "oc_session_create",
  "oc_prompt",
  "oc_inspect",
  "oc_events",
  "oc_command",
  "oc_shell",
  "oc_permission",
  "oc_plugin_smoke_test",
]);

export function redactSmokeResult(result) {
  return publicRedact(result);
}

function toolIdsFromSummary(summary = {}) {
  if (Array.isArray(summary)) return summary;
  if (Array.isArray(summary.sample)) return summary.sample;
  if (Array.isArray(summary.keys)) return summary.keys;
  return [];
}

function compactSummary(summary = {}) {
  if (!summary || typeof summary !== "object") return summary;
  const items = Array.isArray(summary.sample) ? summary.sample : summary.keys;
  const sample = Array.isArray(items)
    ? items.slice(0, 12).map((item) => {
        if (typeof item === "string") return item;
        return item?.id || item?.name || item?.type || JSON.stringify(item).slice(0, 160);
      })
    : undefined;
  return { count: summary.count, ...(sample ? { sample } : {}) };
}

function compactLogs(logs = {}) {
  if (!logs || typeof logs !== "object") return undefined;
  const stdout = typeof logs.stdout === "string" ? logs.stdout.slice(-4000) : undefined;
  const stderr = typeof logs.stderr === "string" ? logs.stderr.slice(-4000) : undefined;
  return {
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

function compatibilitySummary(capabilities = {}) {
  const probed = ROUTE_COMPATIBILITY.filter((entry) => entry.probe);
  const failures = probed
    .map((entry) => ({ entry, response: capabilities[entry.path] }))
    .filter(({ response }) => !response?.ok)
    .map(({ entry, response }) => ({
      route: formatRoute(entry),
      category: entry.category,
      status: response?.status,
      error: response?.error || "not probed",
    }));
  const requiredRouteFailures = failures.filter((failure) => failure.category === "required-startup");
  const optionalRouteFailures = failures.filter((failure) => failure.category !== "required-startup");
  return {
    requiredRoutesOk: requiredRouteFailures.length === 0,
    requiredRouteFailures,
    optionalRouteFailures,
  };
}

function failureSmokeResult({ phase, error, child, pluginPath, expectedTools = [], safeModeNegative }) {
  const message = error?.message || String(error);
  const routeCompatibility = compatibilitySummary(child?.capabilities);
  return {
    ok: false,
    phase,
    error: message,
    lifecycleOk: false,
    requiredRoutesOk: routeCompatibility.requiredRoutesOk,
    requiredRouteFailures: routeCompatibility.requiredRouteFailures,
    optionalRouteFailures: routeCompatibility.optionalRouteFailures,
    toolsOk: false,
    safetyOk: Boolean(safeModeNegative?.ok),
    childId: child?.id,
    pid: child?.pid,
    port: child?.port,
    health: child?.health,
    lifecycle: {
      childStarted: Boolean(child?.id),
      healthOk: Boolean(child?.health && !child.health.error),
      sessionCreated: false,
      inspectionOk: false,
      stopped: false,
    },
    routeCompatibility,
    pluginPath,
    commands: compactSummary(child?.startupInspection?.commands),
    agents: compactSummary(child?.startupInspection?.agents),
    tools: compactSummary(child?.startupInspection?.tools),
    toolRegistration: {
      ok: false,
      skipped: true,
      error: `skipped after ${phase} failure: ${message}`,
      registeredTools: [],
      expectedTools,
      missingTools: expectedTools,
    },
    registeredTools: [],
    expectedTools,
    missingTools: expectedTools,
    safeModeNegative,
  };
}

async function runSafeModeNegativeCheck(registry, projectDir) {
  try {
    const child = await startChild(registry, {
      id: "opencode_child_smoke_safe_negative",
      trustMode: "safe",
      config: { plugin: ["@example/remote-plugin"] },
      timeoutMs: 1,
    }, { directory: projectDir });
    await stopChild(registry, child.id, { cleanup: true, includeStale: true, allowRegistryPidSignal: true }).catch(() => {});
    return { ok: false, error: "unsafe safe-mode plugin override was accepted" };
  } catch (error) {
    const message = error?.message || String(error);
    return {
      ok: /unsafe safe-mode overrides rejected/.test(message),
      error: /unsafe safe-mode overrides rejected/.test(message) ? undefined : message,
    };
  }
}

async function runToolRegistrationCheck(registry, options = {}) {
  const { expectedTools = [], pluginPath, projectDir } = options;
  if (!expectedTools.length) return { ok: true, skipped: true, registeredTools: [], missingTools: [] };
  if (!pluginPath) return { ok: false, error: "pluginPath is required for expected tool registration checks", registeredTools: [], missingTools: expectedTools };

  let child;
  try {
    child = await startChild(registry, {
      trustMode: options.trustMode || "inherit",
      projectDir,
      timeoutMs: options.timeoutMs ?? 15000,
      cleanupPolicy: "delete-on-stop",
      config: { plugin: [pluginPath] },
      env: options.env || {},
    }, { directory: projectDir });
    const client = new ChildHttpClient(child.baseUrl, { ...(child.auth || {}), timeoutMs: options.timeoutMs ?? 15000 });
    const fullTools = await client.get("/experimental/tool/ids", { timeoutMs: options.timeoutMs ?? 15000 });
    const registeredTools = fullTools.ok && Array.isArray(fullTools.data)
      ? [...new Set(fullTools.data)]
      : toolIdsFromSummary(child.startupInspection?.tools);
    const toolSet = new Set(registeredTools);
    const missingTools = expectedTools.filter((tool) => !toolSet.has(tool));
    return {
      ok: missingTools.length === 0,
      trustMode: child.trustMode,
      childId: child.id,
      registeredTools,
      expectedTools,
      missingTools,
      config: child.startupInspection?.configSummary,
      tools: compactSummary(child.startupInspection?.tools),
      logs: compactLogs(child.logs),
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      childId: child?.id,
      config: child?.startupInspection?.configSummary,
      tools: compactSummary(child?.startupInspection?.tools),
      logs: compactLogs(child?.logs),
      registeredTools: [],
      expectedTools,
      missingTools: expectedTools,
    };
  } finally {
    if (child) await stopChild(registry, child.id, { cleanup: true }).catch(() => {});
  }
}

export async function runSmoke(options = {}) {
  const stateDir = options.stateDir || await mkdtemp(path.join(tmpdir(), "opencode-child-state-"));
  const projectDir = options.projectDir || await mkdtemp(path.join(tmpdir(), "opencode-child-project-"));
  const registry = new ChildRegistry(stateDir);
  let child;
  let phase = "setup";
  let pluginPath;
  let expectedTools = [];
  let safeModeNegative;
  const cleanupState = !options.stateDir;
  const cleanupProject = !options.projectDir;
  try {
    pluginPath = options.pluginPath === false ? undefined : (options.pluginPath || DEFAULT_PLUGIN_PATH);
    expectedTools = options.expectedTools || (pluginPath ? EXPECTED_OPENCODE_CHILD_TOOLS : []);
    phase = "safe-mode-negative";
    safeModeNegative = options.safeModeNegative === false
      ? { ok: true, skipped: true }
      : await runSafeModeNegativeCheck(registry, projectDir);
    phase = "start";
    child = await startChild(registry, { trustMode: options.trustMode || "safe", projectDir, timeoutMs: options.timeoutMs ?? 15000, cleanupPolicy: "delete-on-stop", env: options.env || {} }, { directory: projectDir });
    phase = "status";
    const status = await statusChild(registry, child.id);
    phase = "session";
    const session = await createSession(registry, { childId: child.id, title: "opencode-child smoke" });
    phase = "inspection";
    const inspection = await inspectSession(registry, { childId: child.id, sessionId: session.sessionId, includeLogs: false });
    phase = "stop";
    const stop = await stopChild(registry, child.id, { cleanup: true });
    phase = "tool-registration";
    const toolRegistration = await runToolRegistrationCheck(registry, {
      pluginPath,
      expectedTools,
      projectDir,
      trustMode: options.toolTrustMode || "inherit",
      timeoutMs: options.timeoutMs,
      env: options.env,
    });
    const lifecycle = {
      childStarted: Boolean(child?.id),
      healthOk: Boolean(status?.liveHealth && !status.liveHealth.error),
      sessionCreated: Boolean(session?.sessionId),
      inspectionOk: Boolean(inspection?.health && !inspection.health.error),
      stopped: Boolean(stop?.stopped),
    };
    const lifecycleOk = Object.values(lifecycle).every(Boolean);
    const routeCompatibility = compatibilitySummary(child.capabilities);
    const toolIds = toolRegistration.registeredTools || [];
    const missingTools = toolRegistration.missingTools || [];
    const toolsOk = toolRegistration.ok;
    const requiredRoutesOk = routeCompatibility.requiredRoutesOk;
    const safetyOk = safeModeNegative.ok;
    return {
      ok: lifecycleOk && requiredRoutesOk && toolsOk && safetyOk,
      lifecycleOk,
      requiredRoutesOk,
      requiredRouteFailures: routeCompatibility.requiredRouteFailures,
      optionalRouteFailures: routeCompatibility.optionalRouteFailures,
      toolsOk,
      safetyOk,
      childId: child.id,
      pid: child.pid,
      port: child.port,
      health: status.liveHealth,
      lifecycle,
      routeCompatibility,
      pluginPath,
      commands: compactSummary(status.startupInspection?.commands),
      agents: compactSummary(status.startupInspection?.agents),
      tools: compactSummary(status.startupInspection?.tools),
      toolRegistration,
      registeredTools: toolIds,
      sessionId: session.sessionId,
      expectedTools,
      missingTools,
      safeModeNegative,
      inspection: { health: inspection.health, todoCount: Array.isArray(inspection.todo) ? inspection.todo.length : undefined, messageCount: Array.isArray(inspection.messages) ? inspection.messages.length : undefined },
      stop: { stopped: stop.stopped, processAlive: stop.processAlive, disposeStatus: stop.dispose?.status },
    };
  } catch (error) {
    return failureSmokeResult({ phase, error, child, pluginPath, expectedTools, safeModeNegative });
  } finally {
    if (child) await stopChild(registry, child.id, { cleanup: true }).catch(() => {});
    if (cleanupState) await safeRmDir(stateDir).catch(() => {});
    if (cleanupProject) await safeRmDir(projectDir).catch(() => {});
  }
}
