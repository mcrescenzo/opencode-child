import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { parseSseBlock, startEventTail } from "../src/lifecycle/events.js";
import { eventsChild } from "../src/lifecycle.js";

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

async function waitUntil(predicate, message) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(message);
}

async function withSseServer(eventCount, fn) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url !== "/global/event") {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let index = 0; index < eventCount; index += 1) {
      res.write(`id: ${index}\nevent: session.update\ndata: {"index":${index}}\n\n`);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenLoopback(server);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  }
}

async function withScriptedServer(handler, fn) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listenLoopback(server);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await closeServer(server);
  }
}

function eventTailFixture(baseUrl) {
  const child = { id: "child_events", baseUrl, auth: { password: "child-secret" }, events: [] };
  const writes = [];
  let current = { id: child.id, status: "ready" };
  const registry = {
    async get() {
      return current;
    },
    async upsertIfCurrentActive(value) {
      writes.push(value.events.length);
      return value;
    },
  };
  const eventReaders = new Map();
  const terminalStatuses = new Set(["stopped", "exited", "failed"]);
  return {
    child,
    registry,
    writes,
    eventReaders,
    stop() {
      current = { id: child.id, status: "stopped", expectedStop: true };
      eventReaders.get(child.id)?.abort();
    },
    options: { eventReaders, terminalStatuses },
  };
}

