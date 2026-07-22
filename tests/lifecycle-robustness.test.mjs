import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChildRegistry } from "../src/registry.js";
import { MAX_LIVE_CHILDREN_CEILING, MAX_TOOL_TIMEOUT_MS, disposeLifecycleState, eventsChild, getLiveProcess, startChild, statusChild, stopChild, resolveMaxLive, gracefulTerminate, _test } from "../src/lifecycle.js";
import { parseSseBlock } from "../src/lifecycle/events.js";
import { appendBoundedEvent } from "../src/util.js";

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

// ---- C40: concurrency cap env parsing ----
test("resolveMaxLive falls back to 8 for non-numeric, zero, or missing env values", () => {
  assert.equal(resolveMaxLive("unlimited", undefined), 8);
  assert.equal(resolveMaxLive("", undefined), 8);
  assert.equal(resolveMaxLive("0", undefined), 8);
  assert.equal(resolveMaxLive("-3", undefined), 8);
  assert.equal(resolveMaxLive(undefined, undefined), 8);
});

test("resolveMaxLive honors a valid env value and lets an explicit override win", () => {
  assert.equal(resolveMaxLive("16", undefined), 16);
  assert.equal(resolveMaxLive("16", 3), 3);
  assert.equal(resolveMaxLive("garbage", 5), 5);
});

test("resolveMaxLive clamps env and override values to the hard ceiling", () => {
  assert.equal(resolveMaxLive(String(MAX_LIVE_CHILDREN_CEILING + 1), undefined), MAX_LIVE_CHILDREN_CEILING);
  assert.equal(resolveMaxLive(undefined, MAX_LIVE_CHILDREN_CEILING + 1), MAX_LIVE_CHILDREN_CEILING);
  assert.equal(resolveMaxLive(undefined, 999999999), MAX_LIVE_CHILDREN_CEILING);
});

test("resolveStartupTimeout clamps direct lifecycle callers to the hard timeout ceiling", () => {
  assert.equal(_test.resolveStartupTimeout(undefined), 15000);
  assert.equal(_test.resolveStartupTimeout(1000), 1000);
  assert.equal(_test.resolveStartupTimeout(MAX_TOOL_TIMEOUT_MS + 1), MAX_TOOL_TIMEOUT_MS);
  assert.equal(_test.resolveStartupTimeout("not-a-number"), 15000);
});

// ---- S02: monotonic event indices across buffer wrap ----
test("appendBoundedEvent keeps indices unique and monotonic after the buffer wraps", () => {
  const buffer = { events: [], seq: 0 };
  for (let i = 0; i < 5; i += 1) appendBoundedEvent(buffer, { type: `e${i}` }, 3);
  assert.equal(buffer.events.length, 3);
  assert.deepEqual(buffer.events.map((e) => e.index), [2, 3, 4]);
  appendBoundedEvent(buffer, { type: "e5" }, 3);
  assert.deepEqual(buffer.events.map((e) => e.index), [3, 4, 5]);
});

test("eventsChild treats malformed non-array event history as empty", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-events-malformed-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_bad_events", pid: 2147483646, status: "ready", baseUrl: "http://127.0.0.1:9", events: {} });
    const result = await eventsChild(registry, "child_bad_events");
    assert.deepEqual(result, { childId: "child_bad_events", count: 0, hasMore: false, events: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("eventsChild filters and limits before returning scrubbed events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-events-filtered-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({
      id: "child_filtered_events",
      pid: 0,
      status: "exited",
      auth: { password: "literal-child-password-123456" },
      events: [
        { index: 0, type: "noise", data: { message: "ignore literal-child-password-123456" } },
        { index: 1, type: "session.idle", data: { properties: { sessionID: "ses_1" }, message: "first literal-child-password-123456" } },
        { index: 2, type: "session.idle", data: { properties: { sessionID: "ses_2" }, message: "second literal-child-password-123456" } },
        { index: 3, type: "session.error", data: { properties: { sessionID: "ses_3" }, message: "third literal-child-password-123456" } },
      ],
    });

    const result = await eventsChild(registry, "child_filtered_events", { types: "session-idle", limit: 1 });

    assert.equal(result.count, 2);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].index, 2);
    assert.equal(JSON.stringify(result).includes("literal-child-password-123456"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseSseBlock extracts SSE fields, redacts JSON secret keys, and scrubs literal secrets", () => {
  const event = parseSseBlock([
    "id: event-1",
    "event: session.update",
    "data: {\"safe\":true,\"authToken\":\"secret-value\",\"message\":\"literal child-password\"}",
  ].join("\n"), ["child-password"]);

  assert.equal(event.id, "event-1");
  assert.equal(event.type, "session.update");
  assert.equal(event.data.safe, true);
  assert.equal(event.data.authToken, "[redacted]");
  assert.equal(event.data.message, "literal [redacted]");
  assert.match(event.raw, /literal \[redacted\]/);

  const malformed = parseSseBlock("data: token child-password", ["child-password"]);
  assert.equal(malformed.data, "token [redacted]");
});

