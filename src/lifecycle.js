import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { ChildHttpClient } from "./client.js";
import { startEventTail } from "./lifecycle/events.js";
import { collectStartRisks, effectiveOpencodeBin, safeEnv, safePermissionBaseline, validateStartArgs, validateStartPreflight } from "./lifecycle/risk.js";
import { normalizeChildEvent } from "./notifications.js";
import { TERMINAL_STATUSES } from "./registry.js";
import { assertRequiredStartupRoutes } from "./routes.js";
import { canContactChildUrl, childId, childOwnerFromContext, isLoopbackHostname, isPidAlive, nowIso, randomPassword, resolveSandboxRoots, safeRmDir, scrubSecrets, signalProcessGroup, sleep, summarizeList, throwIfAborted } from "./util.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
export const MAX_TOOL_TIMEOUT_MS = 120000;
export const MAX_LIVE_CHILDREN_CEILING = 32;
const SIGNAL_EXIT_WATCHDOG_MS = 5000;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };
const LOG_LIMIT = 12000;
const TCP_LISTEN_STATE = "0A";
const PUBLIC_ERROR_TEXT_LIMIT = 1000;

const liveProcesses = new Map();
const eventReaders = new Map();
const lifecycleQueues = new Map();
const startupQueues = new Map();
const processExitCompletions = new Map();
const signalExitWatchdogs = new Map();

// Namespace every lifecycle-map key by the registry's state dir. Child-id
// uniqueness is enforced only per-registry (per project), so one long-lived plugin
// instance managing several projects can legitimately hold two children with the
// same id (e.g. "worker"). Keying these module-level maps by the bare id would let
// the second start silently overwrite the first's liveProcesses/eventReaders/
// lifecycleQueues entry, aborting its event tail or clobbering its live handle.
export function lifecycleKey(registry, id) {
  return `${registry?.stateDir}::${id}`;
}

// Count live children owned by THIS registry only. The concurrency cap
// (resolveMaxLive / OPENCODE_CHILD_MAX_LIVE) is a per-project valve — the reject
// message tells the caller to stop children "for this project". Because
// liveProcesses is a single module-level map shared by every project/registry,
// counting its whole size would let children started for one project (state dir)
// exhaust the cap for a disjoint project. Scope the count to entries whose key
// belongs to this registry's state dir (keys are `${stateDir}::${id}`), so each
// project gets its own independent counter.
function countLiveForRegistry(registry, processes = liveProcesses) {
  const prefix = `${registry?.stateDir}::`;
  let liveCount = 0;
  for (const [key, proc] of processes) {
    if (key.startsWith(prefix) && isPidAlive(proc.pid)) liveCount += 1;
  }
  return liveCount;
}

function combineAbortSignals(...signals) {
  const active = signals.filter(Boolean);
  if (active.length <= 1) return { signal: active[0], cleanup: () => {} };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(active), cleanup: () => {} };
  const controller = new AbortController();
  const abort = (event) => controller.abort(event?.target?.reason);
  for (const signal of active) signal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of active) signal.removeEventListener("abort", abort);
    },
  };
}

async function withChildLifecycle(key, fn) {
  const previous = lifecycleQueues.get(key) || Promise.resolve();
  const run = previous.then(fn, fn);
  const tracked = run.catch(() => {});
  lifecycleQueues.set(key, tracked);
  try {
    return await run;
  } finally {
    if (lifecycleQueues.get(key) === tracked) lifecycleQueues.delete(key);
  }
}

// Resolve the live-children cap. A non-numeric env value (e.g. "unlimited") must
// NOT silently disable the cap via NaN; fall back to 8. An explicit caller override
// (schema-validated positive int) wins when present, but never above the hard
// process ceiling.
export function resolveMaxLive(rawEnv, override) {
  if (override !== undefined && override !== null) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return Math.min(n, MAX_LIVE_CHILDREN_CEILING);
  }
  const envNum = Number(rawEnv);
  return Number.isFinite(envNum) && envNum > 0 ? Math.min(envNum, MAX_LIVE_CHILDREN_CEILING) : 8;
}

export function resolveStartupTimeout(rawTimeoutMs) {
  const timeoutMs = rawTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const n = Number(timeoutMs);
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TOOL_TIMEOUT_MS) : DEFAULT_STARTUP_TIMEOUT_MS;
}

async function enqueueStart(registry, args = {}, context = {}, notifier) {
  const key = registry.stateDir;
  const previous = startupQueues.get(key) || Promise.resolve();
  const run = previous.then(() => startChildUnlocked(registry, args, context, notifier), () => startChildUnlocked(registry, args, context, notifier));
  const tracked = run.catch(() => {});
  startupQueues.set(key, tracked);
  try {
    return await run;
  } finally {
    if (startupQueues.get(key) === tracked) startupQueues.delete(key);
  }
}

// SIGTERM every process group, wait a bounded grace window (polling liveness),
// then SIGKILL only the survivors — instead of SIGTERM+SIGKILL back-to-back, which
// denied children any chance at graceful shutdown. Signal/liveness/sleep are
// injectable for testing.
export async function gracefulTerminate(pids, options = {}) {
  const { graceMs = 700, signal = signalProcessGroup, alive = isPidAlive, sleepFn = sleep } = options;
  const targets = [...pids].filter(Boolean);
  for (const pid of targets) signal(pid, "SIGTERM");
  const started = Date.now();
  while (Date.now() - started < graceMs && targets.some((pid) => alive(pid))) {
    await sleepFn(Math.min(100, graceMs));
  }
  const killed = [];
  for (const pid of targets) {
    if (alive(pid)) { signal(pid, "SIGKILL"); killed.push(pid); }
  }
  return { killed };
}

let exitHandlersInstalled = false;
function killAllSync(options = {}) {
  const processes = options.processes || liveProcesses;
  const kill = options.kill || process.kill.bind(process);
  for (const proc of processes.values()) {
    try { kill(-proc.pid, "SIGTERM"); } catch { try { kill(proc.pid, "SIGTERM"); } catch {} }
  }
  for (const proc of processes.values()) {
    try { kill(-proc.pid, "SIGKILL"); } catch {}
  }
}

