import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  MAX_TRACKED_PROJECTS,
  __moduleStateSizes,
  __notificationManagerTest,
} from "../src/index-core.js";
import { withTempDir } from "./helpers.mjs";

async function withIsolatedManagerCache(fn) {
  await withTempDir("opencode-child-manager-xdg-", async (xdgRoot) => {
    const previousStateDir = process.env.OPENCODE_CHILD_STATE_DIR;
    const previousXdgStateHome = process.env.XDG_STATE_HOME;
    delete process.env.OPENCODE_CHILD_STATE_DIR;
    process.env.XDG_STATE_HOME = xdgRoot;
    await __notificationManagerTest.disposeModuleState();
    try {
      await fn(xdgRoot);
    } finally {
      await __notificationManagerTest.disposeModuleState();
      if (previousStateDir === undefined) delete process.env.OPENCODE_CHILD_STATE_DIR;
      else process.env.OPENCODE_CHILD_STATE_DIR = previousStateDir;
      if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  });
}

async function fillManagerCache(projectsRoot) {
  const entries = [];
  for (let i = 0; i < MAX_TRACKED_PROJECTS; i += 1) {
    const context = { directory: path.join(projectsRoot, `project-${i}`), sessionID: `parent-${i}` };
    const registry = __notificationManagerTest.registryFor(context);
    const manager = await __notificationManagerTest.notificationManagerFor(registry, {});
    entries.push({ context, registry, manager, stateDir: registry.stateDir });
  }
  return entries;
}

test("notification manager admission cap preserves state and rebinds only to newer registries", async () => {
  await withIsolatedManagerCache(async (projectsRoot) => {
    const entries = await fillManagerCache(projectsRoot);
    const first = entries[0];
    const target = { sessionID: "parent-owner", directory: first.context.directory };
    first.manager.registerChildOwner("child-active", target);
    first.manager.registerPromptWatch("child-active", "session-active", target);
    first.manager.expectedStops.add("child-active");
    first.manager.setPending("pending-active", {
      kind: "session-idle",
      childId: "child-active",
      childSessionId: "session-active",
      target,
      createdAt: new Date(0).toISOString(),
    });
    const stateBeforeRefusal = first.manager.childState("child-active");

    const refusedRegistry = __notificationManagerTest.registryFor({ directory: path.join(projectsRoot, "project-refused") });
    await assert.rejects(
      () => __notificationManagerTest.notificationManagerFor(refusedRegistry, {}),
      (error) => {
        assert.match(error.message, new RegExp(`capacity ${MAX_TRACKED_PROJECTS}`));
        assert.ok(error.message.includes(refusedRegistry.stateDir), error.message);
        return true;
      },
    );

    assert.equal(__moduleStateSizes().notificationManagers, MAX_TRACKED_PROJECTS);
    assert.deepEqual(first.manager.childState("child-active"), stateBeforeRefusal);
    for (const entry of entries) {
      assert.equal(__notificationManagerTest.managerFor(entry.stateDir), entry.manager, `manager evicted for ${entry.stateDir}`);
    }
    assert.equal(
      await __notificationManagerTest.notificationManagerFor(first.registry, {}),
      first.manager,
      "an existing project remains serviceable at capacity",
    );

    const oldGeneration = __notificationManagerTest.registryGeneration(first.registry);
    const newerRegistry = __notificationManagerTest.registryFor(first.context);
    const newerGeneration = __notificationManagerTest.registryGeneration(newerRegistry);
    assert.ok(newerGeneration > oldGeneration);
    assert.equal(await __notificationManagerTest.notificationManagerFor(newerRegistry, {}), first.manager);
    assert.equal(first.manager.registry, newerRegistry);
    assert.equal(__notificationManagerTest.managerRegistryGeneration(first.manager), newerGeneration);

    await __notificationManagerTest.notificationManagerFor(first.registry, {});
    assert.equal(first.manager.registry, newerRegistry, "a stale caller must not restore the old registry");
    assert.equal(__notificationManagerTest.managerRegistryGeneration(first.manager), newerGeneration);
  });
});

test("disposal rejects new admissions and awaits every manager at capacity", async () => {
  await withIsolatedManagerCache(async (projectsRoot) => {
    const entries = await fillManagerCache(projectsRoot);
    let releaseBlocked;
    let blockedEntered;
    let disposed = 0;
    const blocked = new Promise((resolve) => { blockedEntered = resolve; });
    const release = new Promise((resolve) => { releaseBlocked = resolve; });
    for (const entry of entries) {
      entry.manager.dispose = async () => {
        disposed += 1;
        if (entry === entries[0]) {
          blockedEntered();
          await release;
        }
      };
    }

    let disposalSettled = false;
    const disposal = __notificationManagerTest.disposeModuleState().finally(() => { disposalSettled = true; });
    await blocked;
    assert.equal(__notificationManagerTest.isDisposing(), true);
    assert.equal(disposalSettled, false);

    const refusedRegistry = __notificationManagerTest.registryFor({ directory: path.join(projectsRoot, "during-disposal") });
    await assert.rejects(
      () => __notificationManagerTest.notificationManagerFor(refusedRegistry, {}),
      (error) => error.message.includes("admission refused while disposing") && error.message.includes(refusedRegistry.stateDir),
    );
    assert.equal(__moduleStateSizes().notificationManagers, MAX_TRACKED_PROJECTS);

    releaseBlocked();
    await disposal;
    assert.equal(disposed, MAX_TRACKED_PROJECTS);
    assert.deepEqual(__moduleStateSizes(), { registries: 0, notificationManagers: 0 });
    assert.equal(__notificationManagerTest.isDisposing(), false);
  });
});
