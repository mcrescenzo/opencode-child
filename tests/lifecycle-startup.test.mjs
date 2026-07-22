import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChildRegistry } from "../src/registry.js";
import { disposeLifecycleState, startChild, stopChild, _test } from "../src/lifecycle.js";
import { isPidAlive } from "../src/util.js";
import { writeFakeOpencodeBin } from "./helpers/fake-opencode.mjs";

const exists = async (p) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function managedTempDirs() {
  const prefixes = ["opencode-child-config-", "opencode-child-data-", "opencode-child-cache-", "opencode-child-state-"];
  return new Set((await readdir(os.tmpdir())).filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix))));
}

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

async function withStartupFixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-startup-"));
  const stateDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    const registry = new ChildRegistry(stateDir);
    const opencodeBin = await writeFakeOpencodeBin(root);
    return await fn({ root, stateDir, projectDir, registry, opencodeBin });
  } finally {
    await disposeLifecycleState({ terminateOptions: { graceMs: 0 } }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertStoppedClean(registry, id) {
  const child = await registry.get(id);
  assert.equal(child.status, "stopped");
  assert.equal(child.expectedStop, true);
  assert.equal(isPidAlive(child.pid), false);
  assert.equal(_test.liveProcesses.has(id), false);
  assert.equal(_test.eventReaders.has(id), false);
  for (const dir of child.managedDirs) assert.equal(await exists(dir), false, dir);
  return child;
}

test("startChild writes safe-mode config baseline before starting the child", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const child = await startChild(registry, {
      id: "child_safe_config",
      trustMode: "safe",
      opencodeBin,
      allowUnsafeSafeOverrides: true,
      _parentApprovedRisks: ["high-risk-start", "unsafe-safe-overrides"],
      timeoutMs: 3000,
    }, { directory: projectDir });

    const configFile = path.join(child.configDir, "opencode.json");
    const config = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(config.permission.read, "allow");
    assert.equal(config.permission.edit, "ask");
    assert.deepEqual(config.mcp, {});
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
    assert.equal(child.trustSummary.pure, true);

    await stopChild(registry, child.id, {
      cleanup: true,
      includeStale: true,
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
    });
  });
});

test("startChild cleans up managed dirs after a health timeout", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const id = "child_health_timeout";

    await assert.rejects(
      () => startChild(registry, {
        id,
        opencodeBin,
        env: { FAKE_OPENCODE_MODE: "unhealthy" },
        timeoutMs: 300,
        _parentApprovedRisks: ["high-risk-start"],
      }, { directory: projectDir }),
      /child health check timed out/,
    );

    await assertStoppedClean(registry, id);
  });
});

test("startChild fails closed when a required startup route is missing", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const id = "child_missing_required_route";

    await assert.rejects(
      () => startChild(registry, {
        id,
        opencodeBin,
        env: { FAKE_OPENCODE_MISSING_ROUTES: "/session/status" },
        timeoutMs: 3000,
        _parentApprovedRisks: ["high-risk-start"],
      }, { directory: projectDir }),
      /OpenCode 1\.17\.13 compatibility check failed: missing required startup route\(s\): GET \/session\/status/,
    );

    await assertStoppedClean(registry, id);
  });
});

test("startChild degrades optional inspection routes into capability flags", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const child = await startChild(registry, {
      id: "child_missing_optional_route",
      opencodeBin,
      env: { FAKE_OPENCODE_MISSING_ROUTES: "/experimental/tool/ids" },
      timeoutMs: 3000,
      _parentApprovedRisks: ["high-risk-start"],
    }, { directory: projectDir });

    assert.equal(child.status, "ready");
    assert.equal(child.capabilities["/experimental/tool/ids"].ok, false);
    assert.equal(child.capabilities["/experimental/tool/ids"].status, 404);
    assert.match(child.startupInspection.tools.error, /GET \/experimental\/tool\/ids failed 404/);

    await stopChild(registry, child.id, {
      cleanup: true,
      includeStale: true,
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
    });
  });
});

test("startChild cleans up spawned processes and managed dirs when registry insert fails", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    class InsertFailingRegistry extends ChildRegistry {
      async insert(child) {
        this.child = child;
        throw new Error("forced insert failure");
      }
    }

    const failing = new InsertFailingRegistry(registry.stateDir);
    await assert.rejects(
      () => startChild(failing, {
        id: "child_insert_failure",
        opencodeBin,
        timeoutMs: 3000,
        _parentApprovedRisks: ["high-risk-start"],
      }, { directory: projectDir }),
      /forced insert failure/,
    );

    assert.ok(failing.child?.pid, "spawned child should be captured before insert failure");
    assert.equal(isPidAlive(failing.child.pid), false);
    assert.equal(_test.liveProcesses.has("child_insert_failure"), false);
    assert.equal(_test.eventReaders.has("child_insert_failure"), false);
    for (const dir of failing.child.managedDirs) assert.equal(await exists(dir), false, dir);
  });
});

test("startChild enforces the live-child concurrency cap before spawning", async () => {
  await withStartupFixture(async ({ projectDir, registry }) => {
    const originalKill = process.kill;
    const targetPid = 765432;
    process.kill = (pid, signal) => {
      if (Math.abs(pid) === targetPid && (signal === 0 || signal === undefined)) return true;
      if (Math.abs(pid) === targetPid) return true;
      return originalKill(pid, signal);
    };
    const existingKey = _test.lifecycleKey(registry, "child_existing_live");
    _test.liveProcesses.set(existingKey, { pid: targetPid });

    try {
      await assert.rejects(
        () => startChild(registry, { maxConcurrent: 1 }, { directory: projectDir }),
        /concurrency cap reached: 1\/1/,
      );
    } finally {
      _test.liveProcesses.delete(existingKey);
      process.kill = originalKill;
    }
  });
});

