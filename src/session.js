import { ChildHttpClient, assertOk } from "./client.js";
import { canContactChildUrl, isPidAlive, modelFromParts, normalizeModel, scrubSecrets, sleep, summarizeList, textParts, throwIfAborted } from "./util.js";

function clientFor(child, timeoutMs) {
  if (!child?.baseUrl) throw new Error(`child ${child?.id || "<unknown>"} has no baseUrl`);
  try {
    new URL(child.baseUrl);
  } catch (error) {
    throw new Error(`malformed child baseUrl for ${child.id}: ${child.baseUrl}`, { cause: error });
  }
  if (!canContactChildUrl(child)) {
    throw new Error(`refusing to contact non-loopback child URL for ${child.id}: ${child.baseUrl}`);
  }
  return new ChildHttpClient(child.baseUrl, { ...(child.auth || {}), timeoutMs });
}

function scrubChildStoredValue(value, child, seen = new WeakSet()) {
  const secrets = [child?.auth?.password].filter(Boolean);
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubChildStoredValue(item, child, seen));
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) out[key] = scrubChildStoredValue(item, child, seen);
  return out;
}

export async function createSession(registry, args = {}, options = {}) {
  throwIfAborted(options.signal);
  const child = await registry.get(args.childId);
  const client = clientFor(child, args.timeoutMs ?? 15000);
  const body = {};
  if (args.title) body.title = args.title;
  if (args.parentID) body.parentID = args.parentID;
  const response = await client.post("/session", body, { signal: options.signal });
  throwIfAborted(options.signal);
  const session = assertOk(response, "create session");
  if (!session || typeof session !== "object" || !session.id) {
    throw new Error(`create session: child returned an unexpected response body: ${scrubSecrets(JSON.stringify(session), [child?.auth?.password].filter(Boolean))}`);
  }
  return { childId: child.id, sessionId: session.id, session };
}

export async function inspectSession(registry, args = {}, options = {}) {
  throwIfAborted(options.signal);
  const child = await registry.get(args.childId);
  const client = clientFor(child, args.timeoutMs ?? 15000);
  const alive = isPidAlive(child.pid);
  const dead = { ok: false, error: "process is not alive" };
  const out = {
    childId: child.id,
    child: { id: child.id, status: child.status, pid: child.pid, baseUrl: child.baseUrl, trustMode: child.trustMode, processAlive: alive, auth: child.auth },
    logs: args.includeLogs === false ? undefined : scrubChildStoredValue(child.logs, child),
    events: args.includeEvents === false ? undefined : scrubChildStoredValue((child.events || []).slice(-50), child),
  };
  const [health, sessionStatus, sessions, commands, agents, mcp, tools] = alive ? await Promise.all([
    client.get("/global/health", { signal: options.signal }),
    client.get("/session/status", { signal: options.signal }),
    client.get("/session", { signal: options.signal }),
    client.get("/command", { signal: options.signal }),
    client.get("/agent", { signal: options.signal }),
    client.get("/mcp", { signal: options.signal }),
    args.includeTools === false ? Promise.resolve({ ok: false }) : client.get("/experimental/tool/ids", { signal: options.signal }),
  ]) : [dead, dead, dead, dead, dead, dead, dead];
  throwIfAborted(options.signal);
  out.health = health.ok ? health.data : { error: health.error };
  out.sessionStatus = sessionStatus.ok ? sessionStatus.data : { error: sessionStatus.error };
  out.sessions = sessions.ok ? summarizeList(sessions.data, 10) : { error: sessions.error };
  out.registries = {
    commands: commands.ok ? summarizeList(commands.data, 20) : { error: commands.error },
    agents: agents.ok ? summarizeList(agents.data, 20) : { error: agents.error },
    mcp: mcp.ok ? summarizeList(mcp.data, 20) : { error: mcp.error },
    tools: tools.ok ? summarizeList(tools.data, 40) : { error: tools.error },
  };
  if (args.sessionId) {
    const prefix = `/session/${encodeURIComponent(args.sessionId)}`;
    const [session, children, todo, messages, diff] = alive ? await Promise.all([
      client.get(prefix, { signal: options.signal }),
      client.get(`${prefix}/children`, { signal: options.signal }),
      client.get(`${prefix}/todo`, { signal: options.signal }),
      args.includeMessages === false ? Promise.resolve({ ok: false }) : client.get(`${prefix}/message`, { signal: options.signal }),
      args.includeDiff === false ? Promise.resolve({ ok: false }) : client.get(`${prefix}/diff`, { signal: options.signal }),
    ]) : [dead, dead, dead, dead, dead];
    throwIfAborted(options.signal);
    out.session = session.ok ? session.data : { error: session.error };
    out.children = children.ok ? children.data : { error: children.error };
    out.todo = todo.ok ? todo.data : { error: todo.error };
    out.messages = messages.ok ? messages.data : { error: messages.error };
    out.diff = diff.ok ? diff.data : { error: diff.error };
  }
  return out;
}