function armSignalExitWatchdog(sig, options = {}) {
  const watchdogs = options.watchdogs || signalExitWatchdogs;
  if (watchdogs.has(sig)) return watchdogs.get(sig);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const exitFn = options.exitFn || process.exit.bind(process);
  const timer = setTimeoutFn(() => exitFn(SIGNAL_EXIT_CODES[sig] || 128), options.watchdogMs ?? SIGNAL_EXIT_WATCHDOG_MS);
  timer?.unref?.();
  watchdogs.set(sig, timer);
  return timer;
}

async function handleExitSignal(sig, handler, options = {}) {
  const processes = options.processes || liveProcesses;
  const proc = options.process || process;
  const terminateFn = options.terminateFn || gracefulTerminate;
  const pids = [...processes.values()].map((childProc) => childProc.pid).filter(Boolean);
  await terminateFn(pids).catch(() => {});
  // Re-raise default behavior only if we are the lone listener, so we never
  // swallow OpenCode's own graceful-shutdown handling.
  if (proc.listenerCount(sig) <= 1) {
    proc.removeListener(sig, handler);
    proc.kill(proc.pid, sig);
    return { reraised: true, pids };
  }
  // If another listener also defers instead of exiting, do not let the original
  // SIGINT/SIGTERM disappear forever.
  armSignalExitWatchdog(sig, options);
  return { reraised: false, pids };
}

function installExitHandlers() {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  // Last-resort SYNC kill for the 'exit' event, where no async/await is possible.
  const onSigint = () => { handleExitSignal("SIGINT", onSigint).catch(() => {}); };
  const onSigterm = () => { handleExitSignal("SIGTERM", onSigterm).catch(() => {}); };
  process.on("exit", killAllSync); // sync only: signals, never async fs work
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function appendLog(child, stream, chunk) {
  // redact() is key-based and never reaches freeform log text, so scrub secret
  // VALUES (incl. the child's own generated auth password) at capture time.
  const text = scrubSecrets(chunk.toString(), [child.auth?.password]);
  child.logs ||= { stdout: "", stderr: "" };
  child.logs[stream] = `${child.logs[stream] || ""}${text}`.slice(-LOG_LIMIT);
}

function sanitizedRestartSpec(args, values) {
  const spec = {
    id: values.id,
    projectDir: values.projectDir,
    configDir: values.configDir,
    dataDir: values.dataDir,
    cacheDir: values.cacheDir,
    xdgStateDir: values.xdgStateDir,
    managedDirs: values.managedDirs,
    inheritData: values.inheritData,
    port: values.port,
    hostname: values.hostname,
    cleanupPolicy: values.cleanupPolicy,
    trustMode: values.trustMode,
    pure: Boolean(args.pure),
    dangerouslySkipPermissions: Boolean(args.dangerouslySkipPermissions),
    allowNonLoopback: Boolean(args.allowNonLoopback),
    allowUnsafeSafeOverrides: Boolean(args.allowUnsafeSafeOverrides),
    allowUnknownConfigKeys: Boolean(args.allowUnknownConfigKeys),
    allowUnsafeEnvOverrides: Boolean(args.allowUnsafeEnvOverrides),
    allowUnsafeConfigPermissions: Boolean(args.allowUnsafeConfigPermissions),
    hadCustomConfig: Boolean(args.config && Object.keys(args.config).length),
    hadCustomEnv: Boolean(args.env && Object.keys(args.env).length),
  };
  if (args.opencodeBin) spec.opencodeBin = args.opencodeBin;
  return spec;
}

export { collectStartRisks };

function restartRiskApprovals(spec) {
  const risks = collectStartRisks(spec);
  const approved = new Set();
  if (risks.length) approved.add("high-risk-start");
  if (risks.some((risk) => risk.id === "external-dirs")) approved.add("external-dirs");
  if (risks.some((risk) => risk.id === "unsafe-safe-overrides")) approved.add("unsafe-safe-overrides");
  if (risks.some((risk) => risk.id === "unknown-config-keys")) approved.add("unknown-config-keys");
  if (risks.some((risk) => risk.id === "dangerous-env-overrides")) approved.add("dangerous-env-overrides");
  if (risks.some((risk) => risk.id === "config-permission-allow")) approved.add("config-permission-allow");
  return { risks, approved: [...approved] };
}

function buildRestartSpec(old, args = {}) {
  const saved = old.spec || {};
  const hadCustomConfig = Boolean(saved.hadCustomConfig || saved.config !== undefined);
  const hadCustomEnv = Boolean(saved.hadCustomEnv || saved.env !== undefined);
  const spec = {
    projectDir: saved.projectDir || old.projectDir,
    hostname: saved.hostname || old.hostname,
    trustMode: saved.trustMode || old.trustMode,
    pure: Boolean(saved.pure),
    dangerouslySkipPermissions: Boolean(saved.dangerouslySkipPermissions),
    allowNonLoopback: Boolean(saved.allowNonLoopback),
    allowUnsafeSafeOverrides: Boolean(saved.allowUnsafeSafeOverrides),
    allowUnknownConfigKeys: Boolean(saved.allowUnknownConfigKeys),
    allowUnsafeEnvOverrides: Boolean(saved.allowUnsafeEnvOverrides),
    allowUnsafeConfigPermissions: Boolean(saved.allowUnsafeConfigPermissions),
    ...(saved.opencodeBin ? { opencodeBin: saved.opencodeBin } : {}),
    ...args,
    id: args.id || old.id,
    port: args.port || old.port,
    configDir: old.configDir,
    dataDir: old.dataDir, cacheDir: old.cacheDir, xdgStateDir: old.xdgStateDir,
    inheritData: old.inheritData, managedDirs: old.managedDirs || [], cleanupPolicy: old.cleanupPolicy,
    config: args.config ?? {},
    env: args.env ?? {},
    _restartDropped: [hadCustomConfig ? "custom config" : undefined, hadCustomEnv ? "custom environment overrides" : undefined].filter(Boolean),
    _allowExistingId: true,
  };
  delete spec.pid;
  const approvals = restartRiskApprovals(spec).approved;
  if (approvals.length) spec._parentApprovedRisks = approvals;
  if (approvals.includes("external-dirs")) spec.allowExternalDirs = true;
  if (approvals.includes("unknown-config-keys")) spec.allowUnknownConfigKeys = true;
  if (approvals.includes("dangerous-env-overrides")) spec.allowUnsafeEnvOverrides = true;
  if (approvals.includes("config-permission-allow")) spec.allowUnsafeConfigPermissions = true;
  return spec;
}

export function restartApprovalMetadata(old, args = {}) {
  const spec = buildRestartSpec(old, args);
  const { risks } = restartRiskApprovals(spec);
  return {
    childId: old.id,
    requestedPort: args.port,
    restart: {
      trustMode: spec.trustMode,
      hostname: spec.hostname || "127.0.0.1",
      nonLoopback: !isLoopbackHostname(spec.hostname || "127.0.0.1"),
      externalDirs: {
        configDir: spec.configDir,
        dataDir: spec.dataDir,
        cacheDir: spec.cacheDir,
        xdgStateDir: spec.xdgStateDir,
        managedDirs: spec.managedDirs || [],
      },
      customBinary: spec.opencodeBin,
      inheritData: Boolean(spec.inheritData),
      allowUnsafeSafeOverrides: Boolean(spec.allowUnsafeSafeOverrides),
      allowUnknownConfigKeys: Boolean(spec.allowUnknownConfigKeys),
      allowUnsafeEnvOverrides: Boolean(spec.allowUnsafeEnvOverrides),
      allowUnsafeConfigPermissions: Boolean(spec.allowUnsafeConfigPermissions),
      unsafeSafeOverrideRisk: risks.some((risk) => risk.id === "unsafe-safe-overrides"),
      unknownConfigKeyRisk: risks.some((risk) => risk.id === "unknown-config-keys"),
      dangerousEnvOverrideRisk: risks.some((risk) => risk.id === "dangerous-env-overrides"),
      unsafeConfigPermissionRisk: risks.some((risk) => risk.id === "config-permission-allow"),
      dangerouslySkipPermissions: Boolean(spec.dangerouslySkipPermissions),
      risks,
    },
  };
}

async function writeChildConfig(configDir, config = {}, trustMode = "inherit") {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => {});
  const generated = {
    "$schema": "https://opencode.ai/config.json",
    ...config,
  };
  if (trustMode === "safe") {
    generated.permission = safePermissionBaseline(generated.permission);
    generated.mcp = generated.mcp ?? {};
  }
  const configFile = path.join(configDir, "opencode.json");
  await writeFile(configFile, JSON.stringify(generated, null, 2), { mode: 0o600 });
  await chmod(configFile, 0o600).catch(() => {});
}

