import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChildRegistry } from "../src/registry.js";
import { BulkStopError, stopChild, disposeLifecycleState, _test } from "../src/lifecycle.js";

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

async function listenLoopback(server) {
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
}

async function closeServer(server) {
  const closed = once(server, "close");
  server.close();
  await closed;
}

test("stopChild deletes only managedDirs, never a caller-supplied configDir", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-state-"));
  const managedDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-managed-"));
  const callerConfigDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-caller-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_cleanup",
      pid: 2147483646,             // not a live pid -> no signals sent
      status: "ready",
      baseUrl: "http://127.0.0.1:9", // discard port -> dispose refused fast
      cleanupPolicy: "delete-on-stop",
      configDir: callerConfigDir,  // caller-supplied: must survive
      managedDirs: [managedDir],   // plugin-created: must be deleted
    });
    await stopChild(registry, "child_cleanup", { graceMs: 10, termGraceMs: 10, disposeTimeoutMs: 200 });
    assert.equal(await exists(managedDir), false, "managed temp dir should be deleted");
    assert.equal(await exists(callerConfigDir), true, "caller-supplied configDir must NOT be deleted");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(managedDir, { recursive: true, force: true }).catch(() => {});
    await rm(callerConfigDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("resolveCleanupPolicy defaults to delete-on-stop whenever dirs were auto-created", () => {
  const { resolveCleanupPolicy } = _test;
  // configDir-only start: data/cache/state were mkdtemp'd -> must be reclaimed on stop.
  assert.equal(resolveCleanupPolicy(undefined, ["/tmp/data", "/tmp/cache", "/tmp/state"]), "delete-on-stop");
  // Nothing auto-created (all dirs caller-supplied / inheritData) -> keep.
  assert.equal(resolveCleanupPolicy(undefined, []), "keep");
  // Explicit caller policy always wins.
  assert.equal(resolveCleanupPolicy("keep", ["/tmp/data"]), "keep");
  assert.equal(resolveCleanupPolicy("delete-on-stop", []), "delete-on-stop");
});

test("configDir-only start auto-creates data/cache/state that stopChild then reclaims", async () => {
  const { provisionStartValues, resolveCleanupPolicy } = _test;
  const callerConfigDir = await mkdtemp(path.join(os.tmpdir(), "oc-cfgonly-caller-"));
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-cfgonly-state-"));
  try {
    // Caller supplies ONLY configDir; no dataDir/cacheDir/xdgStateDir, inheritData falsy.
    const values = await provisionStartValues({ configDir: callerConfigDir }, {});

    // provisionStartValues mkdtemp'd three managed temp dirs under os.tmpdir().
    assert.equal(values.newManagedDirs.length, 3, "data/cache/state should be auto-created");
    assert.equal(values.configDir, path.resolve(callerConfigDir), "configDir stays caller-supplied");
    assert.equal(values.managedDirs.includes(values.configDir), false, "caller configDir is never managed");
    for (const dir of values.newManagedDirs) {
      assert.equal(await exists(dir), true, "auto-created dir should exist after provisioning");
    }

    // The regression: default policy must be delete-on-stop (was 'keep' when keyed off configDir).
    const cleanupPolicy = resolveCleanupPolicy(undefined, values.newManagedDirs);
    assert.equal(cleanupPolicy, "delete-on-stop");

    // Drive a real stop with the provisioned values and confirm no orphans remain.
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_cfgonly",
      pid: 2147483646,
      status: "ready",
      baseUrl: "http://127.0.0.1:9",
      cleanupPolicy,
      configDir: values.configDir,
      managedDirs: values.managedDirs,
    });
    await stopChild(registry, "child_cfgonly", { graceMs: 10, termGraceMs: 10, disposeTimeoutMs: 200 });

    for (const dir of values.newManagedDirs) {
      assert.equal(await exists(dir), false, "auto-created temp dir must be deleted on stop");
    }
    assert.equal(await exists(callerConfigDir), true, "caller-supplied configDir must survive");
  } finally {
    await rm(callerConfigDir, { recursive: true, force: true }).catch(() => {});
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild does not signal registry-only live PIDs by default", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_stale_pid",
      pid: process.pid,
      status: "ready",
      baseUrl: "http://127.0.0.1:9",
      cleanupPolicy: "keep",
    });

    const result = await stopChild(registry, "child_stale_pid", { graceMs: 10, termGraceMs: 10, disposeTimeoutMs: 50, kill: true });

    assert.equal(result.processAlive, true);
    assert.equal(result.terminated, false);
    assert.equal(result.killed, false);
    assert.match(result.child.logs.stderr, /process still alive; skipping managed-dir cleanup/);
    const fresh = new ChildRegistry(stateDir);
    assert.match((await fresh.get("child_stale_pid")).logs.stderr, /process still alive; skipping managed-dir cleanup/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild skips terminal registry entries by default", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_terminal",
      pid: 2147483646,
      status: "stopped",
      baseUrl: "http://127.0.0.1:9",
    });

    const result = await stopChild(registry, "child_terminal", { disposeTimeoutMs: 50 });

    assert.equal(result.skipped, true);
    assert.match(result.reason, /terminal/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild bulk all returns a stopped result for each registry child", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-state-"));
  const cleared = [];
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_bulk_a", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9", cleanupPolicy: "keep" });
    await registry.upsert({ id: "child_bulk_b", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.2:9", cleanupPolicy: "keep" });

    const result = await stopChild(registry, "all", {
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 50,
      kill: false,
    }, {
      markExpectedStop() {},
      clearChildState(id) { cleared.push(id); },
    });

    assert.deepEqual(result.map((item) => item.id).sort(), ["child_bulk_a", "child_bulk_b"]);
    for (const item of result) {
      assert.equal(item.stopped, true);
      assert.equal(item.processAlive, false);
      assert.equal(item.terminated, false);
      assert.equal(item.killed, false);
      assert.equal(item.dispose.ok, false);
      assert.match(item.dispose.error, /refusing to dispose non-loopback/);
      assert.equal(item.child.status, "stopped");
      assert.equal(item.child.expectedStop, true);
    }
    assert.deepEqual(cleared.sort(), ["child_bulk_a", "child_bulk_b"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild bulk all sends dispose requests concurrently", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-parallel-state-"));
  let disposeHits = 0;
  let releaseDispose;
  const bothDispose = new Promise((resolve) => { releaseDispose = resolve; });
  const makeServer = async () => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/instance/dispose") {
        disposeHits += 1;
        if (disposeHits === 2) releaseDispose();
        await Promise.race([bothDispose, delay(1000)]);
        res.end(JSON.stringify({ disposed: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "missing" }));
    });
    await listenLoopback(server);
    return server;
  };
  const servers = [await makeServer(), await makeServer()];
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_dispose_a", pid: 2147483646, status: "ready", baseUrl: `http://127.0.0.1:${servers[0].address().port}`, cleanupPolicy: "keep" });
    await registry.upsert({ id: "child_dispose_b", pid: 2147483646, status: "ready", baseUrl: `http://127.0.0.1:${servers[1].address().port}`, cleanupPolicy: "keep" });

    const result = await stopChild(registry, "all", {
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
      kill: false,
    });

    assert.equal(disposeHits, 2);
    assert.deepEqual(result.map((item) => item.dispose.ok), [true, true]);
  } finally {
    for (const server of servers) await closeServer(server);
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild bulk reports mixed success without exposing raw child rows", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-mixed-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_ok", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9", cleanupPolicy: "keep", auth: { password: "must-not-leak" } });
    await registry.upsert({ id: "child_bad", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.2:9", cleanupPolicy: "keep" });
    const error = await stopChild(registry, "all", { graceMs: 0, termGraceMs: 0 }, {
      markExpectedStop(id) { if (id === "child_bad") throw Object.assign(new Error("forced target failure"), { code: "E_TARGET" }); },
      clearChildState() {},
    }).then(() => undefined, (reason) => reason);

    assert.ok(error instanceof BulkStopError);
    assert.equal(error.code, "OPENCODE_CHILD_BULK_STOP_FAILED");
    assert.equal(error.cancelled, false);
    assert.deepEqual(error.summary, { total: 2, fulfilled: 1, rejected: 1 });
    const fulfilled = error.outcomes.find((outcome) => outcome.status === "fulfilled");
    const rejected = error.outcomes.find((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.childId, "child_ok");
    assert.equal(fulfilled.result.id, "child_ok");
    assert.equal(fulfilled.result.child, undefined);
    assert.equal(JSON.stringify(fulfilled).includes("must-not-leak"), false);
    assert.equal(rejected.childId, "child_bad");
    assert.equal(rejected.error.code, "E_TARGET");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild bulk reports total failure after every target settles", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-total-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_fail_a", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9" });
    await registry.upsert({ id: "child_fail_b", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.2:9" });
    const error = await stopChild(registry, "all", {}, { markExpectedStop() { throw new Error("all fail"); } }).catch((reason) => reason);
    assert.ok(error instanceof BulkStopError);
    assert.deepEqual(error.summary, { total: 2, fulfilled: 0, rejected: 2 });
    assert.deepEqual(error.outcomes.map((outcome) => outcome.childId), ["child_fail_a", "child_fail_b"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild bulk classifies an abort after launch as cancellation", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-cancel-"));
  let release;
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_cancel_fast", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9" });
    await registry.upsert({ id: "child_cancel_blocked", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.2:9" });
    const blocker = _test.withChildLifecycle(_test.lifecycleKey(registry, "child_cancel_blocked"), () => new Promise((resolve) => { release = resolve; }));
    await Promise.resolve();
    const controller = new AbortController();
    let fastSettled;
    const fastDone = new Promise((resolve) => { fastSettled = resolve; });
    const stopping = stopChild(registry, "all", { signal: controller.signal, graceMs: 0, termGraceMs: 0 }, {
      markExpectedStop() {},
      clearChildState(id) { if (id === "child_cancel_fast") fastSettled(); },
    });
    await fastDone;
    controller.abort();
    release();
    const error = await stopping.catch((reason) => reason);
    assert.ok(error instanceof BulkStopError);
    assert.equal(error.code, "OPENCODE_CHILD_BULK_STOP_CANCELLED");
    assert.equal(error.cancelled, true);
    assert.deepEqual(error.summary, { total: 2, fulfilled: 1, rejected: 1 });
    assert.equal(error.outcomes[0].childId, "child_cancel_fast");
    assert.equal(error.outcomes[0].status, "fulfilled");
    assert.equal(error.outcomes[1].childId, "child_cancel_blocked");
    assert.equal(error.outcomes[1].status, "rejected");
    await blocker;
  } finally {
    release?.();
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("BulkStopError bounds and redacts rejected messages", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-bulk-redact-"));
  const secret = "very-secret-bulk-value";
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_secret_error", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9" });
    const raw = Object.assign(new Error(`token=${secret} ${"x".repeat(3000)}`), { code: 500 });
    const error = await stopChild(registry, "all", {}, { markExpectedStop() { throw raw; } }).catch((reason) => reason);
    assert.ok(error instanceof BulkStopError);
    assert.ok(error.message.length <= 4000);
    assert.ok(error.outcomes[0].error.message.length <= 1000);
    assert.equal(error.outcomes[0].error.message.includes(secret), false);
    assert.equal(error.outcomes[0].error.stack, undefined);
    assert.equal(error.outcomes[0].error.cause, undefined);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild single-target failures remain raw errors", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-single-error-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_single", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9" });
    const error = await stopChild(registry, "child_single", {}, { markExpectedStop() { throw new TypeError("single unchanged"); } }).catch((reason) => reason);
    assert.ok(error instanceof TypeError);
    assert.equal(error instanceof BulkStopError, false);
    assert.equal(error.message, "single unchanged");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild persists managed-directory cleanup skip diagnostics", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-cleanup-skip-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_cleanup_skip", nonce: "cleanup-nonce", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9", cleanupPolicy: "delete-on-stop", managedDirs: [process.cwd()] });
    const result = await stopChild(registry, "child_cleanup_skip", { graceMs: 0, termGraceMs: 0 });
    assert.match(result.child.logs.stderr, /cleanup skipped/);
    const fresh = new ChildRegistry(stateDir);
    assert.match((await fresh.get("child_cleanup_skip")).logs.stderr, /cleanup skipped/);
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("stopChild signals a registry-only live PID only when explicitly allowed", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-allow-pid-state-"));
  const originalKill = process.kill;
  const targetPid = 987654;
  const signals = [];
  let alive = true;
  process.kill = (pid, signal) => {
    if (Math.abs(pid) === targetPid) {
      if (signal === 0 || signal === undefined) {
        if (alive) return true;
        const error = new Error("not alive");
        error.code = "ESRCH";
        throw error;
      }
      signals.push([pid, signal]);
      if (signal === "SIGTERM") alive = false;
      return true;
    }
    return originalKill(pid, signal);
  };

  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({ id: "child_registry_pid", pid: targetPid, status: "ready", baseUrl: "http://192.0.2.1:9", cleanupPolicy: "keep" });

    const result = await stopChild(registry, "child_registry_pid", {
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 50,
    });

    assert.equal(result.terminated, true);
    assert.equal(result.killed, false);
    assert.equal(result.processAlive, false);
    assert.deepEqual(signals, [[-targetPid, "SIGTERM"]]);
  } finally {
    process.kill = originalKill;
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("disposeLifecycleState tears down only entries snapshotted at entry, preserving a concurrently registered child", async () => {
  const { eventReaders, liveProcesses, lifecycleQueues } = _test;
  // Isolate from any residue and guarantee we clean up regardless of assertions.
  eventReaders.clear();
  liveProcesses.clear();
  lifecycleQueues.clear();

  let snapshotAborted = false;
  const snapshotController = { abort() { snapshotAborted = true; } };
  const snapshotProc = { pid: 111111 };
  eventReaders.set("child_snapshot", snapshotController);
  liveProcesses.set("child_snapshot", snapshotProc);
  let releaseQueuedOperation;
  const queuedOperation = _test.withChildLifecycle("child_snapshot", async () => {
    await new Promise((resolve) => { releaseQueuedOperation = resolve; });
  });
  await Promise.resolve();

  // Handle for a start that lands DURING the async terminate window — its key was
  // never in the snapshot, so dispose must leave it tracked and abortable.
  let concurrentAborted = false;
  const concurrentController = { abort() { concurrentAborted = true; } };
  const concurrentProc = { pid: 222222 };

  let terminatedPids;
  const terminateFn = async (pids) => {
    terminatedPids = pids;
    // Simulate startChildUnlocked / startEventTail racing dispose mid-flight.
    liveProcesses.set("child_concurrent", concurrentProc);
    eventReaders.set("child_concurrent", concurrentController);
    lifecycleQueues.set("child_concurrent", Promise.resolve());
    return { ok: true };
  };

  try {
    const result = await disposeLifecycleState({ terminateFn });

    // Snapshotted child was aborted and terminated.
    assert.equal(snapshotAborted, true, "snapshotted event reader should be aborted");
    assert.deepEqual(terminatedPids, [111111], "only the snapshotted pid should be terminated");
    assert.equal(result.abortedEventReaders, 1);
    assert.equal(result.terminatedPids, 1);

    // Disposal owns process/reader cleanup, but not lifecycle queue cleanup.
    assert.equal(eventReaders.has("child_snapshot"), false);
    assert.equal(liveProcesses.has("child_snapshot"), false);
    assert.equal(lifecycleQueues.has("child_snapshot"), true);

    let chainedRan = false;
    const chained = _test.withChildLifecycle("child_snapshot", async () => { chainedRan = true; });
    await Promise.resolve();
    assert.equal(chainedRan, false, "post-disposal operation must remain behind the pending queue owner");
    releaseQueuedOperation();
    await queuedOperation;
    await chained;
    assert.equal(chainedRan, true);
    assert.equal(lifecycleQueues.has("child_snapshot"), false);

    // The concurrently registered child survives — it was NOT wiped by a blanket
    // .clear(), it was NOT aborted, and it stays tracked/abortable.
    assert.equal(concurrentAborted, false, "concurrently registered reader must not be aborted");
    assert.equal(eventReaders.get("child_concurrent"), concurrentController);
    assert.equal(liveProcesses.get("child_concurrent"), concurrentProc);
    assert.equal(lifecycleQueues.has("child_concurrent"), true);
  } finally {
    releaseQueuedOperation?.();
    await queuedOperation.catch(() => {});
    eventReaders.clear();
    liveProcesses.clear();
    lifecycleQueues.clear();
  }
});

test("stopChild returns a synthetic stopped result when the final conditional patch fails", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-stop-fallback-state-"));
  try {
    class FinalPatchFailingRegistry extends ChildRegistry {
      async conditionalPatch(id, nonce, fields, options) {
        if (fields.status === "stopped") throw new Error("forced conditionalPatch failure");
        return await super.conditionalPatch(id, nonce, fields, options);
      }
    }

    const registry = new FinalPatchFailingRegistry(stateDir);
    await registry.upsert({ id: "child_mark_failed", pid: 2147483646, status: "ready", baseUrl: "http://192.0.2.1:9", cleanupPolicy: "keep" });

    const result = await stopChild(registry, "child_mark_failed", {
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 50,
      kill: false,
    });

    assert.equal(result.id, "child_mark_failed");
    assert.equal(result.stopped, true);
    assert.equal(result.processAlive, false);
    assert.equal(result.child.status, "stopped");
    assert.equal(result.child.expectedStop, true);
    assert.equal(result.stopOutcome, "dispose_timeout_cleanup_succeeded");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});
