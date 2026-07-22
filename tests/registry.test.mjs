import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChildRegistry, defaultStateDir, TERMINAL_RETENTION_MS } from "../src/registry.js";

test("registry persists child metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-test-"));
  try {
    const one = new ChildRegistry(dir);
    await one.upsert({ id: "child_test", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    const two = new ChildRegistry(dir);
    const child = await two.get("child_test");
    assert.equal(child.status, "ready");
    const listed = await two.list();
    assert.equal(listed[0].processAlive, true);
    await two.markStopped("child_test");
    assert.equal((await two.get("child_test")).status, "stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("conditionalPatch preserves terminal metadata and same-id replacement rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-patch-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_patch", nonce: "OLD", pid: 1, status: "ready", baseUrl: "http://127.0.0.1:1" });
    await registry.markStopped("child_patch", { marker: "fresh-stop" });
    const terminal = await registry.conditionalPatch("child_patch", "OLD", { status: "exited", marker: "stale-exit" });
    assert.equal(terminal.applied, false);
    assert.equal((await registry.get("child_patch")).marker, "fresh-stop");

    await registry.insert({ id: "child_patch", nonce: "NEW", pid: 2, status: "ready", baseUrl: "http://127.0.0.1:2", marker: "replacement" }, { allowExistingTerminal: true });
    const replacement = await registry.conditionalPatch("child_patch", "OLD", { status: "exited", marker: "stale-exit" });
    assert.equal(replacement.applied, false);
    assert.equal((await registry.get("child_patch")).marker, "replacement");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry scrubs persisted child secrets and startup inspection samples", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-redaction-test-"));
  try {
    const registry = new ChildRegistry(dir);
    const password = "child-password-secret-123456";
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz123456";
    await registry.upsert({
      id: "child_secret_disk",
      pid: process.pid,
      status: "ready",
      baseUrl: "http://127.0.0.1:1",
      auth: { username: "opencode", password },
      logs: {
        stdout: `started with ${password}`,
        stderr: `failed with ${bearer}`,
      },
      startupInspection: {
        health: { ok: true, authorization: bearer },
        commands: {
          count: 1,
          sample: [{ name: "build", description: `uses ${password}`, apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" }],
        },
        sessions: { count: 1, sample: [{ id: "ses_1", title: `token=${password}` }] },
      },
    });

    assert.equal((await registry.get("child_secret_disk")).auth.password, password);

    const rawText = await readFile(path.join(dir, "children.json"), "utf8");
    assert.equal(rawText.includes(password), false, rawText);
    assert.equal(rawText.includes("abcdefghijklmnopqrstuvwxyz123456"), false, rawText);

    const raw = JSON.parse(rawText);
    const child = raw.children[0];
    assert.equal(child.auth.password, "[redacted]");
    assert.equal(child.startupInspection.health.authorization, "[redacted]");
    assert.match(child.logs.stdout, /started with \[redacted\]/);
    assert.match(child.logs.stderr, /\[redacted\]/);
    assert.equal(child.startupInspection.commands.sample[0].apiKey, "[redacted]");
    assert.match(child.startupInspection.commands.sample[0].description, /uses \[redacted\]/);

    const reloaded = new ChildRegistry(dir);
    assert.equal((await reloaded.get("child_secret_disk")).auth.password, "[redacted]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry serializes concurrent writes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-race-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_race", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    const writes = Array.from({ length: 80 }, (_, index) => {
      if (index === 79 || index % 2 === 0) return registry.markStopped("child_race", { marker: index });
      return registry.upsert({ id: "child_race", pid: process.pid, status: "ready", marker: index, baseUrl: "http://127.0.0.1:1" });
    });

    await Promise.all(writes);

    const child = await registry.get("child_race");
    assert.equal(child.status, "stopped");
    assert.equal(child.marker, 79);
    const raw = JSON.parse(await readFile(path.join(dir, "children.json"), "utf8"));
    assert.equal(raw.children.length, 1);
    const leftovers = (await readdir(dir)).filter((entry) => entry.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry reload tolerates a children.json whose JSON parses to null", async () => {
  // Regression (null-empty-16): JSON.parse("null") returns null; reading raw.children
  // threw a TypeError (no .code), which reload re-threw, bricking the registry.
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-null-test-"));
  try {
    await writeFile(path.join(dir, "children.json"), "null");
    const registry = new ChildRegistry(dir);
    assert.deepEqual(await registry.list(), []);
    // and it recovers: a subsequent write succeeds and reads back.
    await registry.upsert({ id: "child_after_null", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    assert.equal((await registry.get("child_after_null")).status, "ready");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry fails closed on children.json whose children is a non-array, non-nullish value", async () => {
  // Regression: raw?.children ?? [] only substitutes [] for null/undefined; a
  // non-iterable value (0/false/""/{}) slipped through and for-of threw an opaque
  // native TypeError (no .code) that reload re-threw, bricking every tool.
  for (const bad of [0, false, "", {}]) {
    const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-nonarray-test-"));
    try {
      await writeFile(path.join(dir, "children.json"), JSON.stringify({ version: 2, children: bad }));
      const registry = new ChildRegistry(dir);
      await assert.rejects(
        () => registry.list(),
        /invalid child registry JSON.*'children' must be an array/,
        `children=${JSON.stringify(bad)} should fail closed with the descriptive error`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("registry fails closed on malformed children.json without overwriting it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-corrupt-test-"));
  try {
    const file = path.join(dir, "children.json");
    const corrupt = "{ this is not valid json";
    await writeFile(file, corrupt);
    const registry = new ChildRegistry(dir);

    await assert.rejects(() => registry.list(), /invalid child registry JSON/);
    assert.equal(await readFile(file, "utf8"), corrupt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry fails closed on malformed child rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-row-test-"));
  try {
    await writeFile(path.join(dir, "children.json"), JSON.stringify({ version: 2, children: [{ status: "ready" }] }));
    const registry = new ChildRegistry(dir);

    await assert.rejects(() => registry.list(), /invalid child registry row/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry fails closed on malformed child baseUrl values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-url-test-"));
  const writeDir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-url-write-test-"));
  try {
    await writeFile(path.join(dir, "children.json"), JSON.stringify({
      version: 2,
      children: [{ id: "child_bad_url", status: "ready", baseUrl: "http://[" }],
    }));
    const registry = new ChildRegistry(dir);

    await assert.rejects(() => registry.list(), /child child_bad_url baseUrl must be a valid URL/);
    const writeRegistry = new ChildRegistry(writeDir);
    await assert.rejects(
      () => writeRegistry.upsert({ id: "child_bad_url_write", status: "ready", baseUrl: "not a url" }),
      /child child_bad_url_write baseUrl must be a valid URL/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(writeDir, { recursive: true, force: true });
  }
});

test("registry failed persistence does not poison in-memory state", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-transaction-test-"));
  try {
    const seed = new ChildRegistry(dir);
    await seed.upsert({ id: "child_seed", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });

    class FailingRegistry extends ChildRegistry {
      async saveMap() {
        throw new Error("forced save failure");
      }
    }

    const registry = new FailingRegistry(dir);
    await registry.load();
    await assert.rejects(
      () => registry.upsert({ id: "child_failed", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:2" }),
      /forced save failure/,
    );

    assert.deepEqual((await registry.list()).map((child) => child.id), ["child_seed"]);
    const raw = JSON.parse(await readFile(path.join(dir, "children.json"), "utf8"));
    assert.deepEqual(raw.children.map((child) => child.id), ["child_seed"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry reclaims a stale file lock and retries the write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-stale-lock-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await mkdir(registry.lockDir, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    await utimes(registry.lockDir, stale, stale);

    await registry.upsert({ id: "child_after_stale_lock", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });

    assert.equal((await registry.get("child_after_stale_lock")).status, "ready");
    await assert.rejects(() => stat(registry.lockDir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry times out without running a write when the file lock stays active", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-timeout-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await mkdir(registry.lockDir, { recursive: true });
    const baseNow = Date.now();
    const originalNow = Date.now;
    let nowCalls = 0;
    Date.now = () => {
      nowCalls += 1;
      return nowCalls >= 3 ? baseNow + 10_001 : baseNow;
    };

    try {
      await assert.rejects(
        () => registry.withFileLock(async () => {
          throw new Error("locked operation should not run");
        }),
        /timed out acquiring child registry lock/,
      );
    } finally {
      Date.now = originalNow;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry leaves an active file lock in place during stale-lock checks", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-active-lock-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await mkdir(registry.lockDir, { recursive: true });

    assert.equal(await registry.reclaimStaleLock(), false);
    assert.ok(await stat(registry.lockDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry does not reclaim a stale file lock that changes during confirmation", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-changing-lock-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await mkdir(registry.lockDir, { recursive: true });
    const stale = new Date(Date.now() - 60_000);
    await utimes(registry.lockDir, stale, stale);
    const touch = delay(5).then(async () => {
      const fresh = new Date();
      await utimes(registry.lockDir, fresh, fresh);
    });

    assert.equal(await registry.reclaimStaleLock(), false);
    await touch;
    assert.ok(await stat(registry.lockDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry save persists the current in-memory map", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-save-test-"));
  try {
    const registry = new ChildRegistry(dir);
    registry.children.set("child_saved", { id: "child_saved", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });

    await registry.save();

    const reloaded = new ChildRegistry(dir);
    assert.equal((await reloaded.get("child_saved")).status, "ready");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry remove returns whether the child existed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-remove-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_remove", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });

    assert.equal(await registry.remove("child_remove"), true);
    assert.equal(await registry.remove("child_remove"), false);
    await assert.rejects(() => registry.get("child_remove"), /unknown child/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry conditional active upsert preserves terminal and replacement rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-active-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_active", nonce: "A", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1", marker: "old" });
    await registry.upsertIfCurrentActive({ id: "child_active", nonce: "A", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1", marker: "new" });
    assert.equal((await registry.get("child_active")).marker, "new");

    await registry.markStopped("child_active", { marker: "stopped" });
    await registry.upsertIfCurrentActive({ id: "child_active", nonce: "A", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1", marker: "resurrected" });
    const stopped = await registry.get("child_active");
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.marker, "stopped");

    await registry.upsert({ id: "child_replaced", nonce: "NEW", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:2", marker: "new" });
    await registry.upsertIfCurrentActive({ id: "child_replaced", nonce: "OLD", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:2", marker: "old-tail" });
    assert.equal((await registry.get("child_replaced")).marker, "new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry insert claims ids atomically and only reuses terminal rows when allowed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-insert-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.insert({ id: "child_claim", pid: process.pid, status: "starting", baseUrl: "http://127.0.0.1:1" });
    await assert.rejects(
      () => registry.insert({ id: "child_claim", pid: process.pid, status: "starting", baseUrl: "http://127.0.0.1:2" }),
      /child id already exists/,
    );
    await assert.rejects(
      () => registry.insert({ id: "child_claim", pid: process.pid, status: "starting", baseUrl: "http://127.0.0.1:2" }, { allowExistingTerminal: true }),
      /child id already exists/,
    );

    await registry.markStopped("child_claim");
    await registry.insert({ id: "child_claim", pid: process.pid, status: "starting", baseUrl: "http://127.0.0.1:3" }, { allowExistingTerminal: true });
    assert.equal((await registry.get("child_claim")).baseUrl, "http://127.0.0.1:3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry prunes terminal rows so repeated insert+markStopped cycles do not accumulate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-prune-test-"));
  try {
    const registry = new ChildRegistry(dir);
    // Shrink the retention cap so the test is fast and deterministic.
    const originalPrune = registry.pruneTerminal.bind(registry);
    registry.pruneTerminal = (map) => originalPrune(map, 5, TERMINAL_RETENTION_MS);

    for (let i = 0; i < 50; i += 1) {
      const id = `child_cycle_${i}`;
      await registry.insert({ id, pid: process.pid, status: "starting", baseUrl: "http://127.0.0.1:1" });
      await registry.markStopped(id);
    }

    const listed = await registry.list();
    assert.ok(listed.length <= 5, `expected <=5 retained rows, got ${listed.length}`);
    const raw = JSON.parse(await readFile(path.join(dir, "children.json"), "utf8"));
    assert.ok(raw.children.length <= 5, `children.json retained ${raw.children.length} rows`);
    // The most recently stopped child is retained.
    assert.ok(listed.some((child) => child.id === "child_cycle_49"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("registry pruneTerminal drops terminal rows older than maxAgeMs but keeps live rows", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-registry-prune-age-test-"));
  try {
    const registry = new ChildRegistry(dir);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const map = new Map([
      ["stale", { id: "stale", status: "stopped", stoppedAt: old, updatedAt: old }],
      ["live", { id: "live", status: "ready", updatedAt: old }],
      ["fresh", { id: "fresh", status: "stopped", stoppedAt: nowStamp() }],
    ]);

    registry.pruneTerminal(map, 200, TERMINAL_RETENTION_MS);

    assert.deepEqual([...map.keys()].sort(), ["fresh", "live"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function nowStamp() {
  return new Date().toISOString();
}

test("defaultStateDir is user-private, not project-local", async () => {
  const project = await mkdtemp(path.join(tmpdir(), "opencode-child-project-state-test-"));
  try {
    const stateDir = defaultStateDir(project);
    assert.equal(stateDir.startsWith(path.join(project, ".opencode")), false);
    assert.match(stateDir, /opencode-child/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("registry writes private directory and file modes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-child-private-registry-test-"));
  try {
    const registry = new ChildRegistry(dir);
    await registry.upsert({ id: "child_private", pid: process.pid, status: "ready", baseUrl: "http://127.0.0.1:1" });
    const dirMode = (await stat(dir)).mode & 0o777;
    const fileMode = (await stat(path.join(dir, "children.json"))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
