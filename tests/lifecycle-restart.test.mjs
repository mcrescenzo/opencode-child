import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChildRegistry } from "../src/registry.js";
import { disposeLifecycleState, restartChild, stopChild, _test } from "../src/lifecycle.js";
import { writeFakeOpencodeBin } from "./helpers/fake-opencode.mjs";

test("restartChild stops the previous registry row and starts a replacement child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-restart-success-"));
  const stateDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  const configDir = path.join(root, "config");
  const dataDir = path.join(root, "data");
  const cacheDir = path.join(root, "cache");
  const xdgStateDir = path.join(root, "xdg-state");
  const id = "child_restart_success";
  try {
    const opencodeBin = await writeFakeOpencodeBin(root);
    await mkdir(stateDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id,
      pid: 2147483646,
      status: "ready",
      baseUrl: "http://192.0.2.1:9",
      projectDir,
      configDir,
      dataDir,
      cacheDir,
      xdgStateDir,
      managedDirs: [configDir, dataDir, cacheDir, xdgStateDir],
      inheritData: false,
      cleanupPolicy: "keep",
      trustMode: "inherit",
      spec: {
        id,
        projectDir,
        configDir,
        dataDir,
        cacheDir,
        xdgStateDir,
        managedDirs: [configDir, dataDir, cacheDir, xdgStateDir],
        inheritData: false,
        cleanupPolicy: "keep",
        trustMode: "inherit",
        opencodeBin,
      },
    });

    const restartSpec = _test.buildRestartSpec(await registry.get(id), { timeoutMs: 3000, port: 40001 });
    assert.deepEqual(new Set(restartSpec._parentApprovedRisks), new Set(["high-risk-start", "external-dirs"]));
    assert.equal(restartSpec.allowExternalDirs, true);

    const result = await restartChild(registry, id, { timeoutMs: 3000 }, { directory: projectDir });

    assert.equal(result.oldPid, 2147483646);
    assert.equal(result.stop.stopped, true);
    assert.equal(result.stop.processAlive, false);
    assert.equal(result.child.id, id);
    assert.equal(result.child.status, "ready");
    assert.notEqual(result.newPid, 2147483646);
    assert.equal(_test.liveProcesses.has(_test.lifecycleKey(registry, id)), true);

    const persisted = await registry.get(id);
    assert.equal(persisted.status, "ready");
    assert.equal(persisted.pid, result.newPid);

    await stopChild(registry, id, {
      cleanup: true,
      includeStale: true,
      allowRegistryPidSignal: true,
      graceMs: 0,
      termGraceMs: 0,
      disposeTimeoutMs: 500,
    });
  } finally {
    await disposeLifecycleState({ terminateOptions: { graceMs: 0 } }).catch(() => {});
    _test.liveProcesses.delete(id);
    _test.eventReaders.delete(id);
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("restartChild refuses to start a replacement when the previous child remains alive", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-restart-guard-state-"));
  const originalKill = process.kill;
  const targetPid = 876543;
  process.kill = (pid, signal) => {
    if (Math.abs(pid) === targetPid && (signal === 0 || signal === undefined)) return true;
    if (Math.abs(pid) === targetPid) return true;
    return originalKill(pid, signal);
  };

  try {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_restart_guard",
      pid: targetPid,
      status: "ready",
      baseUrl: "http://192.0.2.1:9",
      cleanupPolicy: "keep",
      spec: { id: "child_restart_guard", cleanupPolicy: "keep" },
    });

    await assert.rejects(
      () => restartChild(registry, "child_restart_guard", { timeoutMs: 50 }, { directory: stateDir }),
      /previous child is still alive or unverified/,
    );
  } finally {
    process.kill = originalKill;
    await rm(stateDir, { recursive: true, force: true }).catch(() => {});
  }
});
