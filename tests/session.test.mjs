import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildRegistry } from "../src/registry.js";
import { AUTH_ISOLATION_DIAGNOSTIC, _test, commandSession, createSession, inspectSession, permissionSession, promptSession, shellSession } from "../src/session.js";
import { normalizeModel, textParts } from "../src/util.js";

const CHILD_PASSWORD = "child-password-secret-123456";
const BEARER_SECRET = "Bearer abcdefghijklmnopqrstuvwxyz123456";
const BASIC_SECRET = "Basic dXNlcjpzdXBlcnNlY3JldA==";
const API_KEY_SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";

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

test("normalizeModel splits provider/model-id", () => {
  assert.deepEqual(normalizeModel("openai/gpt-4.1"), { providerID: "openai", modelID: "gpt-4.1" });
  assert.throws(() => normalizeModel("gpt-4.1"), /provider\/model-id/);
});

test("textParts prefers explicit parts", () => {
  assert.deepEqual(textParts("ignored", [{ type: "text", text: "ok" }]), [{ type: "text", text: "ok" }]);
  assert.deepEqual(textParts("hello"), [{ type: "text", text: "hello" }]);
});

test("inspectSession reports dead child liveness without probing endpoints", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-session-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_dead", status: "exited", baseUrl: "http://127.0.0.1:1" });

    const inspection = await inspectSession(registry, { childId: "child_dead", sessionId: "ses_dead", timeoutMs: 50 });

    assert.equal(inspection.child.processAlive, false);
    assert.equal(inspection.health.error, "process is not alive");
    assert.equal(inspection.session.error, "process is not alive");
    assert.equal(inspection.messages.error, "process is not alive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inspectSession scrubs stored logs and events with the child auth literal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-session-scrub-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({
      id: "child_stored_secret",
      status: "exited",
      pid: 2147483647,
      baseUrl: "http://127.0.0.1:1",
      auth: { password: "literal-child-password-123456" },
      logs: {
        stdout: "stdout literal-child-password-123456",
        stderr: "stderr Bearer abcdefghijklmnopqrstuvwxyz123456",
      },
      events: [
        {
          type: "session.error",
          data: { message: "event literal-child-password-123456" },
          raw: "raw password=hunter2",
        },
      ],
    });

    const inspection = await inspectSession(registry, { childId: "child_stored_secret", includeLogs: true, includeEvents: true, timeoutMs: 50 });
    const text = JSON.stringify({ logs: inspection.logs, events: inspection.events });
    assert.equal(text.includes("literal-child-password-123456"), false, text);
    assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz123456"), false, text);
    assert.equal(text.includes("hunter2"), false, text);
    assert.match(text, /Bearer \[redacted\]/);
    assert.match(text, /password=\[redacted\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session helpers refuse non-loopback registry rows unless explicitly allowed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-session-nonloopback-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({
      id: "child_remote",
      pid: process.pid,
      status: "ready",
      baseUrl: "http://192.0.2.1:1234",
    });

    const expected = /refusing to contact non-loopback child URL for child_remote: http:\/\/192\.0\.2\.1:1234/;
    const cases = [
      () => createSession(registry, { childId: "child_remote", timeoutMs: 10 }),
      () => inspectSession(registry, { childId: "child_remote", sessionId: "ses_child", timeoutMs: 10 }),
      () => promptSession(registry, { childId: "child_remote", sessionId: "ses_child", text: "hello", httpTimeoutMs: 10, timeoutMs: 10 }),
      () => commandSession(registry, { childId: "child_remote", sessionId: "ses_child", command: "build", timeoutMs: 10 }),
      () => shellSession(registry, { childId: "child_remote", sessionId: "ses_child", command: "echo hi", timeoutMs: 10 }),
      () => permissionSession(registry, { childId: "child_remote", sessionId: "ses_child", permissionID: "perm_1", response: "reject", timeoutMs: 10 }),
    ];

    for (const run of cases) await assert.rejects(run, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session helpers fail closed on rows without a baseUrl", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-session-missing-url-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_no_url", pid: process.pid, status: "ready" });

    await assert.rejects(
      () => createSession(registry, { childId: "child_no_url", timeoutMs: 10 }),
      /child child_no_url has no baseUrl/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession posts optional title and parentID and returns the child session id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-create-session-test-"));
  let body;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      body = raw ? JSON.parse(raw) : undefined;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "ses_created", title: body.title }));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_create_session", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    const result = await createSession(registry, {
      childId: "child_create_session",
      title: "Created by test",
      parentID: "ses_parent",
      timeoutMs: 500,
    });

    assert.deepEqual(body, { title: "Created by test", parentID: "ses_parent" });
    assert.equal(result.childId, "child_create_session");
    assert.equal(result.sessionId, "ses_created");
    assert.equal(result.session.title, "Created by test");
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession throws a labeled error when the child rejects session creation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-create-session-fail-test-"));
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "create failed" }));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_create_session_fail", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    await assert.rejects(
      () => createSession(registry, { childId: "child_create_session_fail", timeoutMs: 500 }),
      /create session: POST \/session failed 500/,
    );
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession throws a labeled error when the child returns an empty success body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-create-session-empty-test-"));
  const server = http.createServer((req, res) => {
    req.resume();
    res.statusCode = 200;
    res.end();
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_create_session_empty", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    await assert.rejects(
      () => createSession(registry, { childId: "child_create_session_empty", timeoutMs: 500 }),
      /create session: child returned an unexpected response body/,
    );
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession throws a labeled error when the child returns a malformed success body", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-create-session-malformed-test-"));
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ title: "no id here" }));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_create_session_malformed", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    await assert.rejects(
      () => createSession(registry, { childId: "child_create_session_malformed", timeoutMs: 500 }),
      /create session: child returned an unexpected response body/,
    );
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createSession throws redacted child response bodies", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-create-session-redact-test-"));
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(`create failed ${CHILD_PASSWORD} ${BEARER_SECRET} ${BASIC_SECRET} ${API_KEY_SECRET} password=hunter2`);
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({
      id: "child_create_session_redact",
      pid: process.pid,
      status: "ready",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      auth: { username: "opencode", password: CHILD_PASSWORD },
    });

    await assert.rejects(
      () => createSession(registry, { childId: "child_create_session_redact", timeoutMs: 500 }),
      (error) => {
        const message = error.message;
        assert.match(message, /create session: POST \/session failed 500/);
        assert.equal(message.includes(CHILD_PASSWORD), false, message);
        assert.equal(message.includes("abcdefghijklmnopqrstuvwxyz123456"), false, message);
        assert.equal(message.includes("dXNlcjpzdXBlcnNlY3JldA"), false, message);
        assert.equal(message.includes("hunter2"), false, message);
        assert.match(message, /Bearer \[redacted\]/);
        assert.match(message, /Basic \[redacted\]/);
        assert.match(message, /sk-\[redacted\]/);
        assert.match(message, /password=\[redacted\]/);
        return true;
      },
    );
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession does not watch failed prompt_async submissions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-prompt-test-"));
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/session/ses_child/prompt_async") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "boom" }));
      return;
    }
    res.end(JSON.stringify([]));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_prompt", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });
    const calls = [];
    const notifier = {
      registerPromptWatch: () => { calls.push("watch"); return {}; },
      handlePromptSettled: async () => { calls.push("settled"); },
    };

    const result = await promptSession(registry, { childId: "child_prompt", sessionId: "ses_child", text: "hello", httpTimeoutMs: 200 }, { sessionID: "parent_ses" }, notifier);

    assert.equal(result.accepted.ok, false);
    assert.deepEqual(calls, []);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession does not report settled when status polling only errors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-prompt-status-error-test-"));
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/session/ses_child/prompt_async") {
      res.end(JSON.stringify(true));
      return;
    }
    if (req.url === "/session/status") {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "status unavailable" }));
      return;
    }
    res.end(JSON.stringify([]));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_prompt_status_error", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    const result = await promptSession(registry, {
      childId: "child_prompt_status_error",
      sessionId: "ses_child",
      text: "hello",
      httpTimeoutMs: 100,
      timeoutMs: 30,
      pollIntervalMs: 1,
      settleGraceMs: 0,
    });

    assert.equal(result.accepted.ok, true);
    assert.equal(result.timedOut, true);
    assert.match(result.note, /polling timed out/);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession polls only status and inspects once after async settle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-prompt-poll-light-test-"));
  let pollCount = 0;
  let inspectFanoutCount = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/session/ses_child/prompt_async") {
      res.end(JSON.stringify(true));
      return;
    }
    if (req.url === "/session/status") {
      pollCount += 1;
      res.end(JSON.stringify(pollCount < 3 ? { ses_child: { type: "busy" } } : {}));
      return;
    }
    if (req.url === "/command") inspectFanoutCount += 1;
    res.end(JSON.stringify([]));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_prompt_poll_light", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    const result = await promptSession(registry, {
      childId: "child_prompt_poll_light",
      sessionId: "ses_child",
      text: "hello",
      httpTimeoutMs: 200,
      timeoutMs: 1000,
      pollIntervalMs: 1,
      settleGraceMs: 0,
    });

    assert.equal(result.timedOut, false);
    assert.equal(pollCount >= 3, true);
    assert.equal(inspectFanoutCount, 1);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession stops polling when the tool abort signal fires", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-prompt-abort-test-"));
  const controller = new AbortController();
  let statusPolls = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/session/ses_child/prompt_async") {
      res.end(JSON.stringify(true));
      return;
    }
    if (req.url === "/session/status") {
      statusPolls += 1;
      res.end(JSON.stringify({ ses_child: { type: "busy" } }));
      controller.abort(new Error("test abort"));
      return;
    }
    res.end(JSON.stringify([]));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_prompt_abort", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    await assert.rejects(
      () => promptSession(registry, {
        childId: "child_prompt_abort",
        sessionId: "ses_child",
        text: "hello",
        httpTimeoutMs: 200,
        timeoutMs: 5000,
        pollIntervalMs: 1000,
      }, { abort: controller.signal }),
      /abort/i,
    );
    assert.equal(statusPolls, 1);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession supports the synchronous message endpoint when async is false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-prompt-sync-test-"));
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "msg_sync" }));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_prompt_sync", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    const result = await promptSession(registry, {
      childId: "child_prompt_sync",
      sessionId: "ses_child",
      text: "sync please",
      async: false,
      timeoutMs: 500,
    });

    assert.equal(result.response.ok, true);
    assert.equal(result.response.data.id, "msg_sync");
    assert.deepEqual(calls.map((call) => call.url), ["/session/ses_child/message"]);
    assert.deepEqual(calls[0].body.parts, [{ type: "text", text: "sync please" }]);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession sends nested model payload for model string", async () => {
  const { body } = await capturePromptBody({ model: "openai/gpt-5.5" });

  assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-5.5" });
});