async function waitForHealth(client, timeoutMs, signal) {
  const started = Date.now();
  let last = "not attempted";
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) throw new Error("child health check aborted");
    const res = await client.get("/global/health", { timeoutMs: 1000, signal });
    if (res.ok) return res.data;
    last = res.error;
    await sleep(200);
  }
  throw new Error(`child health check timed out: ${last}`);
}

function ipv4ProcHex(hostname) {
  const parts = String(hostname || "").split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return octets.reverse().map((part) => part.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function procTcpAddressMatches(address, hostname, ipv6 = false) {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!host || host === "0.0.0.0" || host === "::") return true;
  if (host === "localhost") {
    return address === "00000000" || address === "0100007F" || address === "00000000000000000000000000000000" || address === "00000000000000000000000001000000";
  }
  if (!ipv6) {
    const expected = ipv4ProcHex(host);
    return expected ? address === expected || address === "00000000" : true;
  }
  if (host === "::1") return address === "00000000000000000000000001000000" || address === "00000000000000000000000000000000";
  return true;
}

async function listeningSocketInodes(port, hostname) {
  const out = new Set();
  for (const [file, ipv6] of [["/proc/net/tcp", false], ["/proc/net/tcp6", true]]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const cols = line.trim().split(/\s+/);
      const [address, portHex] = (cols[1] || "").split(":");
      if (cols[3] !== TCP_LISTEN_STATE) continue;
      if (Number.parseInt(portHex, 16) !== Number(port)) continue;
      if (!procTcpAddressMatches(address, hostname, ipv6)) continue;
      if (cols[9]) out.add(cols[9]);
    }
  }
  return out;
}

async function descendantPids(rootPid) {
  const root = String(rootPid || "");
  const seen = new Set(root ? [root] : []);
  const queue = root ? [root] : [];
  while (queue.length) {
    const pid = queue.shift();
    const tasks = await readdir(`/proc/${pid}/task`).catch(() => []);
    for (const tid of tasks) {
      const children = await readFile(`/proc/${pid}/task/${tid}/children`, "utf8").catch(() => "");
      for (const childPid of children.trim().split(/\s+/).filter(Boolean)) {
        if (seen.has(childPid)) continue;
        seen.add(childPid);
        queue.push(childPid);
      }
    }
  }
  return seen;
}

async function pidOwnsSocket(pid, inodes) {
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => []);
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match && inodes.has(match[1])) return true;
  }
  return false;
}

async function verifySpawnedPortOwner(procPid, hostname, port) {
  if (process.platform !== "linux") return { verified: false, skipped: true, reason: "port ownership check requires /proc" };
  const inodes = await listeningSocketInodes(port, hostname);
  if (!inodes.size) throw new Error(`child port ownership check failed: no listener found for ${hostname}:${port}`);
  const pids = await descendantPids(procPid);
  for (const pid of pids) {
    if (await pidOwnsSocket(pid, inodes)) return { verified: true, pid: Number(pid) };
  }
  throw new Error(`child port ownership check failed: ${hostname}:${port} is not owned by spawned pid ${procPid} or its descendants`);
}

async function inspectStartup(client, signal) {
  const entries = await Promise.all([
    client.get("/global/health", { signal }),
    client.get("/path", { signal }),
    client.get("/project/current", { signal }),
    client.get("/config", { signal }),
    client.get("/command", { signal }),
    client.get("/agent", { signal }),
    client.get("/mcp", { signal }),
    client.get("/experimental/tool/ids", { signal }),
    client.get("/session", { signal }),
  ]);
  const [health, paths, project, config, commands, agents, mcp, tools, sessions] = entries;
  return {
    health: health.ok ? health.data : { error: health.error },
    paths: paths.ok ? paths.data : { error: paths.error },
    project: project.ok ? project.data : { error: project.error },
    configSummary: config.ok ? { keys: Object.keys(config.data || {}).slice(0, 40), model: config.data?.model, permission: config.data?.permission } : { error: config.error },
    commands: commands.ok ? summarizeList(commands.data) : { error: commands.error },
    agents: agents.ok ? summarizeList(agents.data) : { error: agents.error },
    mcp: mcp.ok ? summarizeList(mcp.data) : { error: mcp.error },
    tools: tools.ok ? summarizeList(tools.data) : { error: tools.error },
    sessions: sessions.ok ? summarizeList(sessions.data, 5) : { error: sessions.error },
  };
}

