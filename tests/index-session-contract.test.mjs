import test from "node:test";
import assert from "node:assert/strict";
import { ChildRegistry, defaultStateDir } from "../src/registry.js";
import {
  API_KEY_SECRET,
  BASIC_SECRET,
  BEARER_SECRET,
  CHILD_PASSWORD,
  assertNoSecrets,
  diagnosticLines,
  withDiagnosticsRoot,
  withMockChildServer,
  withPluginContext,
} from "./helpers.mjs";

test("oc_prompt emits a redacted child_prompt_warning in place of success when the result carries a diagnostic", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await withMockChildServer((req, res) => {
        req.resume();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(req.url === "/session/status" ? {} : []));
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_diag",
          status: "ready",
          pid: process.pid,
          baseUrl,
          inheritData: false,
          logs: [`ProviderModelNotFoundError: Model not found: openai/gpt-5.5 with ${BEARER_SECRET}`],
        });

        // success behavior preserved: returns a result, does not throw
        const res = await plugin.tool.oc_prompt.execute({
          childId: "child_diag",
          sessionId: "ses_child",
          text: "hi",
          httpTimeoutMs: 200,
          timeoutMs: 1000,
          settleGraceMs: 0,
        }, context);
        assert.ok(res);

        const prompts = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line)).filter((r) => r.tool === "oc_prompt");
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        const warning = prompts[0];
        assert.equal(warning.event, "child_prompt_warning");
        assert.equal(warning.level, "warn");
        assert.equal(warning.childID, "child_diag");
        // bounded: only the summary fields, no raw logs/transcript/inspection/auth
        assert.deepEqual(Object.keys(warning.data).sort(), ["async", "diagnostic", "timedOut"]);
        assert.equal(typeof warning.data.diagnostic, "string");
        assert.equal(warning.data.async, true);
        assert.equal(warning.data.timedOut, false);
        assertNoSecrets(JSON.stringify(prompts));
      });
    });
  });
});

test("session wrapper ok:false results emit warning diagnostics", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await withMockChildServer((req, res) => {
        req.resume();
        res.setHeader("content-type", "application/json");
        if (req.url === "/session/ses_child/command") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: `command failed ${BEARER_SECRET}` }));
          return;
        }
        if (req.url === "/session/ses_child/shell") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `shell missing ${BASIC_SECRET}` }));
          return;
        }
        if (req.url === "/session/ses_child/permissions/perm_1") {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: `permission missing ${API_KEY_SECRET}` }));
          return;
        }
        if (req.url === "/permission/perm_1/reply") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: `permission fallback failed ${CHILD_PASSWORD}` }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_http_failures",
          status: "ready",
          pid: process.pid,
          baseUrl,
        });

        const command = await plugin.tool.oc_command.execute({
          childId: "child_http_failures",
          sessionId: "ses_child",
          command: "build",
          timeoutMs: 500,
        }, { ...context, ask: async () => ({ status: "approved" }) });
        assert.equal(command.metadata.ok, false);
        assert.equal(command.metadata.status, 500);

        const shell = await plugin.tool.oc_shell.execute({
          childId: "child_http_failures",
          sessionId: "ses_child",
          command: "npm test",
          timeoutMs: 500,
        }, { ...context, ask: async () => ({ status: "approved" }) });
        assert.equal(shell.metadata.ok, false);
        assert.equal(shell.metadata.status, 404);

        const permission = await plugin.tool.oc_permission.execute({
          childId: "child_http_failures",
          sessionId: "ses_child",
          permissionID: "perm_1",
          response: "reject",
          timeoutMs: 500,
        }, context);
        assert.equal(permission.metadata.ok, false);
        assert.equal(permission.metadata.status, 404);

        const records = (await diagnosticLines(diagRoot)).map((line) => JSON.parse(line));
        assertNoSecrets(records);
        const byTool = new Map(records.map((record) => [record.tool, record]));
        assert.equal(byTool.get("oc_command")?.event, "child_command_warning");
        assert.equal(byTool.get("oc_shell")?.event, "child_shell_warning");
        assert.equal(byTool.get("oc_permission")?.event, "child_permission_warning");
        assert.equal(byTool.get("oc_command")?.outcome, "warning");
        assert.equal(byTool.get("oc_shell")?.outcome, "warning");
        assert.equal(byTool.get("oc_permission")?.outcome, "warning");
        assert.equal(byTool.get("oc_command")?.data.childHttpFailure.status, 500);
        assert.equal(byTool.get("oc_shell")?.data.childHttpFailure.status, 404);
        assert.equal(byTool.get("oc_permission")?.data.childHttpFailure.status, 404);
      });
    });
  });
});

