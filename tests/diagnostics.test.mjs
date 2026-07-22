import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChildDiagnostics, __test } from "../src/diagnostics.js";

async function withDiagnosticsRoot(fn) {
  const oldDir = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
  const oldDisabled = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-child-diagnostics-test-"));
  process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = dir;
  delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
  try {
    return await fn(dir);
  } finally {
    if (oldDir === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = oldDir;
    if (oldDisabled === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = oldDisabled;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function diagnosticFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.startsWith("opencode-child-") && entry.name.endsWith(".jsonl")) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}

async function diagnosticRecords(root) {
  const files = await diagnosticFiles(root);
  const lines = [];
  for (const file of files) lines.push(...(await readFile(file, "utf8")).trim().split("\n").filter(Boolean));
  return lines.map((line) => JSON.parse(line));
}

test("diagnostic text redaction covers PEM, provider tokens, and generic assignments", () => {
  const text = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "abc123",
    "-----END OPENSSH PRIVATE KEY-----",
    "Bearer abcdefghijklmnop",
    "Basic dXNlcjpwYXNzd29yZA==",
    "github_pat-abcdefghijklmnop",
    "xoxb-abcdefghijklmnop",
    "api_key=abcdefghijklmnop",
    "auth_token: abcdefghijklmnop",
  ].join("\n");

  const redacted = __test.redactText(text);
  assert.match(redacted, /BEGIN PRIVATE KEY/);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /Basic <redacted>/);
  assert.match(redacted, /github_pat-<redacted>/);
  assert.match(redacted, /xoxb-<redacted>/);
  assert.match(redacted, /api_key=<redacted>/);
  assert.match(redacted, /auth_token=<redacted>/);
  assert.equal(redacted.includes("abcdefghijklmnop"), false);
  assert.equal(redacted.includes("dXNlcjpwYXNzd29yZA=="), false);
});

test("diagnostic text truncation does not split a surrogate pair at the MAX_STRING boundary", () => {
  // "a" + 2000 astral emoji => length 4001, so truncation triggers at MAX_STRING (4000),
  // where charCodeAt(3999) is the HIGH surrogate of the straddling emoji.
  const text = "a" + "\u{1F600}".repeat(2000);
  assert.equal(text.length, 4001);

  const redacted = __test.redactText(text);
  const body = redacted.replace(/\n\[truncated \d+ chars\]$/, "");
  const lastCode = body.charCodeAt(body.length - 1);
  assert.equal(lastCode >= 0xd800 && lastCode <= 0xdbff, false, "must not end in a lone high surrogate");
  assert.equal(redacted.includes("�"), false);
  assert.equal(typeof redacted.isWellFormed === "function" ? redacted.isWellFormed() : true, true);
  assert.match(redacted, /\n\[truncated \d+ chars\]$/);
  // The suffix must report the exact number of UTF-16 code units excluded by the
  // adjusted endpoint (end=3999 backs off the lone high surrogate), not MAX_STRING.
  assert.match(redacted, /\n\[truncated 2 chars\]$/);
});

test("emoji crossing the truncation boundary survives a JSONL writeFile/readFile round trip", async () => {
  await withDiagnosticsRoot(async (root) => {
    const message = "a" + "\u{1F600}".repeat(2000);
    await createChildDiagnostics({ directory: "/tmp/project" }).emit({ event: "surrogate_boundary", message });

    const [record] = await diagnosticRecords(root);
    assert.equal(record.event, "surrogate_boundary");
    // The record parsed back cleanly (no U+FFFD replacement char from a lone surrogate).
    assert.equal(record.message.includes("�"), false);
    assert.equal(typeof record.message.isWellFormed === "function" ? record.message.isWellFormed() : true, true);
    // Emojis before the boundary are preserved intact and the record matches the redactText output.
    assert.equal(record.message, __test.redactText(message));
    assert.match(record.message, /😀/);
  });
});

test("diagnostic value redaction preserves __proto__ as data on sanitized copies", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"password":"secret","nested":{"__proto__":"value"}}');
  const redacted = __test.redactValue(payload);
  assert.equal(Object.getPrototypeOf(redacted), null);
  assert.equal(Object.hasOwn(redacted, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(redacted.nested), null);
  assert.equal(Object.hasOwn(redacted.nested, "__proto__"), true);
  assert.equal(redacted.password, "[redacted]");
  assert.equal({}.polluted, undefined);
});

test("diagnostics disabled flag suppresses writes", async () => {
  await withDiagnosticsRoot(async (root) => {
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = "1";
    await createChildDiagnostics({ directory: "/tmp/project" }).emit({ event: "disabled", message: "sk-disabledsecret0000" });
    assert.deepEqual(await diagnosticFiles(root), []);
  });
});

test("diagnostics disable themselves after storage failure", async () => {
  await withDiagnosticsRoot(async (root) => {
    const badRoot = path.join(root, "not-a-directory");
    await writeFile(badRoot, "x", "utf8");
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = badRoot;
    const diagnostics = createChildDiagnostics({ directory: "/tmp/project" });

    await diagnostics.emit({ event: "bad_storage", message: "first" });
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = root;
    await diagnostics.emit({ event: "after_bad_storage", message: "second" });

    assert.deepEqual(await diagnosticRecords(root), []);
  });
});

test("diagnostics omit oversized data records instead of writing huge payloads", async () => {
  await withDiagnosticsRoot(async (root) => {
    const data = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, "x".repeat(2000)]));
    await createChildDiagnostics({ directory: "/tmp/project" }).emit({ event: "large_record", data });

    const [record] = await diagnosticRecords(root);
    assert.equal(record.event, "large_record");
    assert.equal(record.data, "[omitted: record too large]");
  });
});

test("diagnostics test helpers and daily file path memoization are stable", async () => {
  await withDiagnosticsRoot(async (root) => {
    assert.equal(__test.diagnosticsRoot(), root);
    __test.projectKeyCache.clear();
    const key = await __test.projectKey("/tmp/project with spaces");
    assert.match(key, /^project_with_spaces-[a-f0-9]{16}$/);
    assert.equal(__test.projectKeyCache.size, 1);
    assert.equal(await __test.projectKey("/tmp/project with spaces"), key);
    assert.equal(__test.projectKeyCache.size, 1);

    const RealDate = globalThis.Date;
    let current = "2026-07-03T23:59:59.000Z";
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length) return new RealDate(...args);
        return new RealDate(current);
      }
      static now() { return new RealDate(current).getTime(); }
      static parse(value) { return RealDate.parse(value); }
      static UTC(...args) { return RealDate.UTC(...args); }
    }

    try {
      globalThis.Date = FakeDate;
      const diagnostics = createChildDiagnostics({ directory: "/tmp/project" });
      await diagnostics.emit({ event: "day_one" });
      current = "2026-07-04T00:00:01.000Z";
      await diagnostics.emit({ event: "day_two" });
    } finally {
      globalThis.Date = RealDate;
    }

    const files = await diagnosticFiles(root);
    const records = await diagnosticRecords(root);
    assert.equal(files.length, 1);
    assert.match(path.basename(files[0]), /2026-07-03/);
    assert.deepEqual(records.map((record) => record.event), ["day_one", "day_two"]);
  });
});