test("parseSseBlock preserves __proto__ as data on sanitized event objects", () => {
  const event = parseSseBlock('event: json\ndata: {"__proto__":{"polluted":true},"authToken":"secret","nested":{"__proto__":"value"}}\n\n');
  assert.equal(Object.getPrototypeOf(event.data), null);
  assert.equal(Object.hasOwn(event.data, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(event.data.nested), null);
  assert.equal(Object.hasOwn(event.data.nested, "__proto__"), true);
  assert.equal(event.data.authToken, "[redacted]");
  assert.equal({}.polluted, undefined);
});

test("startEventTail does not follow redirects from the child SSE endpoint", async () => {
  let redirectedTargetHit = false;
  await withScriptedServer((req, res) => {
    if (req.url === "/global/event-target") {
      redirectedTargetHit = true;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: session.update\ndata: {\"followed\":true}\n\n");
      res.end();
      return;
    }
    if (req.url !== "/global/event") {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.statusCode = 302;
    res.setHeader("location", "/global/event-target");
    res.end("redirect");
  }, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      initialBackoffMs: 1000,
      persistDebounceMs: 5,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => fixture.child.events.length === 1, "expected one redirect error event");
      assert.equal(fixture.child.events[0].type, "event.error");
      assert.equal(fixture.child.events[0].status, 302);
      assert.equal(redirectedTargetHit, false);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail coalesces chatty SSE events into a debounced registry write", async () => {
  await withSseServer(5, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      persistDebounceMs: 20,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => fixture.child.events.length === 5, "expected five SSE events in memory");
      await waitUntil(() => fixture.writes.length === 1, "expected one debounced registry write");
      assert.deepEqual(fixture.writes, [5]);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail flushes a pending debounced registry write when aborted", async () => {
  await withSseServer(3, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      persistDebounceMs: 1000,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => fixture.child.events.length === 3, "expected three SSE events in memory");
      assert.deepEqual(fixture.writes, []);
      fixture.stop();

      await waitUntil(() => fixture.writes.length === 1, "expected abort to flush pending registry write");
      assert.deepEqual(fixture.writes, [3]);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail reconnects after a dropped SSE stream with bounded backoff", async () => {
  let requests = 0;
  await withScriptedServer((req, res) => {
    if (req.url !== "/global/event") {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`id: ${requests}\nevent: session.update\ndata: {"request":${requests}}\n\n`);
    res.end();
  }, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      initialBackoffMs: 5,
      maxBackoffMs: 5,
      persistDebounceMs: 5,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => requests >= 2, "expected reconnect after dropped stream");
      await waitUntil(() => fixture.child.events.length >= 2, "expected events from both connections");
      assert.deepEqual(fixture.child.events.slice(0, 2).map((event) => event.data.request), [1, 2]);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail redacts malformed and oversized event data before storing", async () => {
  const long = "x".repeat(5000);
  await withScriptedServer((req, res) => {
    if (req.url !== "/global/event") {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`event: malformed\ndata: token=child-secret ${long}\n\n`);
    res.write(`event: json\ndata: {"message":"Bearer abcdefghijklmnopqrstuvwxyz123456 child-secret ${long}","authToken":"secret-value"}\n\n`);
    res.end();
  }, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      initialBackoffMs: 1000,
      persistDebounceMs: 5,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => fixture.child.events.length === 2, "expected malformed and JSON events");
      const text = JSON.stringify(fixture.child.events);
      assert.equal(text.includes("child-secret"), false);
      assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
      assert.match(fixture.child.events[0].data, /\[redacted\]/);
      assert.match(fixture.child.events[0].data, /\[truncated/);
      assert.match(fixture.child.events[1].data.message, /Bearer \[redacted\]/);
      assert.equal(fixture.child.events[1].data.authToken, "[redacted]");
      assert.match(fixture.child.events[1].data.message, /\[truncated/);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail discards oversized frames with an error marker and resumes after the block boundary", async () => {
  await withScriptedServer(async (req, res) => {
    if (req.url !== "/global/event") {
      res.statusCode = 404;
      res.end("missing");
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Write an oversized data line (> EVENT_BUFFER_LIMIT) without terminating it,
    // so the unterminated tail exceeds the buffer limit before the boundary arrives.
    const huge = "X".repeat(70000);
    res.write(`data: ${huge}`);
    await delay(50);
    // Terminate the oversized frame and immediately follow with a valid frame.
    res.write(`\n\nid: 0\nevent: session.update\ndata: {"ok":true}\n\n`);
    res.end();
  }, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      initialBackoffMs: 1000,
      persistDebounceMs: 5,
      persistEvery: 100,
    });

    try {
      await waitUntil(() => fixture.child.events.length >= 2, "expected an error marker and a valid frame");
      const errorEvent = fixture.child.events.find((e) => e.type === "event.error");
      assert.ok(errorEvent, "expected an oversized-frame error marker");
      assert.match(errorEvent.error, /frame exceeded buffer limit/);
      const validEvent = fixture.child.events.find((e) => e.type === "session.update");
      assert.ok(validEvent, "expected the valid frame after the oversized one to be parsed");
      assert.equal(validEvent.data.ok, true);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

test("startEventTail caps stored events and coalesces registry writes", async () => {
  await withSseServer(205, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      persistDebounceMs: 20,
      persistEvery: 500,
    });

    try {
      await waitUntil(() => fixture.child.events.length === 200 && fixture.child.events.at(-1)?.index === 204, "expected bounded event buffer");
      await waitUntil(() => fixture.writes.length === 1, "expected coalesced registry write");
      assert.equal(fixture.child.events[0].index, 5);
      assert.equal(fixture.child.events.at(-1).index, 204);
      assert.deepEqual(fixture.writes, [200]);
    } finally {
      fixture.stop();
      await delay(20);
    }
  });
});

function eventsChildRegistry(events) {
  const child = { id: "child_page", auth: { password: "child-secret" }, events };
  return { async get() { return child; } };
}

test("eventsChild walks forward through a since cursor without skipping older-but-unseen events", async () => {
  // Ring-buffer trimmed state: indices 10..209 (200 events).
  const events = [];
  for (let index = 10; index < 210; index += 1) events.push({ index, type: "session.update", data: { index } });
  const registry = eventsChildRegistry(events);

  // Forward pagination from the cursor must return the OLDEST matching page,
  // not the most-recent tail (the original bug returned 205..209 here).
  const first = await eventsChild(registry, "child_page", { since: 10, limit: 5 });
  assert.deepEqual(first.events.map((event) => event.index), [10, 11, 12, 13, 14]);
  assert.equal(first.count, 200);
  assert.equal(first.hasMore, true);

  // Advancing the cursor past the last returned index walks forward with no gap.
  const second = await eventsChild(registry, "child_page", { since: 15, limit: 5 });
  assert.deepEqual(second.events.map((event) => event.index), [15, 16, 17, 18, 19]);
  assert.equal(second.hasMore, true);

  // Continue until exhaustion, collecting every index; assert zero gaps/dupes.
  const seen = [];
  let cursor = 10;
  for (let guard = 0; guard < 100; guard += 1) {
    const page = await eventsChild(registry, "child_page", { since: cursor, limit: 5 });
    if (page.events.length === 0) break;
    for (const event of page.events) seen.push(event.index);
    cursor = page.events.at(-1).index + 1;
    if (!page.hasMore) break;
  }
  const expected = [];
  for (let index = 10; index < 210; index += 1) expected.push(index);
  assert.deepEqual(seen, expected);
});

test("eventsChild returns the most-recent tail and hasMore when since is omitted", async () => {
  const events = [];
  for (let index = 0; index < 10; index += 1) events.push({ index, type: "session.update", data: { index } });
  const registry = eventsChildRegistry(events);

  const page = await eventsChild(registry, "child_page", { limit: 3 });
  assert.deepEqual(page.events.map((event) => event.index), [7, 8, 9]);
  assert.equal(page.count, 10);
  assert.equal(page.hasMore, true);

  const all = await eventsChild(registry, "child_page", { limit: 50 });
  assert.equal(all.hasMore, false);
});

test("startEventTail exits without connecting when registry row is already terminal", async () => {
  let requests = 0;
  await withScriptedServer((req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: unexpected\n\n");
  }, async (baseUrl) => {
    const fixture = eventTailFixture(baseUrl);
    fixture.stop();
    startEventTail(fixture.registry, fixture.child, undefined, {
      ...fixture.options,
      initialBackoffMs: 5,
      persistDebounceMs: 5,
    });

    await waitUntil(() => !fixture.eventReaders.has(fixture.child.id), "expected terminal tail to clear event reader");
    assert.equal(requests, 0);
    assert.deepEqual(fixture.child.events, []);
    assert.deepEqual(fixture.writes, []);
  });
});