function targetSessionRunning(statusData, sessionId) {
  if (!statusData || typeof statusData !== "object") return false;
  const isRunningStatus = (value) => {
    if (!value) return false;
    if (typeof value === "string") return ["busy", "running", "retry"].includes(value);
    if (value.type) return ["busy", "running", "retry"].includes(value.type);
    if (value.status) return ["busy", "running", "retry"].includes(value.status);
    return false;
  };
  if (Object.hasOwn(statusData, sessionId)) return isRunningStatus(statusData[sessionId]);
  return Object.values(statusData).some((value) => {
    const matches = value?.sessionID === sessionId || value?.sessionId === sessionId || value?.id === sessionId || value?.session?.id === sessionId;
    return matches && (isRunningStatus(value) || isRunningStatus(value?.session));
  });
}

const PROVIDER_MODEL_NOT_FOUND_RE = /ProviderModelNotFoundError|Model not found/i;

export const AUTH_ISOLATION_DIAGNOSTIC = "Provider/model lookup failed while this child uses isolated data/cache/state (inheritData:false). The child may lack OpenCode auth-file provider state; retry with inheritData:true only when real auth-file storage is needed and explicitly approved.";

function hasProviderModelNotFoundEvidence(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (PROVIDER_MODEL_NOT_FOUND_RE.test(text)) return true;
  }
  return false;
}

function authIsolationDiagnostic(child, ...evidence) {
  if (child?.inheritData !== false) return undefined;
  return hasProviderModelNotFoundEvidence(...evidence) ? AUTH_ISOLATION_DIAGNOSTIC : undefined;
}

function withAuthIsolationDiagnostic(result, child, ...evidence) {
  const diagnostic = authIsolationDiagnostic(child, ...evidence);
  return diagnostic ? { ...result, diagnostic } : result;
}

function modelString(model) {
  return model ? `${model.providerID}/${model.modelID}` : undefined;
}

async function promptInspection(registry, child, sessionId, args) {
  return await inspectSession(registry, { childId: child.id, sessionId, includeLogs: true, timeoutMs: args.httpTimeoutMs ?? 5000 }, { signal: args.signal });
}

async function pollUntilSettled(registry, child, client, sessionId, args = {}, notifier, watch) {
  const started = Date.now();
  let observedRunning = false;
  while (Date.now() - started < (args.timeoutMs ?? 30000)) {
    throwIfAborted(args.signal);
    const status = await client.get("/session/status", { timeoutMs: 2500, signal: args.signal });
    throwIfAborted(args.signal);
    const running = status.ok && targetSessionRunning(status.data, sessionId);
    if (running) observedRunning = true;
    if (status.ok && !running && (observedRunning || Date.now() - started >= (args.settleGraceMs ?? 1500))) {
      const inspection = await promptInspection(registry, child, sessionId, args);
      if (watch) await notifier?.handlePromptSettled(child, sessionId).catch(() => {});
      return { timedOut: false, inspection };
    }
    await sleep(args.pollIntervalMs ?? 1000, { signal: args.signal });
  }
  const inspection = await promptInspection(registry, child, sessionId, args);
  return { timedOut: true, inspection, note: "prompt_async accepted but polling timed out; use oc_inspect or oc_child_stop for follow-up" };
}