function countSummary(summary) {
  return typeof summary?.count === "number" ? summary.count : 0;
}

function assertSafeStartup(child) {
  if (child.trustMode !== "safe") return;
  const mcpCount = countSummary(child.startupInspection?.mcp);
  if (mcpCount > 0 && !child.spec?.allowUnsafeSafeOverrides) {
    child.safeWarnings = [...(child.safeWarnings || []), `safe child reported ${mcpCount} MCP registry entr${mcpCount === 1 ? "y" : "ies"}; pre-start MCP config was still rejected, but /mcp may include built-in or disabled state`];
  }
}

// Exit handler with an IDENTITY GUARD (C01/C07): a late-firing exit from a proc
// whose id has since been reused by a restart/EADDRINUSE-retry must not delete the
// new proc's live handle, abort its event reader, or clobber its healthy registry
// row (which would also fire a spurious crash notification and orphan the new child).
async function handleProcExit({ id, proc, child, code, signal, registry, notifier }) {
  const exit = { code, signal, at: nowIso() };
  child.exit = exit;
  const key = lifecycleKey(registry, id);
  // If registry.insert never succeeded for this child (the start failed and the
  // caller was told it never started), there is no persisted row to reconcile.
  // Writing one here would leave a phantom terminal 'exited' row for a child whose
  // configDir/managedDirs were already deleted, polluting future status/start
  // listings. Clean up only THIS proc's live handle/event reader and bail before
  // any registry/notifier mutation.
  if (!child.registered) {
    if (liveProcesses.get(key) === proc) {
      liveProcesses.delete(key);
      eventReaders.get(key)?.abort();
      eventReaders.delete(key);
    }
    return;
  }
  // Only mutate shared process/reader maps if THIS proc still owns the id.
  if (liveProcesses.get(key) === proc) {
    liveProcesses.delete(key);
    eventReaders.get(key)?.abort();
    eventReaders.delete(key);
  }
  const current = await registry.get(id).catch(() => undefined);
  // A newer child (different nonce) already owns this id: leave its state intact.
  if (current && child.nonce && current.nonce && current.nonce !== child.nonce) return;
  const expectedStop = child.expectedStop || current?.expectedStop || current?.status === "stopping" || current?.status === "stopped";
  child.status = expectedStop ? "stopped" : "exited";
  const lifecycleFields = {
    logs: child.logs,
    events: child.events ?? current?.events,
    exit,
    processAlive: false,
    status: child.status,
    ...(expectedStop ? { expectedStop: true, stoppedAt: current?.stoppedAt ?? exit.at } : {}),
  };
  const patch = await registry.conditionalPatch(id, child.nonce, lifecycleFields, {
    allowedTerminalStatuses: expectedStop ? ["stopping"] : [],
  }).catch(() => undefined);
  if (!patch?.applied) return;
  if (!expectedStop) await notifier?.handleChildExit(patch.child, exit).catch(() => {});
}

function trackProcessExit(proc, handler) {
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  processExitCompletions.set(proc, completion);
  proc.on("exit", (code, signal) => {
    Promise.resolve(handler(code, signal)).catch(() => {}).finally(() => {
      resolveCompletion();
      if (processExitCompletions.get(proc) === completion) processExitCompletions.delete(proc);
    });
  });
  return completion;
}

export async function startChild(registry, args = {}, context = {}, notifier) {
  if (args.id) return await withChildLifecycle(lifecycleKey(registry, args.id), () => enqueueStart(registry, args, context, notifier));
  return await enqueueStart(registry, args, context, notifier);
}

async function createManagedDirs(requests, managedDirs, newManagedDirs, cleanup = cleanupManagedDirs) {
  const results = await Promise.allSettled(requests.map(async ({ key, prefix }) => {
    return { key, dir: await mkdtemp(path.join(tmpdir(), prefix)) };
  }));
  const created = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
  for (const { dir } of created) {
    managedDirs.push(dir);
    newManagedDirs.push(dir);
  }
  const failed = results.find((result) => result.status === "rejected");
  if (failed) {
    throw await cleanupWithDiagnostics(created.map(({ dir }) => dir), failed.reason, cleanup);
  }
  return Object.fromEntries(created.map(({ key, dir }) => [key, dir]));
}

async function cleanupManagedDirs(dirs, options = {}) {
  const targets = [...new Set((dirs || []).filter(Boolean))];
  if (!targets.length) return [];
  const sandboxRoots = await resolveSandboxRoots(options.extraRoots || []);
  return await Promise.all(targets.map((dir) => safeRmDir(dir, { ...options, sandboxRoots })));
}

function boundedPublicText(value, max = PUBLIC_ERROR_TEXT_LIMIT) {
  const text = scrubSecrets(String(value ?? ""));
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function publicCleanupReason(reason) {
  return boundedPublicText(reason || "unknown cleanup failure", 200)
    .replace(/(?:[A-Za-z]:)?[/\\][^\s,;:)]+/g, "[path]");
}

async function cleanupWithDiagnostics(dirs, originalError, cleanup = cleanupManagedDirs) {
  let results;
  try {
    results = await cleanup(dirs);
  } catch (cleanupError) {
    results = [{ deleted: false, reason: cleanupError?.message || String(cleanupError) }];
  }
  const failures = (results || []).filter((result) => result?.deleted === false);
  if (!failures.length) return originalError;
  const reasons = [...new Set(failures.map((result) => publicCleanupReason(result.reason)))];
  const originalMessage = boundedPublicText(originalError?.message || String(originalError), 2800);
  const detail = boundedPublicText(reasons.join("; "), 900);
  const wrapped = new Error(boundedPublicText(`${originalMessage}; cleanup incomplete: ${failures.length} directories could not be removed (${detail})`, 4000), { cause: originalError });
  wrapped.name = originalError?.name || "Error";
  if (typeof originalError?.code === "string" || typeof originalError?.code === "number") wrapped.code = originalError.code;
  return wrapped;
}