test("oc_command forwards ToolContext.abort into the child request", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      const controller = new AbortController();
      controller.abort(new Error("tool cancelled"));
      const registry = new ChildRegistry(defaultStateDir(context.directory));
      await registry.upsert({
        id: "child_abort",
        status: "ready",
        pid: process.pid,
        baseUrl: "http://127.0.0.1:1",
      });

      await assert.rejects(
        () => plugin.tool.oc_command.execute({
          childId: "child_abort",
          sessionId: "ses_child",
          command: "build",
          timeoutMs: 5000,
        }, { ...context, abort: controller.signal, ask: async () => ({ status: "approved" }) }),
        /tool cancelled|abort/i,
      );
    });
  });
});

test("public tool results scrub stored auth, logs, and events", async () => {
  await withPluginContext(async ({ plugin, context, stateDir }) => {
    const registry = new ChildRegistry(defaultStateDir(context.directory));
    assert.equal(registry.stateDir, stateDir);
    await registry.upsert({
      id: "child_secret",
      status: "exited",
      pid: 999999999,
      baseUrl: "http://127.0.0.1:1",
      logs: {
        stdout: `stdout has ${BEARER_SECRET} and ${CHILD_PASSWORD}`,
        stderr: `stderr has ${BASIC_SECRET} and ${API_KEY_SECRET}`,
      },
      events: [
        {
          type: "message",
          data: { message: `event text ${BEARER_SECRET} ${API_KEY_SECRET} ${CHILD_PASSWORD}` },
          raw: `raw ${BASIC_SECRET} ${CHILD_PASSWORD}`,
        },
      ],
      auth: { username: "opencode", password: CHILD_PASSWORD },
    });

    const status = await plugin.tool.oc_child_status.execute({ childId: "child_secret", timeoutMs: 50 }, context);
    assertNoSecrets(status);
    assert.equal(status.metadata.auth.password, "[redacted]");
    assert.match(status.output, /Bearer \[redacted\]/);
    assert.match(status.output, /Basic \[redacted\]/);
    assert.match(status.output, /sk-\[redacted\]/);

    const events = await plugin.tool.oc_events.execute({ childId: "child_secret" }, context);
    assertNoSecrets(events);
    assert.match(events.output, /Bearer \[redacted\]/);

    const inspect = await plugin.tool.oc_inspect.execute({ childId: "child_secret", includeLogs: true, includeEvents: true, timeoutMs: 50 }, context);
    assertNoSecrets(inspect);
    assert.equal(inspect.metadata.child.auth.password, "[redacted]");
    assert.match(inspect.output, /Bearer \[redacted\]/);
    assert.match(inspect.output, /Basic \[redacted\]/);
    assert.match(inspect.output, /sk-\[redacted\]/);
  });
});

test("oc_inspect and oc_command execute through plugin tool wiring against a fixture child", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      const requests = [];
      const commandBodies = [];
      const json = (res, statusCode, data) => {
        res.statusCode = statusCode;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(data));
      };

      await withMockChildServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        if (req.method === "POST" && req.url === "/session/ses_child/command") {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            commandBodies.push(JSON.parse(body));
            json(res, 200, { id: "cmd_1", accepted: true });
          });
          return;
        }

        req.resume();
        const responses = new Map([
          ["/global/health", { status: "ok" }],
          ["/session/status", { ses_child: { status: "idle" } }],
          ["/session", [{ id: "ses_child", title: "Fixture" }]],
          ["/command", [{ name: "build" }]],
          ["/agent", [{ id: "build" }]],
          ["/mcp", []],
          ["/experimental/tool/ids", ["tool_a"]],
          ["/session/ses_child", { id: "ses_child", title: "Fixture" }],
          ["/session/ses_child/children", []],
          ["/session/ses_child/todo", [{ id: "todo_1", title: "Check wiring" }]],
          ["/session/ses_child/message", [{ id: "msg_1", role: "assistant", text: "done" }]],
          ["/session/ses_child/diff", [{ path: "README.md", hunks: 1 }]],
        ]);
        if (responses.has(req.url)) json(res, 200, responses.get(req.url));
        else json(res, 404, { error: "not found" });
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_fixture",
          status: "ready",
          pid: process.pid,
          baseUrl,
          logs: ["fixture log"],
          events: [{ type: "fixture", data: { ok: true } }],
        });

        const inspection = await plugin.tool.oc_inspect.execute({
          childId: "child_fixture",
          sessionId: "ses_child",
          timeoutMs: 500,
        }, context);
        assert.equal(inspection.metadata.childId, "child_fixture");
        assert.equal(inspection.metadata.child.processAlive, true);
        assert.deepEqual(JSON.parse(JSON.stringify(inspection.metadata.health)), { status: "ok" });
        assert.deepEqual(JSON.parse(JSON.stringify(inspection.metadata.session)), { id: "ses_child", title: "Fixture" });
        assert.equal(inspection.metadata.sessions.count, 1);
        assert.equal(inspection.metadata.registries.commands.sample[0].name, "build");
        assert.equal(inspection.metadata.registries.tools.sample[0], "tool_a");
        assert.match(inspection.output, /child_fixture/);
        assert.ok(requests.includes("GET /session/ses_child/message"));
        assert.ok(requests.includes("GET /session/ses_child/diff"));

        const command = await plugin.tool.oc_command.execute({
          childId: "child_fixture",
          sessionId: "ses_child",
          command: "build",
          arguments: "--fix",
          agent: "build",
          providerID: "openai",
          modelID: "gpt-5",
          timeoutMs: 500,
        }, { ...context, ask: async () => ({ status: "approved" }) });
        assert.equal(command.metadata.ok, true);
        assert.equal(command.metadata.data.id, "cmd_1");
        assert.deepEqual(commandBodies, [{
          command: "build",
          arguments: "--fix",
          agent: "build",
          model: "openai/gpt-5",
        }]);
      });
    });
  });
});