test("startup serialization is scoped by registry stateDir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-start-queues-"));
  const stateA = path.join(root, "state-a");
  const stateB = path.join(root, "state-b");
  await mkdir(stateA, { recursive: true });
  await mkdir(stateB, { recursive: true });
  const seedA = new ChildRegistry(stateA);
  await seedA.upsert({ id: "slow", status: "ready", pid: 2147483646, baseUrl: "http://127.0.0.1:8" });
  let releaseA;
  let enteredA;
  const entered = new Promise((resolve) => { enteredA = resolve; });
  class SlowLoadRegistry extends ChildRegistry {
    async load() {
      enteredA();
      await new Promise((resolve) => { releaseA = resolve; });
      return await super.load();
    }
  }
  const registryA = new SlowLoadRegistry(stateA);
  const registryB = new ChildRegistry(stateB);
  await registryB.upsert({ id: "duplicate", status: "ready", pid: 2147483646, baseUrl: "http://127.0.0.1:9" });
  const first = startChild(registryA, { id: "slow" }, { directory: root });
  try {
    await entered;
    await assert.rejects(
      Promise.race([
        startChild(registryB, { id: "duplicate" }, { directory: root }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("unrelated registry start was blocked")), 500)),
      ]),
      /child id already exists: duplicate/,
    );
  } finally {
    releaseA?.();
    await first.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("provisionStartValues cleans attempt-owned directories when port allocation fails", async () => {
  const before = await managedTempDirs();
  const allocationError = new Error("forced allocator failure");
  await assert.rejects(
    () => _test.provisionStartValues({}, {}, { allocatePort: async () => { throw allocationError; } }),
    (error) => error === allocationError,
  );
  assert.deepEqual(await managedTempDirs(), before);
});

test("duplicate active child validation cleans directories created by the rejected attempt", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const args = {
      id: "child_duplicate_cleanup",
      opencodeBin,
      timeoutMs: 3000,
      _parentApprovedRisks: ["high-risk-start"],
    };
    const child = await startChild(registry, args, { directory: projectDir });
    const before = await managedTempDirs();

    await assert.rejects(() => startChild(registry, args, { directory: projectDir }), /child id already exists/);
    assert.deepEqual(await managedTempDirs(), before);

    await stopChild(registry, child.id, {
      cleanup: true,
      includeStale: true,
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
    });
  });
});

test("the concurrency cap counts only live children in the current registry's state dir", async () => {
  await withStartupFixture(async ({ root, projectDir, registry }) => {
    // A second, disjoint project/registry with its own state dir but ZERO of its
    // own children. A live child in the OTHER project's state dir must not count
    // against this project's cap (per-project isolation).
    const otherStateDir = path.join(root, "other-state");
    await mkdir(otherStateDir, { recursive: true });
    const otherRegistry = new ChildRegistry(otherStateDir);

    const originalKill = process.kill;
    const targetPid = 765432;
    process.kill = (pid, signal) => {
      if (Math.abs(pid) === targetPid) return true;
      return originalKill(pid, signal);
    };

    // Fill project A up to its cap of 1 with a fake live child.
    const otherKey = _test.lifecycleKey(otherRegistry, "child_in_other_project");
    _test.liveProcesses.set(otherKey, { pid: targetPid });

    try {
      // Sanity: the other project sees itself at the cap and rejects.
      assert.equal(_test.countLiveForRegistry(otherRegistry), 1);
      await assert.rejects(
        () => startChild(otherRegistry, { maxConcurrent: 1 }, { directory: projectDir }),
        /concurrency cap reached: 1\/1/,
      );

      // This project has none of its own live children, so its cap of 1 is free.
      assert.equal(_test.countLiveForRegistry(registry), 0);
    } finally {
      _test.liveProcesses.delete(otherKey);
      process.kill = originalKill;
    }
  });
});

test("startChild retries on an EADDRINUSE startup failure and starts on a fresh port", async () => {
  await withStartupFixture(async ({ root, projectDir, registry, opencodeBin }) => {
    const marker = path.join(root, "eaddrinuse-marker");
    const child = await startChild(registry, {
      id: "child_eaddrinuse_retry",
      opencodeBin,
      env: { FAKE_OPENCODE_MODE: "eaddrinuse-once", FAKE_OPENCODE_MARKER: marker },
      timeoutMs: 1000,
      _parentApprovedRisks: ["high-risk-start"],
    }, { directory: projectDir });

    const firstPort = Number(await readFile(marker, "utf8"));
    assert.equal(child.status, "ready");
    assert.notEqual(child.port, firstPort);
    assert.equal((await registry.get(child.id)).status, "ready");
    assert.equal(_test.liveProcesses.has(_test.lifecycleKey(registry, child.id)), true);

    await stopChild(registry, child.id, {
      cleanup: true,
      includeStale: true,
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
    });
    await assertStoppedClean(registry, child.id);
  });
});

test("startChild rejects health responses from a port not owned by the spawned child", async () => {
  await withStartupFixture(async ({ projectDir, registry, opencodeBin }) => {
    const id = "child_port_spoof";
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/global/health") {
        res.end(JSON.stringify({ ok: true, spoofed: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "spoof server" }));
    });
    await listenLoopback(server);
    try {
      await assert.rejects(
        () => startChild(registry, {
          id,
          opencodeBin,
          port: server.address().port,
          env: { FAKE_OPENCODE_MODE: "idle" },
          timeoutMs: 1000,
          _parentApprovedRisks: ["high-risk-start"],
        }, { directory: projectDir }),
        /child port ownership check failed/,
      );

      await assertStoppedClean(registry, id);
    } finally {
      await closeServer(server);
    }
  });
});