// Default cleanup posture keys off whether THIS start actually auto-created managed
// temp dirs (newManagedDirs), not off whether the caller passed configDir. A start that
// supplies only configDir still mkdtemp()s data/cache/state under os.tmpdir(); those must
// be reclaimed on stop, so the default must be delete-on-stop whenever anything was
// auto-created. Caller-supplied dirs are never in managedDirs, so they are never deleted.
function resolveCleanupPolicy(explicit, newManagedDirs) {
  if (explicit) return explicit;
  return (newManagedDirs && newManagedDirs.length) ? "delete-on-stop" : "keep";
}

async function provisionStartValues(args, context, options = {}) {
  const projectDir = path.resolve(args.projectDir || context.directory || process.cwd());
  const managedDirs = Array.isArray(args.managedDirs) ? [...args.managedDirs] : [];
  const newManagedDirs = [];

  const inheritData = args.inheritData ?? false;
  const requests = [];
  if (!args.configDir) requests.push({ key: "configDir", prefix: "opencode-child-config-" });
  if (!inheritData) {
    if (!args.dataDir) requests.push({ key: "dataDir", prefix: "opencode-child-data-" });
    if (!args.cacheDir) requests.push({ key: "cacheDir", prefix: "opencode-child-cache-" });
    if (!args.xdgStateDir) requests.push({ key: "xdgStateDir", prefix: "opencode-child-state-" });
  }
  const created = await createManagedDirs(requests, managedDirs, newManagedDirs, options.cleanupManagedDirs || cleanupManagedDirs);
  const configDir = path.resolve(args.configDir || created.configDir);
  const dataDir = inheritData ? undefined : path.resolve(args.dataDir || created.dataDir);
  const cacheDir = inheritData ? undefined : path.resolve(args.cacheDir || created.cacheDir);
  const xdgStateDir = inheritData ? undefined : path.resolve(args.xdgStateDir || created.xdgStateDir);

  try {
    return {
      projectDir,
      managedDirs,
      newManagedDirs,
      configDir,
      inheritData,
      dataDir,
      cacheDir,
      xdgStateDir,
      port: args.port || await (options.allocatePort || freePort)(),
    };
  } catch (error) {
    throw await cleanupWithDiagnostics(newManagedDirs, error, options.cleanupManagedDirs || cleanupManagedDirs);
  }
}

async function inspectReadyChild(child, proc, client, startupTimeoutMs, signal) {
  child.health = await waitForHealth(client, startupTimeoutMs, signal);
  throwIfAborted(signal);
  child.portOwner = await verifySpawnedPortOwner(proc.pid, child.hostname, child.port);
  throwIfAborted(signal);
  const [startupInspection, capabilities] = await Promise.all([
    inspectStartup(client, signal),
    client.probeCapabilities({ timeoutMs: startupTimeoutMs, signal }),
  ]);
  throwIfAborted(signal);
  child.startupInspection = startupInspection;
  assertSafeStartup(child);
  child.capabilities = capabilities;
  assertRequiredStartupRoutes(capabilities);
  child.status = "ready";
  return child;
}