export async function promptSession(registry, args = {}, context = {}, notifier) {
  const signal = context.abort || args.signal;
  throwIfAborted(signal);
  const child = await registry.get(args.childId);
  const sessionId = args.sessionId || (await createSession(registry, { childId: args.childId, title: args.title || "child prompt", timeoutMs: args.httpTimeoutMs ?? args.timeoutMs ?? 5000 }, { signal })).sessionId;
  const client = clientFor(child, args.httpTimeoutMs ?? 5000);
  const requestArgs = { ...args, signal };
  const model = normalizeModel(args.model || modelFromParts(args.providerID, args.modelID));
  const body = {
    parts: textParts(args.text, args.parts),
    ...(model ? { model } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    ...(args.system ? { system: args.system } : {}),
    ...(args.tools ? { tools: args.tools } : {}),
    ...(args.noReply !== undefined ? { noReply: args.noReply } : {}),
  };

  if (args.async !== false) {
    const accepted = await client.post(`/session/${encodeURIComponent(sessionId)}/prompt_async`, body, { timeoutMs: args.httpTimeoutMs ?? 5000, signal });
    throwIfAborted(signal);
    if (!accepted.ok) {
      const inspection = await promptInspection(registry, child, sessionId, requestArgs);
      return withAuthIsolationDiagnostic({ childId: child.id, sessionId, accepted, timedOut: false, inspection }, child, accepted, inspection);
    }
    const watch = notifier?.registerPromptWatch(child.id, sessionId, context, { notify: args.notify, noReply: args.noReply });
    const settled = await pollUntilSettled(registry, child, client, sessionId, requestArgs, notifier, watch);
    return withAuthIsolationDiagnostic({ childId: child.id, sessionId, accepted, ...settled }, child, settled.inspection);
  }

  const response = await client.post(`/session/${encodeURIComponent(sessionId)}/message`, body, { timeoutMs: args.timeoutMs ?? 30000, signal });
  throwIfAborted(signal);
  return withAuthIsolationDiagnostic({ childId: child.id, sessionId, response }, child, response);
}

export async function commandSession(registry, args = {}, options = {}) {
  throwIfAborted(options.signal);
  const child = await registry.get(args.childId);
  const client = clientFor(child, args.timeoutMs ?? 30000);
  const body = { command: args.command, arguments: args.arguments || "" };
  if (args.agent) body.agent = args.agent;
  const model = normalizeModel(args.model || modelFromParts(args.providerID, args.modelID));
  if (model) body.model = modelString(model);
  const response = await client.post(`/session/${encodeURIComponent(args.sessionId)}/command`, body, { timeoutMs: args.timeoutMs ?? 30000, signal: options.signal });
  throwIfAborted(options.signal);
  return response;
}

export async function shellSession(registry, args = {}, options = {}) {
  throwIfAborted(options.signal);
  const child = await registry.get(args.childId);
  const client = clientFor(child, args.timeoutMs ?? 30000);
  const body = { command: args.command, agent: args.agent || "build" };
  const model = normalizeModel(args.model || modelFromParts(args.providerID, args.modelID));
  if (model) body.model = model;
  const response = await client.post(`/session/${encodeURIComponent(args.sessionId)}/shell`, body, { timeoutMs: args.timeoutMs ?? 30000, signal: options.signal });
  throwIfAborted(options.signal);
  return response;
}

export async function permissionSession(registry, args = {}, options = {}) {
  throwIfAborted(options.signal);
  const child = await registry.get(args.childId);
  const client = clientFor(child, args.timeoutMs ?? 15000);
  const requestTimeoutMs = args.timeoutMs ?? 5000;
  const documented = await client.post(
    `/session/${encodeURIComponent(args.sessionId)}/permissions/${encodeURIComponent(args.permissionID)}`,
    { response: args.response },
    { timeoutMs: requestTimeoutMs, signal: options.signal },
  );
  throwIfAborted(options.signal);
  if (documented.ok) return documented;

  const observed = await client.post(
    `/permission/${encodeURIComponent(args.permissionID)}/reply`,
    { reply: args.response },
    { timeoutMs: requestTimeoutMs, signal: options.signal },
  );
  throwIfAborted(options.signal);
  return observed.ok ? observed : documented;
}

export const _test = { authIsolationDiagnostic, hasProviderModelNotFoundEvidence, pollUntilSettled, targetSessionRunning };
