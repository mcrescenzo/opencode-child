import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ChildHttpClient, assertOk } from "../src/client.js";

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

test("ChildHttpClient returns JSON responses", async () => {
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ method: req.method, url: req.url }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const res = await client.get("/hello");
    assert.equal(res.ok, true);
    assert.equal(res.data.url, "/hello");
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient times out bounded calls", async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end("late"), 1000));
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const res = await client.get("/slow", { timeoutMs: 50 });
    assert.equal(res.ok, false);
    assert.match(res.error, /timeout/);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient timeout still applies when caller supplies an abort signal", async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end("late"), 1000));
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const external = new AbortController();
    const res = await client.get("/slow", { timeoutMs: 50, signal: external.signal });
    assert.equal(res.ok, false);
    assert.match(res.error, /timeout after 50ms/);
    assert.equal(external.signal.aborted, false);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient distinguishes caller-triggered aborts from timeouts", async () => {
  const server = http.createServer((_req, res) => setTimeout(() => res.end("late"), 1000));
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const external = new AbortController();
    const pending = client.get("/slow", { timeoutMs: 1000, signal: external.signal });
    setTimeout(() => external.abort(new Error("parent cancelled request")), 10);

    const res = await pending;
    assert.equal(res.ok, false);
    assert.match(res.error, /caller aborted request: parent cancelled request/);
    assert.doesNotMatch(res.error, /timeout after 1000ms/);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient sends HTTP Basic auth", async () => {
  let authorization;
  const server = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`, { username: "opencode", password: "secret" });
    const res = await client.get("/auth");
    assert.equal(res.ok, true);
    assert.equal(authorization, `Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient refuses Basic auth over non-loopback plaintext HTTP before fetching", async () => {
  const client = new ChildHttpClient("http://192.0.2.10:1234", { username: "opencode", password: "secret" });
  const res = await client.get("/global/health", { timeoutMs: 50 });
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.match(res.error, /refusing to send Basic auth over non-loopback plaintext HTTP/);
});

test("ChildHttpClient preserves non-JSON and empty successful responses", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/empty") {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end("plain text");
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const text = await client.get("/text");
    assert.equal(text.ok, true);
    assert.equal(text.data, "plain text");

    const empty = await client.get("/empty");
    assert.equal(empty.ok, true);
    assert.equal(empty.data, null);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient returns structured non-2xx responses without throwing", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 503;
    res.setHeader("content-type", "text/plain");
    res.end("service unavailable");
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const res = await client.get("/down");
    assert.equal(res.ok, false);
    assert.equal(res.status, 503);
    assert.equal(res.data, "service unavailable");
    assert.match(res.error, /GET \/down failed 503/);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient does not follow redirects from child endpoints", async () => {
  let redirectedTargetHit = false;
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect-target") {
      redirectedTargetHit = true;
      res.end(JSON.stringify({ followed: true }));
      return;
    }
    res.statusCode = 302;
    res.setHeader("location", "/redirect-target");
    res.end("redirect");
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const res = await client.get("/redirect");
    assert.equal(res.ok, false);
    assert.equal(res.status, 302);
    assert.equal(redirectedTargetHit, false);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient scrubs secrets from non-2xx data and errors", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: `failed ${CHILD_PASSWORD} ${BEARER_SECRET} ${BASIC_SECRET} ${API_KEY_SECRET} password=hunter2`,
      password: CHILD_PASSWORD,
    }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`, { password: CHILD_PASSWORD });
    const res = await client.get("/down");
    const text = JSON.stringify(res);
    assert.equal(res.ok, false);
    assert.equal(text.includes(CHILD_PASSWORD), false, text);
    assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz123456"), false, text);
    assert.equal(text.includes("dXNlcjpzdXBlcnNlY3JldA"), false, text);
    assert.equal(text.includes("hunter2"), false, text);
    assert.equal(res.data.password, "[redacted]");
    assert.match(res.error, /Bearer \[redacted\]/);
    assert.match(res.error, /Basic \[redacted\]/);
    assert.match(res.error, /sk-\[redacted\]/);
    assert.match(res.error, /password=\[redacted\]/);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient scrubs literal secrets discovered in response secret fields", async () => {
  const server = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      error: `failed ${CHILD_PASSWORD}`,
      password: CHILD_PASSWORD,
    }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const res = await client.get("/down");
    const text = JSON.stringify(res);
    assert.equal(res.ok, false);
    assert.equal(text.includes(CHILD_PASSWORD), false, text);
    assert.equal(res.data.password, "[redacted]");
    assert.match(res.data.error, /failed \[redacted\]/);
    assert.match(res.error, /failed \[redacted\]/);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient combines caller abort signals when AbortSignal.any is unavailable", async () => {
  const originalAny = AbortSignal.any;
  AbortSignal.any = undefined;
  const server = http.createServer((_req, res) => setTimeout(() => res.end("late"), 1000));
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const external = new AbortController();
    const pending = client.get("/slow", { timeoutMs: 1000, signal: external.signal });
    setTimeout(() => external.abort(), 10);

    const res = await pending;
    assert.equal(res.ok, false);
    assert.match(res.error, /caller aborted request/);
    assert.doesNotMatch(res.error, /timeout after 1000ms/);
    assert.equal(external.signal.aborted, true);
  } finally {
    AbortSignal.any = originalAny;
    await closeServer(server);
  }
});

test("ChildHttpClient probeCapabilities reports per-route status without failing the batch", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = http.createServer(async (req, res) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await delay(20);
    inFlight -= 1;
    res.setHeader("content-type", "application/json");
    if (req.url === "/global/health" || req.url === "/session") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "missing" }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const capabilities = await client.probeCapabilities();
    assert.equal(capabilities["/global/health"].ok, true);
    assert.equal(capabilities["/session"].ok, true);
    assert.equal(capabilities["/command"].ok, false);
    assert.equal(capabilities["/command"].status, 404);
    assert.equal(Object.keys(capabilities).length, 12);
    assert.ok(maxInFlight > 1, `expected concurrent probes, saw maxInFlight=${maxInFlight}`);
  } finally {
    await closeServer(server);
  }
});

test("ChildHttpClient probeCapabilities honors caller timeout", async () => {
  const server = http.createServer(async (_req, res) => {
    await delay(100);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await listenLoopback(server);
  try {
    const client = new ChildHttpClient(`http://127.0.0.1:${server.address().port}`);
    const capabilities = await client.probeCapabilities({ timeoutMs: 20 });
    assert.equal(capabilities["/global/health"].ok, false);
    assert.match(capabilities["/global/health"].error, /timeout after 20ms/);
    assert.equal(Object.keys(capabilities).length, 12);
  } finally {
    await closeServer(server);
  }
});

test("assertOk returns response data or throws a labeled error", () => {
  assert.deepEqual(assertOk({ ok: true, data: { id: "ses_1" } }, "create session"), { id: "ses_1" });
  assert.throws(
    () => assertOk({ ok: false, error: "POST /session failed 500" }, "create session"),
    /create session: POST \/session failed 500/,
  );
});