async function startChildUnlocked(registry, args = {}, context = {}, notifier) {
  const envOpencodeBin = !args.opencodeBin && process.env.OPENCODE_BIN ? process.env.OPENCODE_BIN : undefined;
  const effectiveArgs = envOpencodeBin ? { ...args, opencodeBin: envOpencodeBin } : args;
  const signal = context.abort || effectiveArgs.signal;
  throwIfAborted(signal);
  const id = effectiveArgs.id || childId();
  const key = lifecycleKey(registry, id);
  const trustMode = effectiveArgs.trustMode || "inherit";
  if (!["inherit", "safe", "full-trust"].includes(trustMode)) throw new Error("trustMode must be inherit, safe, or full-trust");

  const hostname = effectiveArgs.hostname || "127.0.0.1";
  validateStartPreflight(effectiveArgs, { trustMode, hostname });

  const maxLive = resolveMaxLive(process.env.OPENCODE_CHILD_MAX_LIVE, effectiveArgs.maxConcurrent);
  const liveCount = countLiveForRegistry(registry);
  if (liveCount >= maxLive) {
    throw new Error(`opencode-child concurrency cap reached: ${liveCount}/${maxLive} live children. Stop some via oc_child_stop, or raise maxConcurrent / OPENCODE_CHILD_MAX_LIVE.`);
  }

  const cleanupFailedStart = effectiveArgs._cleanupManagedDirs || cleanupManagedDirs;
  const { projectDir, managedDirs, newManagedDirs, configDir, inheritData, dataDir, cacheDir, xdgStateDir, port } = await provisionStartValues(effectiveArgs, context, { cleanupManagedDirs: cleanupFailedStart });
  const baseUrl = `http://${hostname}:${port}`;
  const opencodeBin = effectiveOpencodeBin(effectiveArgs) || "opencode";
  const startupTimeoutMs = resolveStartupTimeout(effectiveArgs.timeoutMs);
  const cleanupPolicy = resolveCleanupPolicy(effectiveArgs.cleanupPolicy, newManagedDirs);

  try {
    await validateStartArgs(registry, effectiveArgs, { id, trustMode, hostname, managedDirs, projectDir, configDir, dataDir, cacheDir, xdgStateDir, inheritData, port, cleanupPolicy }, { terminalStatuses: TERMINAL_STATUSES });
    await writeChildConfig(configDir, effectiveArgs.config || {}, trustMode);
  } catch (error) {
    throw await cleanupWithDiagnostics(newManagedDirs, error, cleanupFailedStart);
  }

  const env = safeEnv(trustMode, effectiveArgs.env || {}, effectiveArgs.inheritEnv ?? trustMode !== "safe");
  env.OPENCODE_CONFIG_DIR = configDir;
  if (!inheritData) {
    env.XDG_DATA_HOME = dataDir;
    env.XDG_CACHE_HOME = cacheDir;
    env.XDG_STATE_HOME = xdgStateDir;
  }
  const auth = {
    username: effectiveArgs.serverUsername || "opencode",
    password: effectiveArgs.serverPassword || randomPassword(),
    generated: !effectiveArgs.serverPassword,
  };
  env.OPENCODE_SERVER_USERNAME = auth.username;
  env.OPENCODE_SERVER_PASSWORD = auth.password;
  const cliArgs = ["serve", "--hostname", hostname, "--port", String(port), "--print-logs"];
  if (effectiveArgs.pure || trustMode === "safe") cliArgs.push("--pure");
  if (effectiveArgs.dangerouslySkipPermissions) cliArgs.push("--dangerously-skip-permissions");

  const proc = spawn(opencodeBin, cliArgs, { cwd: projectDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let spawnError;
  const spawnErrorPromise = new Promise((_, reject) => {
    proc.once("error", (error) => {
      spawnError = error;
      reject(error);
    });
  });
  spawnErrorPromise.catch(() => {});
  const child = {
    id,
    status: "starting",
    // Only flips true after registry.insert(child) resolves. handleProcExit reads
    // this to avoid writing a terminal row for a child that never got persisted.
    registered: false,
    pid: proc.pid,
    port,
    hostname,
    baseUrl,
    projectDir,
    configDir,
    dataDir,
    cacheDir,
    xdgStateDir,
    managedDirs,
    inheritData,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    trustMode,
    cleanupPolicy,
    auth,
    managedBy: "opencode-child",
    stateDir: registry.stateDir,
    owner: childOwnerFromContext(context),
    allowNonLoopback: Boolean(effectiveArgs.allowNonLoopback),
    nonce: randomPassword(16),
    spec: sanitizedRestartSpec(effectiveArgs, { projectDir, configDir, dataDir, cacheDir, xdgStateDir, managedDirs, inheritData, port, hostname, id, cleanupPolicy, trustMode }),
    trustSummary: {
      mode: trustMode,
      inheritEnv: effectiveArgs.inheritEnv ?? trustMode !== "safe",
      inheritGlobalConfig: effectiveArgs.inheritGlobalConfig ?? trustMode !== "safe",
      inheritMcp: effectiveArgs.inheritMcp ?? trustMode !== "safe",
      pure: Boolean(effectiveArgs.pure || trustMode === "safe"),
      dangerouslySkipPermissions: Boolean(effectiveArgs.dangerouslySkipPermissions),
      note: trustMode === "safe"
        ? "safe is best-effort local isolation, not a security sandbox"
        : `inherit/full-trust: child inherits parent env; data dir ${inheritData ? "SHARED with parent (auth inherited)" : "isolated (no inherited auth)"}; not a security boundary`,
    },
    logs: { stdout: "", stderr: "" },
  };
  if (effectiveArgs._restartDropped?.length) {
    appendLog(child, "stderr", `\n[restart non-fidelity] intentionally dropped prior ${effectiveArgs._restartDropped.join(" and ")}; supply new values explicitly\n`);
  }
  notifier?.clearExpectedStop(child.id);
  notifier?.registerChildOwner(child.id, context);
  if (proc.pid) liveProcesses.set(key, proc);
  installExitHandlers();
  proc.stdout.on("data", (chunk) => appendLog(child, "stdout", chunk));
  proc.stderr.on("data", (chunk) => appendLog(child, "stderr", chunk));
  proc.on("error", (error) => appendLog(child, "stderr", `\n[spawn error] ${error.message}\n`));
  trackProcessExit(proc, (code, signal) => handleProcExit({ id, proc, child, code, signal, registry, notifier }));
  try {
    await registry.insert(child, { allowExistingTerminal: Boolean(effectiveArgs._allowExistingId) });
    child.registered = true;
  } catch (error) {
    if (proc.pid && liveProcesses.get(key) === proc) liveProcesses.delete(key);
    notifier?.clearChildState?.(id);
    if (proc.pid) signalProcessGroup(proc.pid, "SIGTERM");
    await sleep(200);
    if (proc.pid && isPidAlive(proc.pid)) signalProcessGroup(proc.pid, "SIGKILL");
    throw await cleanupWithDiagnostics(newManagedDirs, error, cleanupFailedStart);
  }

  const client = new ChildHttpClient(baseUrl, { ...auth, timeoutMs: startupTimeoutMs });
  const startupController = new AbortController();
  const startupAbort = combineAbortSignals(startupController.signal, signal);
  try {
    await Promise.race([inspectReadyChild(child, proc, client, startupTimeoutMs, startupAbort.signal), spawnErrorPromise]);
    // C05: if a concurrent oc_child_stop/restart marked this child terminal while we
    // were starting, do not resurrect it to "ready" or start an event tail.
    const concurrent = await registry.get(child.id).catch(() => undefined);
    if (concurrent?.expectedStop || TERMINAL_STATUSES.has(concurrent?.status)) {
      eventReaders.get(key)?.abort();
      eventReaders.delete(key);
      return { ...child, ...concurrent };
    }
    // A registry write failure here must not undo a child that started and passed
    // health checks; guarding prevents falling into the failure path that would kill it.
    const persisted = await registry.upsertIfCurrentActive(child).catch(() => undefined);
    if (persisted?.expectedStop || TERMINAL_STATUSES.has(persisted?.status)) {
      eventReaders.get(key)?.abort();
      eventReaders.delete(key);
      return { ...child, ...persisted };
    }
    await startEventTail(registry, child, notifier, { eventReaders, terminalStatuses: TERMINAL_STATUSES, key });
    return child;
  } catch (error) {
    startupController.abort();
    child.status = "failed";
    child.error = spawnError?.message || error.message;
    const attempt = effectiveArgs._portAttempt || 0;
    const stderr = child.logs?.stderr || "";
    const retryablePortFailure = !effectiveArgs.port && attempt < 2 && /EADDRINUSE|address already in use/i.test(`${stderr} ${error.message}`);
    // Guard the failure-state write so a transient registry error cannot skip the
    // stopChild cleanup below, which would otherwise leak the spawned process group.
    await registry.upsertIfCurrentActive(child).catch(() => {});
    await stopChildUnlocked(registry, await registry.get(id).catch(() => child), { cleanup: !retryablePortFailure, includeStale: true, allowRegistryPidSignal: true }, notifier).catch(() => {});
    // Bounded retry on a lost-port race (freePort is TOCTOU): only when the caller did
    // not pin an explicit port. Clean this attempt's managed temp dirs, pick a fresh port.
    if (retryablePortFailure) {
      const cleanupError = await cleanupWithDiagnostics(newManagedDirs, error, cleanupFailedStart);
      if (cleanupError !== error) throw cleanupError;
      return startChildUnlocked(registry, { ...effectiveArgs, id, _portAttempt: attempt + 1, _allowExistingId: true }, context, notifier);
    }
    throw error;
  } finally {
    startupAbort.cleanup();
  }
}

export async function statusChild(registry, id, options = {}) {
  throwIfAborted(options.signal);
  // C39: mirror stopChild — childId "all" (and a missing id) means list every child,
  // rather than throwing "unknown child: all".
  const listAll = !id || id === "all";
  const children = listAll ? await registry.list() : [await registry.get(id)];
  const out = await Promise.all(children.map(async (child) => {
    const alive = isPidAlive(child.pid);
    const canHttp = canContactChildUrl(child);
    const client = new ChildHttpClient(child.baseUrl, { ...(child.auth || {}), timeoutMs: options.timeoutMs ?? 2500 });
    const health = alive && canHttp ? await client.get("/global/health", { signal: options.signal }) : { ok: false, error: alive ? "refusing to probe non-loopback child URL" : "process is not alive" };
    const sessions = alive && canHttp ? await client.get("/session", { timeoutMs: 2500, signal: options.signal }) : { ok: false, error: health.error };
    return { ...child, processAlive: alive, liveHealth: health.ok ? health.data : { error: health.error }, liveSessions: sessions.ok ? summarizeList(sessions.data, 10) : { error: sessions.error } };
  }));
  return listAll ? out : out[0];
}

export async function stopChild(registry, id, options = {}, notifier) {
  throwIfAborted(options.signal);
  if (id && id !== "all") {
    return await withChildLifecycle(lifecycleKey(registry, id), async () => stopChildUnlocked(registry, await registry.get(id), options, notifier));
  }
  const targets = await registry.list();
  const settled = await Promise.allSettled(targets.map((target) =>
    withChildLifecycle(lifecycleKey(registry, target.id), async () => stopChildUnlocked(registry, await registry.get(target.id).catch(() => target), options, notifier))));
  if (!options.signal?.aborted && settled.every((outcome) => outcome.status === "fulfilled")) return settled.map((outcome) => outcome.value);
  const outcomes = settled.map((outcome, index) => outcome.status === "fulfilled"
    ? { childId: targets[index].id, status: "fulfilled", result: publicStopResult(outcome.value) }
    : { childId: targets[index].id, status: "rejected", error: publicStopError(outcome.reason) });
  throw new BulkStopError(outcomes, { cancelled: Boolean(options.signal?.aborted) });
}

function publicStopResult(result = {}) {
  const output = {};
  for (const key of ["id", "stopped", "skipped", "processAlive", "stopOutcome", "terminated", "killed"]) {
    if (result[key] !== undefined) output[key] = result[key];
  }
  if (result.reason !== undefined) output.reason = boundedPublicText(result.reason);
  if (result.dispose !== undefined) {
    output.dispose = {
      ok: result.dispose?.ok,
      status: result.dispose?.status,
      ...(result.dispose?.error === undefined ? {} : { error: boundedPublicText(result.dispose.error) }),
    };
  }
  return output;
}

function publicStopError(error) {
  return {
    name: boundedPublicText(error?.name || error?.constructor?.name || "Error", 200),
    ...((typeof error?.code === "string" || typeof error?.code === "number") ? { code: error.code } : {}),
    message: boundedPublicText(error?.message || String(error)),
  };
}

export class BulkStopError extends Error {
  constructor(outcomes, { cancelled = false } = {}) {
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected").length;
    const code = cancelled ? "OPENCODE_CHILD_BULK_STOP_CANCELLED" : "OPENCODE_CHILD_BULK_STOP_FAILED";
    super(boundedPublicText(cancelled
      ? `Bulk stop cancelled after all ${outcomes.length} targets settled`
      : `Bulk stop failed for ${rejected} of ${outcomes.length} targets`, 4000));
    this.name = "BulkStopError";
    this.code = code;
    this.cancelled = cancelled;
    this.summary = { total: outcomes.length, fulfilled: outcomes.length - rejected, rejected };
    this.outcomes = outcomes;
  }
}

async function stopChildUnlocked(registry, child, options = {}, notifier) {
  throwIfAborted(options.signal);
  const key = lifecycleKey(registry, child.id);
  const live = liveProcesses.get(key);
  const terminal = TERMINAL_STATUSES.has(child.status) || child.expectedStop;
  if (!live && terminal && !options.includeStale) {
    return { id: child.id, skipped: true, reason: "terminal registry entry", processAlive: isPidAlive(child.pid) };
  }
  const canHttp = canContactChildUrl(child);
  const client = new ChildHttpClient(child.baseUrl, { ...(child.auth || {}), timeoutMs: options.timeoutMs ?? 2000 });
  child.expectedStop = true;
  notifier?.markExpectedStop(child.id);
  if (live) child.status = "stopping";
  await registry.conditionalPatch(child.id, child.nonce, { expectedStop: true, status: "stopping" }).catch(() => {});
  eventReaders.get(key)?.abort();
  eventReaders.delete(key);
  const dispose = canHttp ? await client.post("/instance/dispose", undefined, { timeoutMs: options.disposeTimeoutMs ?? 1500, signal: options.signal }) : { ok: false, status: 0, error: "refusing to dispose non-loopback child URL" };
  await sleep(options.graceMs ?? 700);
  let alive = isPidAlive(child.pid);
  let terminated = false;
  let killed = false;
  const maySignal = Boolean(live || options.allowRegistryPidSignal);
  if (alive && maySignal) {
    terminated = signalProcessGroup(child.pid, "SIGTERM");
    await sleep(options.termGraceMs ?? 800);
    alive = isPidAlive(child.pid);
  }
  if (alive && maySignal && options.kill !== false) {
    killed = signalProcessGroup(child.pid, "SIGKILL");
    await sleep(200);
    alive = isPidAlive(child.pid);
  }
  if (!alive) notifier?.clearChildState?.(child.id);
  const cleanup = [];
  const stopMessages = [];
  let stopOutcome = dispose.ok ? "disposed" : (alive ? "dispose_timeout_process_alive_cleanup_skipped" : (killed ? "dispose_timeout_killed" : "dispose_timeout_cleanup_succeeded"));
  // Only ever delete plugin-managed temp dirs (config/data/cache/state created via
  // mkdtemp), each behind the sandbox guard. A caller-supplied configDir is never in
  // managedDirs, so it can never be auto-deleted here.
  if (alive) stopMessages.push("\n[warning] process still alive; skipping managed-dir cleanup\n");
  if (options.cleanup !== false && child.cleanupPolicy === "delete-on-stop" && !alive) {
    const managed = child.managedDirs || child.spec?.managedDirs || [];
    cleanup.push(...await cleanupManagedDirs(managed, { onSkip: (p, e) => stopMessages.push(`\n[cleanup skipped] ${p}: ${e.message}\n`) }));
  }
  const current = await registry.get(child.id).catch(() => child);
  const logCarrier = { auth: child.auth, logs: { ...(current.logs || child.logs || { stdout: "", stderr: "" }) } };
  for (const message of stopMessages) appendLog(logCarrier, "stderr", message);
  const stopFields = {
    status: "stopped",
    stoppedAt: nowIso(),
    expectedStop: true,
    disposeResult: dispose,
    processAlive: alive,
    terminated,
    killed,
    stopOutcome,
    logs: logCarrier.logs,
  };
  let updated;
  try {
    const patch = await registry.conditionalPatch(child.id, child.nonce, stopFields, { allowedTerminalStatuses: ["stopping", "stopped", "failed"] });
    updated = patch.child || { ...child, ...stopFields };
  } catch {
    updated = { ...child, ...stopFields };
  }
  return { id: child.id, stopped: !alive, dispose, terminated, killed, processAlive: alive, stopOutcome, cleanup, child: updated };
}

export async function restartChild(registry, id, args = {}, context = {}, notifier) {
  return await withChildLifecycle(lifecycleKey(registry, id), async () => {
    const signal = context.abort || args.signal;
    throwIfAborted(signal);
    const old = await registry.get(id);
    const stop = await stopChildUnlocked(registry, old, { cleanup: false, includeStale: true, signal }, notifier);
    if (!stop?.stopped || stop?.processAlive) {
      throw new Error(`refusing to restart ${id}: previous child is still alive or unverified`);
    }
    const { signal: _signal, ...restartArgs } = args;
    const spec = buildRestartSpec(old, { ...restartArgs, port: restartArgs.port || await freePort() });
    const started = await enqueueStart(registry, spec, { ...context, abort: signal }, notifier);
    return { oldPid: old.pid, newPid: started.pid, stop, child: started };
  });
}

export async function disposeLifecycleState(options = {}) {
  // Snapshot the keys and handles present at dispose entry BEFORE the async
  // terminate window below. We tear down exactly these snapshotted entries and no
  // others: a concurrently in-flight startChildUnlocked can register a fresh
  // liveProcesses/eventReaders entry (under a new key) while we
  // await terminateFn, and an unconditional .clear() here would silently wipe that
  // new handle — orphaning the just-spawned process (never in our terminate list)
  // and leaking its event-tail SSE loop with no controller left to abort it.
  const eventReaderSnapshot = [...eventReaders.entries()];
  const liveProcessSnapshot = [...liveProcesses.entries()];
  const exitCompletionSnapshot = liveProcessSnapshot
    .map(([, proc]) => processExitCompletions.get(proc))
    .filter(Boolean);
  const snapshotKeys = new Set([
    ...eventReaderSnapshot.map(([key]) => key),
    ...liveProcessSnapshot.map(([key]) => key),
  ]);
  const controllers = eventReaderSnapshot.map(([, controller]) => controller);
  const pids = liveProcessSnapshot.map(([, proc]) => proc?.pid).filter(Boolean);
  // Abort the snapshotted event-tail readers first: this stops their SSE read
  // loops (guarded by controller.signal.aborted), lets each run()'s finally
  // self-evict its own key, and drops any block buffered/delivered post-abort.
  for (const controller of controllers) controller?.abort?.();
  let termination;
  if (options.terminate !== false && pids.length) {
    const terminateFn = options.terminateFn || gracefulTerminate;
    try {
      termination = await terminateFn(pids, options.terminateOptions || {});
    } catch (error) {
      termination = { error: error?.message || String(error) };
    }
  }
  let exitHandlers;
  if (exitCompletionSnapshot.length) {
    const timeoutMs = options.exitHandlerTimeoutMs ?? 2000;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      timer.unref?.();
    });
    const completed = Promise.allSettled(exitCompletionSnapshot).then(() => ({ timedOut: false }));
    exitHandlers = await Promise.race([completed, timeout]);
    clearTimeout(timer);
    exitHandlers.count = exitCompletionSnapshot.length;
    exitHandlers.timeoutMs = timeoutMs;
  }
  // Delete only the keys we snapshotted at entry. Entries registered during the
  // await above survive and stay tracked/abortable by a later stop/dispose.
  for (const key of snapshotKeys) {
    eventReaders.delete(key);
    liveProcesses.delete(key);
  }
  return { abortedEventReaders: controllers.length, terminatedPids: pids.length, termination, exitHandlers };
}