test("same-child lifecycle queue serializes operations", async () => {
  const order = [];
  let releaseFirst;
  const first = _test.withChildLifecycle("child_queue", async () => {
    order.push("first-start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    order.push("first-end");
    return "first";
  });
  await Promise.resolve();
  const second = _test.withChildLifecycle("child_queue", async () => {
    order.push("second");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();

  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  assert.equal(_test.lifecycleQueues.has("child_queue"), false);
});

// ---- null-empty-15: stopChild on a terminal entry yields a real stopped result ----
test("stopChild skips a terminal dead entry by default but produces a stopped result with includeStale", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-child-stopstale-test-"));
  try {
    const registry = new ChildRegistry(dir);
    // Terminal registry state, no live process (pid that cannot be alive), non-loopback
    // URL so no dispose HTTP is attempted.
    await registry.upsert({ id: "child_terminal", pid: 2147483647, status: "exited", baseUrl: "http://192.0.2.1:1" });

    const skipped = await stopChild(registry, "child_terminal", { graceMs: 0 });
    assert.equal(skipped.skipped, true, "terminal entry should be skipped without includeStale");
    assert.equal(skipped.stopped, undefined, "skipped result has no stopped property");

    const stopped = await stopChild(registry, "child_terminal", { includeStale: true, graceMs: 0 });
    // restartChild's guard (!stop?.stopped || stop?.processAlive) requires this shape.
    assert.equal(stopped.skipped, undefined, "includeStale must process the entry, not skip it");
    assert.equal(stopped.stopped, true, "a dead terminal child resolves to stopped:true");
    assert.equal(stopped.processAlive, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- C08: graceful termination before SIGKILL ----
test("gracefulTerminate SIGTERMs all, waits, then SIGKILLs only survivors", async () => {
  const sent = [];
  const aliveSet = new Set([1, 2]);
  const result = await gracefulTerminate([1, 2], {
    graceMs: 30,
    signal: (pid, sig) => { sent.push(`${pid}:${sig}`); if (sig === "SIGTERM" && pid === 1) aliveSet.delete(1); return true; },
    alive: (pid) => aliveSet.has(pid),
    sleepFn: async () => {},
  });
  assert.ok(sent.includes("1:SIGTERM"), "pid 1 gets SIGTERM");
  assert.ok(sent.includes("2:SIGTERM"), "pid 2 gets SIGTERM");
  assert.ok(sent.includes("2:SIGKILL"), "survivor pid 2 gets SIGKILL");
  assert.equal(sent.includes("1:SIGKILL"), false, "pid 1 died on SIGTERM, must not be SIGKILLed");
  assert.deepEqual(result.killed, [2]);
});

test("killAllSync SIGTERMs process groups with direct-pid fallback, then SIGKILLs groups", () => {
  const sent = [];
  const processes = new Map([
    ["child_a", { pid: 11 }],
    ["child_b", { pid: 22 }],
  ]);
  const kill = (pid, signal) => {
    sent.push(`${pid}:${signal}`);
    if (pid === -22 && signal === "SIGTERM") throw new Error("missing process group");
  };

  _test.killAllSync({ processes, kill });

  assert.deepEqual(sent, [
    "-11:SIGTERM",
    "-22:SIGTERM",
    "22:SIGTERM",
    "-11:SIGKILL",
    "-22:SIGKILL",
  ]);
});

test("handleExitSignal re-raises only when this handler is the lone listener", async () => {
  const handler = () => {};
  const terminated = [];
  const removed = [];
  const killed = [];
  const watchdogs = new Map();
  const timers = [];
  const exits = [];
  const processes = new Map([
    ["child_a", { pid: 11 }],
    ["child_b", { pid: 22 }],
  ]);
  const loneProcess = {
    pid: 999,
    listenerCount: () => 1,
    removeListener: (signal, fn) => removed.push([signal, fn]),
    kill: (pid, signal) => killed.push([pid, signal]),
  };

  const lone = await _test.handleExitSignal("SIGINT", handler, {
    processes,
    process: loneProcess,
    terminateFn: async (pids) => { terminated.push(pids); },
  });

  assert.deepEqual(lone, { reraised: true, pids: [11, 22] });
  assert.deepEqual(terminated, [[11, 22]]);
  assert.deepEqual(removed, [["SIGINT", handler]]);
  assert.deepEqual(killed, [[999, "SIGINT"]]);

  const sharedProcess = {
    pid: 999,
    listenerCount: () => 2,
    removeListener: (signal, fn) => removed.push([signal, fn]),
    kill: (pid, signal) => killed.push([pid, signal]),
  };

  const shared = await _test.handleExitSignal("SIGTERM", handler, {
    processes,
    process: sharedProcess,
    terminateFn: async (pids) => { terminated.push(pids); },
    watchdogs,
    watchdogMs: 1234,
    setTimeoutFn: (fn, ms) => {
      const timer = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    exitFn: (code) => exits.push(code),
  });

  assert.deepEqual(shared, { reraised: false, pids: [11, 22] });
  assert.deepEqual(terminated, [[11, 22], [11, 22]]);
  assert.deepEqual(removed, [["SIGINT", handler]]);
  assert.deepEqual(killed, [[999, "SIGINT"]]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1234);
  assert.equal(timers[0].unrefCalled, true);
  timers[0].fn();
  assert.deepEqual(exits, [143]);

  await _test.handleExitSignal("SIGTERM", handler, {
    processes,
    process: sharedProcess,
    terminateFn: async (pids) => { terminated.push(pids); },
    watchdogs,
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms });
      return {};
    },
    exitFn: (code) => exits.push(code),
  });
  assert.equal(timers.length, 1);
});

test("disposeLifecycleState is a no-op when no live process or event reader exists", async () => {
  const result = await disposeLifecycleState({
    terminateFn: async () => {
      throw new Error("terminate should not be called");
    },
  });
  assert.equal(result.abortedEventReaders, 0);
  assert.equal(result.terminatedPids, 0);
  assert.equal(result.termination, undefined);
});

test("disposeLifecycleState bounds waiting for an exit handler that never settles", async () => {
  const proc = { pid: 2147483646 };
  let resolveStuck;
  const stuckPromise = new Promise((resolve) => { resolveStuck = resolve; });
  _test.liveProcesses.set("child_stuck_exit", proc);
  _test.processExitCompletions.set(proc, stuckPromise);
  try {
    const result = await disposeLifecycleState({ terminate: false, exitHandlerTimeoutMs: 10 });
    assert.deepEqual(result.exitHandlers, { timedOut: true, count: 1, timeoutMs: 10 });
  } finally {
    // Resolve the stuck promise so the background allSettled inside
    // disposeLifecycleState can settle instead of dangling forever.
    resolveStuck();
    _test.liveProcesses.delete("child_stuck_exit");
    _test.processExitCompletions.delete(proc);
  }
});

test("getLiveProcess returns the tracked live process for a child id", () => {
  const id = "child_live_lookup";
  const proc = { pid: 123456 };
  try {
    _test.liveProcesses.set(id, proc);
    assert.equal(getLiveProcess(id), proc);
    assert.equal(getLiveProcess("child_missing"), undefined);
  } finally {
    _test.liveProcesses.delete(id);
  }
});

// ---- C39: statusChild('all') lists rather than throwing ----
test("statusChild('all') lists all children just like an empty id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-status-all-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_one", pid: 2147483646, status: "ready", baseUrl: "http://127.0.0.1:9" });
    await registry.upsert({ id: "child_two", pid: 2147483646, status: "ready", baseUrl: "http://127.0.0.1:9" });
    const all = await statusChild(registry, "all", { timeoutMs: 50 });
    const none = await statusChild(registry, undefined, { timeoutMs: 50 });
    assert.equal(Array.isArray(all), true);
    assert.deepEqual(all.map((c) => c.id).sort(), ["child_one", "child_two"]);
    assert.deepEqual(all.map((c) => c.id).sort(), none.map((c) => c.id).sort());
    const single = await statusChild(registry, "child_one", { timeoutMs: 50 });
    assert.equal(single.id, "child_one");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("statusChild('all') probes child health concurrently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-status-parallel-"));
  let healthHits = 0;
  let releaseHealth;
  const bothHealth = new Promise((resolve) => { releaseHealth = resolve; });
  const makeServer = async () => {
    const server = http.createServer(async (req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/global/health") {
        healthHits += 1;
        if (healthHits === 2) releaseHealth();
        await Promise.race([bothHealth, delay(1000)]);
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/session") {
        res.end(JSON.stringify([]));
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
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_parallel_a", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${servers[0].address().port}` });
    await registry.upsert({ id: "child_parallel_b", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${servers[1].address().port}` });

    const result = await statusChild(registry, "all", { timeoutMs: 500 });

    assert.equal(healthHits, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(result.map((child) => child.liveHealth))), [{ ok: true }, { ok: true }]);
  } finally {
    for (const server of servers) await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- C01 / C07: exit-handler nonce identity guard ----
test("exit handler does not clobber a same-id replacement child (nonce guard)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-exit-guard-"));
  const id = "child_restart_race";
  const registry = new ChildRegistry(dir);
  const key = _test.lifecycleKey(registry, id);
  try {
    await registry.upsert({ id, nonce: "NEW", status: "ready", pid: 4242, baseUrl: "http://127.0.0.1:9" });
    const procNew = { pid: 4242 };
    const controllerNew = { aborted: false, abort() { this.aborted = true; } };
    _test.liveProcesses.set(key, procNew);
    _test.eventReaders.set(key, controllerNew);
    const procOld = { pid: 1111 };
    const childOld = { id, nonce: "OLD", registered: true, logs: { stdout: "", stderr: "" }, expectedStop: true };
    await _test.handleProcExit({ id, proc: procOld, child: childOld, code: 0, signal: null, registry });
    assert.equal(_test.liveProcesses.get(key), procNew, "new proc's live handle must survive");
    assert.equal(controllerNew.aborted, false, "new proc's event reader must not be aborted");
    const entry = await registry.get(id);
    assert.equal(entry.nonce, "NEW");
    assert.equal(entry.status, "ready", "healthy replacement registry row must not be clobbered to stopped/exited");
  } finally {
    _test.liveProcesses.delete(key);
    _test.eventReaders.delete(key);
    await rm(dir, { recursive: true, force: true });
  }
});

test("exit handler updates state when this proc still owns the id", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-exit-own-"));
  const id = "child_normal_exit";
  const registry = new ChildRegistry(dir);
  const key = _test.lifecycleKey(registry, id);
  try {
    await registry.upsert({ id, nonce: "N1", status: "ready", pid: 2222, baseUrl: "http://127.0.0.1:9" });
    const proc = { pid: 2222 };
    const controller = { aborted: false, abort() { this.aborted = true; } };
    _test.liveProcesses.set(key, proc);
    _test.eventReaders.set(key, controller);
    const child = { id, nonce: "N1", registered: true, logs: { stdout: "", stderr: "" } };
    await _test.handleProcExit({ id, proc, child, code: 1, signal: null, registry });
    assert.equal(_test.liveProcesses.has(key), false, "owning proc's live handle is removed on exit");
    assert.equal(controller.aborted, true, "owning proc's event reader is aborted");
    const entry = await registry.get(id);
    assert.equal(entry.status, "exited");
    assert.equal(entry.processAlive, false);
  } finally {
    _test.liveProcesses.delete(key);
    _test.eventReaders.delete(key);
    await rm(dir, { recursive: true, force: true });
  }
});

test("expected-stop exit handling remains notification-suppressed during disposal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-exit-expected-dispose-"));
  const id = "child_expected_dispose";
  const registry = new ChildRegistry(dir);
  const key = _test.lifecycleKey(registry, id);
  let notifications = 0;
  try {
    await registry.upsert({ id, nonce: "N1", status: "stopping", expectedStop: true, pid: 2147483646, baseUrl: "http://127.0.0.1:9" });
    const proc = new (await import("node:events")).EventEmitter();
    proc.pid = 2147483646;
    const child = { id, nonce: "N1", registered: true, expectedStop: true, logs: { stdout: "", stderr: "" } };
    _test.liveProcesses.set(key, proc);
    _test.trackProcessExit(proc, (code, signal) => _test.handleProcExit({
      id, proc, child, code, signal, registry,
      notifier: { async handleChildExit() { notifications += 1; } },
    }));
    const disposing = disposeLifecycleState({ terminate: false, exitHandlerTimeoutMs: 500 });
    proc.emit("exit", 0, null);
    const result = await disposing;
    assert.equal(result.exitHandlers.timedOut, false);
    assert.equal(notifications, 0);
    assert.equal((await registry.get(id)).status, "stopped");
  } finally {
    _test.liveProcesses.delete(key);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a delayed exit patch cannot overwrite stop metadata or a replacement row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-exit-delayed-patch-"));
  const id = "child_delayed_patch";
  const registry = new ChildRegistry(dir);
  const writer = new ChildRegistry(dir);
  let releasePatch;
  let patchEntered;
  const entered = new Promise((resolve) => { patchEntered = resolve; });
  const originalPatch = registry.conditionalPatch.bind(registry);
  registry.conditionalPatch = async (...args) => {
    patchEntered();
    await new Promise((resolve) => { releasePatch = resolve; });
    return await originalPatch(...args);
  };
  try {
    await registry.upsert({ id, nonce: "OLD", status: "ready", pid: 1, baseUrl: "http://127.0.0.1:9" });
    const child = { id, nonce: "OLD", registered: true, logs: { stdout: "old", stderr: "" } };
    const exiting = _test.handleProcExit({ id, proc: { pid: 1 }, child, code: 1, signal: null, registry });
    await entered;
    await writer.markStopped(id, { marker: "fresh-stop" });
    await writer.insert({ id, nonce: "NEW", status: "ready", pid: 2, baseUrl: "http://127.0.0.1:10", marker: "replacement" }, { allowExistingTerminal: true });
    releasePatch();
    await exiting;

    const current = await writer.get(id);
    assert.equal(current.nonce, "NEW");
    assert.equal(current.status, "ready");
    assert.equal(current.marker, "replacement");
  } finally {
    releasePatch?.();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- 83s: a never-registered child's exit must not write a phantom terminal row ----
test("exit handler cleans up but writes no registry row when the child was never registered", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-exit-unregistered-"));
  const id = "child_never_registered";
  const registry = new ChildRegistry(dir);
  const key = _test.lifecycleKey(registry, id);
  try {
    const proc = { pid: 3333 };
    const controller = { aborted: false, abort() { this.aborted = true; } };
    _test.liveProcesses.set(key, proc);
    _test.eventReaders.set(key, controller);
    // registered:false models a spawned proc whose registry.insert never resolved.
    const child = { id, nonce: "N1", registered: false, logs: { stdout: "", stderr: "" } };
    await _test.handleProcExit({ id, proc, child, code: 1, signal: null, registry });
    assert.equal(_test.liveProcesses.has(key), false, "unregistered proc's live handle is still cleaned up");
    assert.equal(controller.aborted, true, "unregistered proc's event reader is still aborted");
    await assert.rejects(() => registry.get(id), /unknown child/, "no phantom terminal row is written for an unregistered child");
  } finally {
    _test.liveProcesses.delete(key);
    _test.eventReaders.delete(key);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a startChild whose registry.insert() throws leaves no phantom row on a fresh registry", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-83s-state-"));
  const binDir = await mkdtemp(path.join(os.tmpdir(), "oc-83s-bin-"));
  const fakeBin = path.join(binDir, "fake-opencode");
  await writeFile(fakeBin, "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  await chmod(fakeBin, 0o755);
  class FailingInsertRegistry extends ChildRegistry {
    async insert() {
      throw new Error("simulated insert failure (lock contention)");
    }
  }
  const registry = new FailingInsertRegistry(stateDir);
  try {
    await assert.rejects(() => startChild(registry, {
      id: "child_x",
      opencodeBin: fakeBin,
      timeoutMs: 500,
      _parentApprovedRisks: ["high-risk-start"], // custom opencodeBin is a high-risk start
    }, { directory: stateDir }), /simulated insert failure/);
    // Let the killed process's exit fire handleProcExit before reloading.
    await delay(1200);
    const fresh = new ChildRegistry(stateDir);
    const rows = await fresh.list();
    assert.equal(rows.find((c) => c.id === "child_x"), undefined, "a rejected start must not leave a phantom 'exited' row");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(binDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---- C38: start-failure cleanup must not delete restart-inherited dirs ----
test("a failed start does not delete inherited (restart-carried) managedDirs", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-c38-state-"));
  const inheritedDir = await mkdtemp(path.join(os.tmpdir(), "oc-c38-inherited-"));
  const configFile = path.join(os.tmpdir(), `oc-c38-config-${process.pid}-${process.hrtime.bigint()}`);
  await writeFile(configFile, "not a directory");
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(() => startChild(registry, {
      id: "child_c38",
      configDir: configFile,                 // a FILE -> writeChildConfig mkdir fails -> cleanup path
      managedDirs: [inheritedDir],           // simulate restart-inherited persistent dir
      allowExternalDirs: true,
      _parentApprovedRisks: ["external-dirs"],
    }, { directory: stateDir }), /EEXIST|ENOTDIR|exists|not a directory/i);
    assert.equal(await exists(inheritedDir), true, "inherited managedDir must survive a failed start attempt");
  } finally {
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
    await rm(inheritedDir, { recursive: true, force: true }).catch(() => {});
    await rm(configFile, { force: true }).catch(() => {});
  }
});
