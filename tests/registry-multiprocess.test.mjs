import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChildRegistry } from "../src/registry.js";

const diskIds = async (dir) => {
  const raw = JSON.parse(await readFile(path.join(dir, "children.json"), "utf8"));
  return raw.children.map((c) => c.id).sort();
};

test("a write by an earlier-loaded instance does not drop another instance's child", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-registry-mp-"));
  try {
    const a = new ChildRegistry(dir);
    const b = new ChildRegistry(dir);
    await a.upsert({ id: "child_a", pid: 1, status: "ready", baseUrl: "http://127.0.0.1:1" });
    await b.upsert({ id: "child_b", pid: 1, status: "ready", baseUrl: "http://127.0.0.1:2" });
    // a was loaded before child_b existed; a second write from a must merge, not clobber.
    await a.upsert({ id: "child_a", pid: 1, status: "ready", marker: 2, baseUrl: "http://127.0.0.1:1" });
    assert.deepEqual(await diskIds(dir), ["child_a", "child_b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deletion sees concurrently-added children and does not resurrect or drop them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-registry-mp-del-"));
  try {
    const a = new ChildRegistry(dir);
    const b = new ChildRegistry(dir);
    await a.upsert({ id: "child_a", pid: 1, status: "ready", baseUrl: "http://127.0.0.1:1" });
    await b.upsert({ id: "child_b", pid: 1, status: "ready", baseUrl: "http://127.0.0.1:2" });
    await a.remove("child_a");
    assert.deepEqual(await diskIds(dir), ["child_b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent writes from separate registry instances preserve every child row", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "oc-registry-mp-concurrent-"));
  try {
    const a = new ChildRegistry(dir);
    const b = new ChildRegistry(dir);
    const writes = Array.from({ length: 40 }, (_, index) => {
      const registry = index % 2 === 0 ? a : b;
      return registry.upsert({ id: `child_${String(index).padStart(2, "0")}`, pid: 1, status: "ready", baseUrl: `http://127.0.0.1:${index + 1}` });
    });

    await Promise.all(writes);

    assert.deepEqual(await diskIds(dir), Array.from({ length: 40 }, (_, index) => `child_${String(index).padStart(2, "0")}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