export async function eventsChild(registry, id, options = {}) {
  const child = await registry.get(id);
  const scrubEvent = (value, seen = new WeakSet()) => {
    if (typeof value === "string") return scrubSecrets(value, [child.auth?.password]);
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => scrubEvent(item, seen));
    const out = Object.create(null);
    for (const [key, item] of Object.entries(value)) out[key] = scrubEvent(item, seen);
    return out;
  };
  let events = Array.isArray(child.events) ? child.events : [];
  if (options.types) {
    const allowed = new Set(Array.isArray(options.types) ? options.types : String(options.types).split(",").map((x) => x.trim()).filter(Boolean));
    events = events.filter((event) => {
      const normalized = normalizeChildEvent(event);
      return allowed.has(event.type) || allowed.has(normalized.type) || allowed.has(normalized.kind);
    });
  }
  const hasSince = options.since !== undefined;
  if (hasSince) events = events.filter((event) => Number(event.index) >= Number(options.since));
  const limit = options.limit ?? 50;
  const hasMore = events.length > limit;
  // With a `since` cursor, walk forward from the cursor by returning the OLDEST
  // `limit` matches (slice(0, limit)); repeated since:lastReturnedIndex+1 calls
  // then advance without gaps. Without `since`, keep the "most recent N" tail.
  const page = hasSince ? events.slice(0, limit) : events.slice(-limit);
  return { childId: id, count: events.length, hasMore, events: page.map((event) => scrubEvent(event)) };
}

export function getLiveProcess(id) {
  return liveProcesses.get(id);
}

export const _test = { buildRestartSpec, cleanupWithDiagnostics, handleProcExit, handleExitSignal, killAllSync, liveProcesses, eventReaders, lifecycleQueues, startupQueues, processExitCompletions, trackProcessExit, withChildLifecycle, resolveStartupTimeout, lifecycleKey, countLiveForRegistry, provisionStartValues, resolveCleanupPolicy, writeChildConfig };
