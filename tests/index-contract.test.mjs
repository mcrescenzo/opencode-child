import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ChildRegistry, defaultStateDir } from "../src/registry.js";
import { childStartRacedStop, createBoundedMap, __hasNotificationManagerForTest, __moduleStateSizes, createOpenCodeChildPlugin, MAX_TOOL_ARG_JSON_CHARS, MAX_TOOL_ARG_STRING_CHARS } from "../src/index-core.js";
import { createChildDiagnostics } from "../src/diagnostics.js";
import { MAX_TOOL_TIMEOUT_MS, _test as lifecycleTest } from "../src/lifecycle.js";
import {
  BEARER_SECRET,
  CHILD_PASSWORD,
  OpenCodeChildPlugin,
  assertNoSecrets,
  diagnosticLines,
  withMockChildServer,
  withTempDir,
  withDiagnosticsRoot,
  withPluginContext,
} from "./helpers.mjs";

function makeTrackingSchema() {
  const makeNode = (kind) => {
    const calls = [];
    let proxy;
    const fn = () => proxy;
    proxy = new Proxy(fn, {
      get(_target, prop) {
        if (prop === "__kind") return kind;
        if (prop === "__calls") return calls;
        return (...args) => {
          calls.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return new Proxy({}, {
    get(_target, prop) {
      return () => makeNode(String(prop));
    },
  });
}

test("child diagnostics emit standardized redacted JSONL and no-op on bad storage", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await createChildDiagnostics({ directory: "/tmp/x" }).emit({
      level: "error",
      event: "child_start_failed",
      message: `Failed with ${BEARER_SECRET}`,
      childID: "child_1",
      error: new Error("token=abc123456789"),
      data: { serverPassword: CHILD_PASSWORD, authToken: "auth-token-secret", clientSecret: "client-secret-value", safe: true },
    });
    const lines = await diagnosticLines(diagRoot);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.schema, "opencode.plugin.diagnostic.v1");
    assert.equal(record.plugin, "opencode-child");
    assert.equal(record.childID, "child_1");
    assert.equal(record.data.serverPassword, "[redacted]");
    assert.equal(record.data.authToken, "[redacted]");
    assert.equal(record.data.clientSecret, "[redacted]");
    assertNoSecrets(lines[0]);

    const fileRoot = path.join(diagRoot, "not-a-directory");
    await writeFile(fileRoot, "x", "utf8");
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = fileRoot;
    await assert.doesNotReject(() => createChildDiagnostics({ directory: "/tmp/x" }).emit({ level: "error", event: "bad_storage", message: "bad" }));
  });
});

test("oc_child_start warning classifier flags a start that raced a concurrent stop/restart", () => {
  // Normal successful start: inspectReadyChild returns status "ready", no expectedStop.
  assert.equal(childStartRacedStop({ id: "child_1", status: "ready" }), false);
  assert.equal(childStartRacedStop({ id: "child_1", status: "ready", expectedStop: false }), false);
  // C05 raced returns: {...child, ...concurrent/persisted} carries a terminal status or expectedStop.
  assert.equal(childStartRacedStop({ id: "child_1", status: "stopped" }), true);
  assert.equal(childStartRacedStop({ id: "child_1", status: "stopping" }), true);
  assert.equal(childStartRacedStop({ id: "child_1", status: "ready", expectedStop: true }), true);
  assert.equal(childStartRacedStop({ id: "child_1", expectedStop: true }), true);
  // Predicate is always a boolean and tolerates missing/undefined values.
  assert.equal(childStartRacedStop({ id: "child_1" }), false);
  assert.equal(childStartRacedStop(undefined), false);
});

test("createBoundedMap evicts the least-recently-used entry past its cap", () => {
  const evicted = [];
  const m = createBoundedMap(2, (value, key) => evicted.push([key, value]));
  m.set("a", 1);
  m.set("b", 2);
  assert.equal(m.size, 2);
  // touch "a" so "b" becomes the least-recently-used entry
  assert.equal(m.get("a"), 1);
  m.set("c", 3); // exceeds cap of 2 -> evict "b"
  assert.equal(m.size, 2);
  assert.equal(m.has("b"), false);
  assert.equal(m.get("a"), 1);
  assert.equal(m.get("c"), 3);
  assert.deepEqual(evicted, [["b", 2]]);
  // clear(true) runs the eviction callback for every remaining entry
  m.clear(true);
  assert.equal(m.size, 0);
  assert.deepEqual(evicted.map(([k]) => k).sort(), ["a", "b", "c"]);
});

test("createBoundedMap handles zero limit and explicit deletes", () => {
  const evicted = [];
  const zero = createBoundedMap(0, (value, key) => evicted.push([key, value]));
  assert.equal(zero.set("a", 1), zero);
  assert.equal(zero.size, 0);
  assert.equal(zero.has("a"), false);
  assert.equal(zero.get("a"), undefined);
  assert.deepEqual(evicted, [["a", 1]]);

  const deleted = [];
  const m = createBoundedMap(2, (value, key) => deleted.push([key, value]));
  m.set("a", 1).set("b", 2);
  assert.equal(m.delete("a"), true);
  assert.equal(m.delete("a"), false);
  assert.equal(m.has("a"), false);
  assert.equal(m.size, 1);
  assert.deepEqual([...m.values()], [2]);
  assert.deepEqual(deleted, []);
});

test("the plugin exposes a dispose hook that tears down the module-level caches", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      assert.equal(typeof plugin.dispose, "function");
      // The failing stop path still constructs the registry + notification
      // manager (both arguments evaluate) before stopChild throws, so this
      // populates both module-level caches.
      await assert.rejects(
        () => plugin.tool.oc_child_stop.execute({ childId: "child_missing" }, context),
        /unknown child: child_missing/,
      );
      const before = __moduleStateSizes();
      assert.ok(before.registries >= 1 && before.notificationManagers >= 1, JSON.stringify(before));

      await plugin.dispose();

      const after = __moduleStateSizes();
      assert.equal(after.registries, 0);
      assert.equal(after.notificationManagers, 0);
    });
  });
});