test("oc_inspect bounds high-volume output and metadata", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    const longText = "x".repeat(9000);
    const messages = Array.from({ length: 70 }, (_, index) => ({ id: `msg_${index}`, text: `${index}:${longText}` }));
    const diffs = Array.from({ length: 70 }, (_, index) => ({ path: `file_${index}.txt`, patch: longText }));

    await withMockChildServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      const responses = new Map([
        ["/global/health", { status: "ok" }],
        ["/session/status", { ses_big: { status: "idle" } }],
        ["/session", [{ id: "ses_big" }]],
        ["/command", []],
        ["/agent", []],
        ["/mcp", []],
        ["/experimental/tool/ids", []],
        ["/session/ses_big", { id: "ses_big", title: "Large" }],
        ["/session/ses_big/children", []],
        ["/session/ses_big/todo", []],
        ["/session/ses_big/message", messages],
        ["/session/ses_big/diff", diffs],
      ]);
      res.statusCode = responses.has(req.url) ? 200 : 404;
      res.end(JSON.stringify(responses.get(req.url) ?? { error: "not found" }));
    }, async ({ baseUrl }) => {
      const registry = new ChildRegistry(defaultStateDir(context.directory));
      await registry.upsert({
        id: "child_large",
        status: "ready",
        pid: process.pid,
        baseUrl,
        logs: { stdout: longText, stderr: longText },
        events: Array.from({ length: 70 }, (_, index) => ({ type: "message", data: { index, text: longText } })),
      });

      const inspect = await plugin.tool.oc_inspect.execute({
        childId: "child_large",
        sessionId: "ses_big",
        includeLogs: true,
        includeEvents: true,
        timeoutMs: 500,
      }, context);

      assert.match(inspect.output, /\[truncated \d+ chars\]/);
      assert.ok(inspect.output.length < 20100, `output length ${inspect.output.length}`);
      assert.ok(inspect.metadata.logs.stdout.length < 4100, `stdout length ${inspect.metadata.logs.stdout.length}`);
      assert.ok(inspect.metadata.logs.stderr.length < 4100, `stderr length ${inspect.metadata.logs.stderr.length}`);
      assert.equal(inspect.metadata.events.length, 50);
      assert.equal(inspect.metadata.messages.length, 51);
      assert.equal(inspect.metadata.diff.length, 51);
      assert.equal(inspect.metadata.messages.at(-1), "[20 more items]");
      assert.equal(inspect.metadata.diff.at(-1), "[20 more items]");
      assert.equal(JSON.stringify(inspect.metadata).includes(longText), false);
    });
  });
});

test("session tool results scrub non-2xx child response bodies", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await withMockChildServer((req, res) => {
      req.resume();
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        error: `command failed ${CHILD_PASSWORD} ${BEARER_SECRET} ${BASIC_SECRET} ${API_KEY_SECRET} password=hunter2`,
        password: CHILD_PASSWORD,
      }));
    }, async ({ baseUrl }) => {
      const registry = new ChildRegistry(defaultStateDir(context.directory));
      await registry.upsert({
        id: "child_command_secret",
        status: "ready",
        pid: process.pid,
        baseUrl,
        auth: { username: "opencode", password: CHILD_PASSWORD },
      });

      const response = await plugin.tool.oc_command.execute({
        childId: "child_command_secret",
        sessionId: "ses_child",
        command: "build",
        timeoutMs: 500,
      }, { ...context, ask: async () => ({ status: "approved" }) });

      assert.equal(response.metadata.ok, false);
      assertNoSecrets(response);
      assert.equal(JSON.stringify(response).includes("hunter2"), false, JSON.stringify(response));
      assert.equal(response.metadata.data.password, "[redacted]");
      assert.match(response.output, /Bearer \[redacted\]/);
      assert.match(response.output, /Basic \[redacted\]/);
      assert.match(response.output, /sk-\[redacted\]/);
      assert.match(response.output, /password=\[redacted\]/);
    });
  });
});