test("promptSession sends nested model payload for explicit provider and model", async () => {
  const { body } = await capturePromptBody({ providerID: "openai", modelID: "gpt-5.5" });

  assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-5.5" });
});

test("promptSession rejects a partial provider/model pair instead of dropping it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-partial-model-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_partial", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(
      () => promptSession(registry, { childId: "child_partial", sessionId: "ses_child", text: "hi", providerID: "openai", modelID: "" }),
      /both be provided/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("promptSession reports auth-isolation diagnostic for isolated provider/model-not-found evidence", async () => {
  const result = await runSettledPromptWithLogs({
    inheritData: false,
    logs: ["ProviderModelNotFoundError: Model not found: openai/gpt-5.5"],
  });

  assert.equal(result.diagnostic, AUTH_ISOLATION_DIAGNOSTIC);
});

test("promptSession omits auth-isolation diagnostic when data is inherited", async () => {
  const result = await runSettledPromptWithLogs({
    inheritData: true,
    logs: ["ProviderModelNotFoundError: Model not found: openai/gpt-5.5"],
  });

  assert.equal(result.diagnostic, undefined);
});

test("promptSession omits auth-isolation diagnostic for unrelated failures", async () => {
  const result = await runSettledPromptWithLogs({
    inheritData: false,
    logs: ["Error: permission denied by test fixture"],
  });

  assert.equal(result.diagnostic, undefined);
});

test("targetSessionRunning treats idle as settled", () => {
  assert.equal(_test.targetSessionRunning({ ses_child: { type: "idle" } }, "ses_child"), false);
  assert.equal(_test.targetSessionRunning({ ses_child: { type: "busy" } }, "ses_child"), true);
  assert.equal(_test.targetSessionRunning({ other: { sessionID: "ses_child", type: "retry" } }, "ses_child"), true);
  assert.equal(_test.targetSessionRunning({ other: { session: { id: "ses_child", status: "busy" } } }, "ses_child"), true);
});

async function capturePromptBody(modelArgs) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-payload-test-"));
  let body;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/session/ses_child/prompt_async") body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/session/status" ? {} : []));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_payload", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}`, inheritData: false });
    const result = await promptSession(registry, { childId: "child_payload", sessionId: "ses_child", text: "hello", ...modelArgs, httpTimeoutMs: 200, timeoutMs: 1000, settleGraceMs: 0 });
    assert.equal(result.accepted.ok, true);
    return { body, result };
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