test("notification manager capacity refusal preserves managers for projects with active children", async () => {
  await withTempDir("opencode-child-index-xdg-", async (xdgRoot) => {
    await withTempDir("opencode-child-index-projects-", async (projectsRoot) => {
      const previousStateDir = process.env.OPENCODE_CHILD_STATE_DIR;
      const previousXdgStateHome = process.env.XDG_STATE_HOME;
      let plugin;
      delete process.env.OPENCODE_CHILD_STATE_DIR;
      process.env.XDG_STATE_HOME = xdgRoot;
      try {
        plugin = await OpenCodeChildPlugin({});
        await plugin.dispose();
        const activeProjectDir = path.join(projectsRoot, "project-active");
        const activeStateDir = defaultStateDir(activeProjectDir);
        const activeRegistry = new ChildRegistry(activeStateDir);
        await activeRegistry.load();
        await activeRegistry.insert({
          id: "child_active",
          pid: 2147483646,
          status: "ready",
          baseUrl: "http://127.0.0.1:1",
        });

        for (let i = 0; i < 64; i += 1) {
          const projectDir = i === 0 ? activeProjectDir : path.join(projectsRoot, `project-${i}`);
          await assert.rejects(
            () => plugin.tool.oc_child_stop.execute({ childId: `missing_${i}` }, { directory: projectDir, sessionID: `parent_${i}` }),
            /unknown child/,
          );
        }

        const refusedProjectDir = path.join(projectsRoot, "project-refused");
        const refusedStateDir = defaultStateDir(refusedProjectDir);
        await assert.rejects(
          () => plugin.tool.oc_child_stop.execute({ childId: "missing_refused" }, { directory: refusedProjectDir, sessionID: "parent_refused" }),
          (error) => error.message.includes("capacity 64") && error.message.includes(refusedStateDir),
        );

        assert.equal(__hasNotificationManagerForTest(activeStateDir), true);
        assert.equal(__moduleStateSizes().notificationManagers, 64);
      } finally {
        await plugin?.dispose?.();
        if (previousStateDir === undefined) delete process.env.OPENCODE_CHILD_STATE_DIR;
        else process.env.OPENCODE_CHILD_STATE_DIR = previousStateDir;
        if (previousXdgStateHome === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousXdgStateHome;
      }
    });
  });
});

test("plugin dispose aborts lifecycle event readers and drops live process handles", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin }) => {
      const controller = { aborted: false, abort() { this.aborted = true; } };
      lifecycleTest.eventReaders.set("child_dispose", controller);
      lifecycleTest.liveProcesses.set("child_dispose", { pid: 2147483646 });

      await plugin.dispose();

      assert.equal(controller.aborted, true);
      assert.equal(lifecycleTest.eventReaders.size, 0);
      assert.equal(lifecycleTest.liveProcesses.size, 0);
    });
  });
});

test("plugin dispose retains notification managers until process-exit handling settles", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context, stateDir }) => {
      await assert.rejects(
        () => plugin.tool.oc_child_stop.execute({ childId: "child_missing_exit_wait" }, context),
        /unknown child/,
      );
      const proc = new EventEmitter();
      proc.pid = 2147483646;
      let releaseExit;
      let handlerSawManager;
      lifecycleTest.liveProcesses.set("child_delayed_exit", proc);
      lifecycleTest.trackProcessExit(proc, async () => {
        await new Promise((resolve) => { releaseExit = resolve; });
        handlerSawManager = __hasNotificationManagerForTest(stateDir);
      });
      proc.emit("exit", 0, null);

      const disposing = plugin.dispose();
      await Promise.resolve();
      assert.equal(__hasNotificationManagerForTest(stateDir), true);
      releaseExit();
      await disposing;
      assert.equal(handlerSawManager, true);
      assert.equal(__hasNotificationManagerForTest(stateDir), false);
    });
  });
});

test("childId-scoped tools enforce persisted child ownership", async () => {
  await withPluginContext(async ({ plugin, context, stateDir, projectDir }) => {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_owned",
      pid: 2147483647,
      status: "exited",
      baseUrl: "http://127.0.0.1:1",
      owner: { sessionID: "owner_session", directory: projectDir },
    });

    await assert.rejects(
      () => plugin.tool.oc_inspect.execute({ childId: "child_owned", timeoutMs: 50 }, context),
      /parent approval required for inspect\.cross-owner/,
    );

    let approval;
    const approved = await plugin.tool.oc_inspect.execute({ childId: "child_owned", timeoutMs: 50 }, {
      ...context,
      async ask(request) {
        approval = request;
        return { status: "approved" };
      },
    });
    assert.equal(approval.permission, "opencode-child.inspect.cross-owner");
    assert.equal(approval.metadata.childId, "child_owned");
    assert.equal(approved.metadata.childId, "child_owned");
  });
});

test("oc_child_stop bulk 'all' gates cross-owner children behind parent approval", async () => {
  await withPluginContext(async ({ plugin, context, stateDir, projectDir }) => {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_foreign",
      pid: 2147483647,
      status: "running",
      baseUrl: "http://127.0.0.1:1",
      owner: { sessionID: "other_session", directory: projectDir },
    });

    // No context.ask supplied: the bulk gate must reject before stopChild runs.
    await assert.rejects(
      () => plugin.tool.oc_child_stop.execute({ childId: "all", confirmAll: true, timeoutMs: 50 }, context),
      /parent approval required for stop\.cross-owner/,
    );

    let approval;
    await plugin.tool.oc_child_stop.execute({ childId: "all", confirmAll: true, timeoutMs: 50 }, {
      ...context,
      async ask(request) {
        approval = request;
        return { status: "approved" };
      },
    }).catch(() => {});
    assert.equal(approval.permission, "opencode-child.stop.cross-owner");
    assert.deepEqual(approval.metadata.childIds, ["child_foreign"]);
  });
});

test("oc_child_stop bulk 'all' skips approval when no foreign non-terminal children exist", async () => {
  await withPluginContext(async ({ plugin, context, stateDir, projectDir }) => {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_mine",
      pid: 2147483647,
      status: "running",
      baseUrl: "http://127.0.0.1:1",
      owner: { sessionID: context.sessionID, directory: projectDir },
    });
    await registry.upsert({
      id: "child_foreign_terminal",
      pid: 2147483647,
      status: "exited",
      baseUrl: "http://127.0.0.1:1",
      owner: { sessionID: "other_session", directory: projectDir },
    });

    let asked = false;
    await plugin.tool.oc_child_stop.execute({ childId: "all", confirmAll: true, timeoutMs: 50 }, {
      ...context,
      async ask(request) {
        asked = true;
        return { status: "approved" };
      },
    }).catch(() => {});
    assert.equal(asked, false);
  });
});

test("childId-scoped tools allow matching owners and legacy ownerless rows", async () => {
  await withPluginContext(async ({ plugin, context, stateDir, projectDir }) => {
    const registry = new ChildRegistry(stateDir);
    await registry.upsert({
      id: "child_same_owner",
      pid: 2147483647,
      status: "exited",
      baseUrl: "http://127.0.0.1:1",
      owner: { sessionID: context.sessionID, directory: projectDir },
    });
    await registry.upsert({
      id: "child_legacy",
      pid: 2147483647,
      status: "exited",
      baseUrl: "http://127.0.0.1:1",
    });

    const owned = await plugin.tool.oc_inspect.execute({ childId: "child_same_owner", timeoutMs: 50 }, context);
    const legacy = await plugin.tool.oc_inspect.execute({ childId: "child_legacy", timeoutMs: 50 }, context);
    assert.equal(owned.metadata.childId, "child_same_owner");
    assert.equal(legacy.metadata.childId, "child_legacy");
  });
});

test("oc_command schema exposes separate providerID and modelID fields", async () => {
  await withPluginContext(async ({ plugin }) => {
    assert.equal(Object.hasOwn(plugin.tool.oc_command.args, "providerID"), true);
    assert.equal(Object.hasOwn(plugin.tool.oc_command.args, "modelID"), true);
  });
});