async function captureBody(endpoint, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-body-test-"));
  let body;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === endpoint) body = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(true));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_body", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });
    const result = await run(registry);
    return { body, result };
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

test("shellSession sends nested model payload for model string", async () => {
  const { body, result } = await captureBody("/session/ses_child/shell", (registry) =>
    shellSession(registry, { childId: "child_body", sessionId: "ses_child", command: "echo hi", model: "openai/gpt-5.5", timeoutMs: 500 }));
  assert.equal(result.ok, true);
  assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-5.5" });
});

test("shellSession sends nested model payload for explicit provider and model", async () => {
  const { body } = await captureBody("/session/ses_child/shell", (registry) =>
    shellSession(registry, { childId: "child_body", sessionId: "ses_child", command: "echo hi", providerID: "openai", modelID: "gpt-5.5", timeoutMs: 500 }));
  assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-5.5" });
});

test("shellSession rejects bare model ids with actionable guidance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-shell-reject-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_shell", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(
      () => shellSession(registry, { childId: "child_shell", sessionId: "ses_child", command: "echo hi", model: "gpt-5.5" }),
      /Bare model IDs are not accepted/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("commandSession sends plain model payload for model string", async () => {
  const { body } = await captureBody("/session/ses_child/command", (registry) =>
    commandSession(registry, { childId: "child_body", sessionId: "ses_child", command: "build", model: "openai/gpt-5.5", timeoutMs: 500 }));
  assert.equal(body.model, "openai/gpt-5.5");
});

test("commandSession sends plain model payload for explicit provider and model", async () => {
  const { body } = await captureBody("/session/ses_child/command", (registry) =>
    commandSession(registry, { childId: "child_body", sessionId: "ses_child", command: "build", providerID: "openai", modelID: "gpt-5.5", timeoutMs: 500 }));
  assert.equal(body.model, "openai/gpt-5.5");
});

async function runSettledPromptWithLogs(childArgs) {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-diagnostic-test-"));
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/session/status" ? {} : []));
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_diagnostic", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}`, ...childArgs });
    return await promptSession(registry, { childId: "child_diagnostic", sessionId: "ses_child", text: "hello", httpTimeoutMs: 200, timeoutMs: 1000, settleGraceMs: 0 });
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
}

test("permissionSession uses documented session permission endpoint first", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-permission-test-"));
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(true));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_permission", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });
    const res = await permissionSession(registry, { childId: "child_permission", sessionId: "ses_child", permissionID: "perm_1", response: "once", timeoutMs: 500 });
    assert.equal(res.ok, true);
    assert.deepEqual(calls, [
      { method: "POST", url: "/session/ses_child/permissions/perm_1", body: { response: "once" } },
    ]);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("permissionSession falls back to observed permission reply endpoint on documented 404", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-permission-legacy-test-"));
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/session/ses_child/permissions/perm_1") {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "missing" }));
        return;
      }
      res.end(JSON.stringify(true));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_permission", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });
    const res = await permissionSession(registry, { childId: "child_permission", sessionId: "ses_child", permissionID: "perm_1", response: "always", timeoutMs: 500 });
    assert.equal(res.ok, true);
    assert.deepEqual(calls.map((call) => call.url), [
      "/session/ses_child/permissions/perm_1",
      "/permission/perm_1/reply",
    ]);
    assert.deepEqual(calls[1].body, { reply: "always" });
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("permissionSession falls back to observed permission reply endpoint on documented non-404 failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-permission-non404-test-"));
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/session/ses_child/permissions/perm_1") {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "documented route failed" }));
        return;
      }
      res.end(JSON.stringify(true));
    });
  });
  await listenLoopback(server);
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_permission_non404", pid: process.pid, status: "ready", baseUrl: `http://127.0.0.1:${server.address().port}` });

    const res = await permissionSession(registry, {
      childId: "child_permission_non404",
      sessionId: "ses_child",
      permissionID: "perm_1",
      response: "reject",
      timeoutMs: 500,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(calls.map((call) => call.url), [
      "/session/ses_child/permissions/perm_1",
      "/permission/perm_1/reply",
    ]);
    assert.deepEqual(calls[1].body, { reply: "reject" });
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