test("public timeout schemas are capped at the shared hard ceiling", async () => {
  const toolStub = (definition) => definition;
  toolStub.schema = makeTrackingSchema();
  const plugin = await createOpenCodeChildPlugin(toolStub)({});
  const timeoutArgs = [];
  for (const [toolName, definition] of Object.entries(plugin.tool)) {
    for (const [argName, schema] of Object.entries(definition.args || {})) {
      if (argName === "timeoutMs" || argName === "httpTimeoutMs" || argName === "disposeTimeoutMs" || argName === "pollIntervalMs" || argName === "settleGraceMs") {
        timeoutArgs.push({ toolName, argName, calls: schema.__calls });
      }
    }
  }

  assert.ok(timeoutArgs.length > 0);
  for (const { toolName, argName, calls } of timeoutArgs) {
    assert.deepEqual(calls.find(([name]) => name === "max"), ["max", [MAX_TOOL_TIMEOUT_MS]], `${toolName}.${argName}`);
  }
});

test("tool execution rejects oversized string arguments before downstream handling", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await assert.rejects(
      () => plugin.tool.oc_prompt.execute({
        childId: "child_huge_prompt",
        text: "x".repeat(MAX_TOOL_ARG_STRING_CHARS + 1),
      }, context),
      /oc_prompt\.text exceeds max argument string length/,
    );
  });
});

test("tool execution rejects oversized object arguments before config writes", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    const chunk = "x".repeat(Math.floor(MAX_TOOL_ARG_STRING_CHARS * 0.9));
    const config = Object.fromEntries(Array.from({ length: Math.ceil(MAX_TOOL_ARG_JSON_CHARS / chunk.length) + 1 }, (_, index) => [`unknown${index}`, chunk]));
    await assert.rejects(
      () => plugin.tool.oc_child_start.execute({
        id: "child_huge_config",
        config,
      }, context),
      /oc_child_start\.config exceeds max argument JSON size/,
    );
  });
});

test("approval-required tools reject oversized arguments before parent approval", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    let asked = false;
    await assert.rejects(
      () => plugin.tool.oc_command.execute({
        childId: "child_huge_command",
        sessionId: "ses_child",
        command: "x".repeat(MAX_TOOL_ARG_STRING_CHARS + 1),
      }, {
        ...context,
        async ask() {
          asked = true;
          return { status: "approved" };
        },
      }),
      /oc_command\.command exceeds max argument string length/,
    );
    assert.equal(asked, false);
  });
});

test("failing child tool emits a diagnostic without changing failure behavior", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await assert.rejects(
        () => plugin.tool.oc_child_stop.execute({ childId: "child_missing" }, context),
        /unknown child: child_missing/,
      );
      const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
      assert.ok(records.some((record) => record.event === "child_stop_failed" && record.childID === "child_missing"));
    });
  });
});

test("failed oc_child_start records the resolved fallback childID", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await assert.rejects(
        () => plugin.tool.oc_child_start.execute(
          { id: "child_diag_test", opencodeBin: "/nonexistent/opencode-bin-xyz", timeoutMs: 200 },
          { ...context, async ask() { return { status: "approved" }; } },
        ),
      );
      const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
      const failure = records.find((record) => record.event === "child_start_failed");
      assert.ok(failure, "expected a child_start_failed diagnostic record");
      assert.equal(failure.childID, "child_diag_test");
    });
  });
});

test("oc_prompt records a warning when an async prompt times out before settling", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await withMockChildServer((req, res) => {
        req.resume();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        // prompt_async is accepted, but /session/status always reports the
        // target session as busy so pollUntilSettled never settles and the
        // poll loop exhausts timeoutMs -> {timedOut:true,...}.
        if (req.url === "/session/status") {
          res.end(JSON.stringify({ ses_stuck: "busy" }));
          return;
        }
        res.end(JSON.stringify({}));
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_timeout",
          status: "ready",
          pid: process.pid,
          baseUrl,
        });

        await plugin.tool.oc_prompt.execute({
          childId: "child_timeout",
          sessionId: "ses_stuck",
          text: "hello",
          httpTimeoutMs: 200,
          timeoutMs: 250,
          pollIntervalMs: 50,
          settleGraceMs: 0,
        }, context);

        const prompts = (await diagnosticLines(diagRoot))
          .map((line) => JSON.parse(line))
          .filter((r) => r.tool === "oc_prompt");
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        const record = prompts[0];
        assert.equal(record.event, "child_prompt_warning");
        assert.equal(record.outcome, "warning");
        assert.equal(record.level, "warn");
        assert.equal(record.data.timedOut, true);
      });
    });
  });
});

test("oc_child_stop requires confirmAll for all stop-all childId spellings", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      for (const childId of ["", "all"]) {
        await assert.rejects(
          () => plugin.tool.oc_child_stop.execute({ childId }, context),
          /stopping all children requires confirmAll=true/,
        );
      }

      const result = await plugin.tool.oc_child_stop.execute({ childId: "", confirmAll: true }, context);
      assert.deepEqual(result.metadata, []);
    });
  });
});
