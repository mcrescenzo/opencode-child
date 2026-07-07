import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, stat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertInsideSandbox, basicAuthHeader, canContactChildUrl, isIpLiteralHostname, isLoopbackHostname, isPlainHttpNonLoopbackUrl, isSecretKey, modelFromParts, projectStatePath, publicRedact, redact, safeRmDir, signalProcessGroup, truncate } from "../src/util.js";

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

function expectedStatePath(base, projectDir, name) {
  const resolved = path.resolve(projectDir);
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(base, "opencode-child", `${name}-${hash}`);
}

test("projectStatePath derives paths from XDG_STATE_HOME with stable sanitized hashes", () => {
  const previous = process.env.XDG_STATE_HOME;
  const base = path.join(os.tmpdir(), "oc-xdg-state");
  const projectDir = path.join(os.tmpdir(), "Project Name With Spaces");
  process.env.XDG_STATE_HOME = base;
  try {
    const expected = expectedStatePath(base, projectDir, "Project_Name_With_Spaces");
    assert.equal(projectStatePath(projectDir), expected);
    assert.equal(projectStatePath(path.join(projectDir, "..", path.basename(projectDir))), expected);
    assert.match(path.basename(projectStatePath(projectDir)), /^[A-Za-z0-9._-]+-[a-f0-9]{16}$/);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("projectStatePath falls back to the default state base and project basename", () => {
  const previous = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  try {
    const projectDir = path.join(os.tmpdir(), "!!!!");
    assert.equal(projectStatePath(projectDir), expectedStatePath(path.join(os.homedir(), ".local", "state"), projectDir, "project"));
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("projectStatePath truncates long sanitized basenames before appending the hash", () => {
  const previous = process.env.XDG_STATE_HOME;
  const base = path.join(os.tmpdir(), "oc-xdg-state-long");
  const basename = "abcdefghijklmnopqrstuvwxyz0123456789EXTRA";
  const projectDir = path.join(os.tmpdir(), basename);
  process.env.XDG_STATE_HOME = base;
  try {
    assert.equal(projectStatePath(projectDir), expectedStatePath(base, projectDir, basename.slice(0, 40)));
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test("assertInsideSandbox accepts a dir inside tmpdir and returns its realpath", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-guard-ok-"));
  try {
    const resolved = await assertInsideSandbox(dir);
    const tmpReal = await realpath(os.tmpdir());
    assert.ok(resolved.startsWith(tmpReal + path.sep), `expected ${resolved} under ${tmpReal}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("assertInsideSandbox returns null for a missing path (nothing to delete)", async () => {
  const missing = path.join(os.tmpdir(), `oc-guard-missing-${process.pid}-${process.hrtime.bigint()}`);
  assert.equal(await assertInsideSandbox(missing), null);
});

test("assertInsideSandbox rejects /, $HOME, and ~/.config/opencode", async () => {
  await assert.rejects(() => assertInsideSandbox("/"), /protected path|outside sandbox/);
  await assert.rejects(() => assertInsideSandbox(os.homedir()), /protected path|outside sandbox/);
  const configDir = path.join(os.homedir(), ".config", "opencode");
  if (await exists(configDir)) {
    await assert.rejects(() => assertInsideSandbox(configDir), /\.config\/opencode/);
  }
});

test("assertInsideSandbox rejects an existing dir outside the sandbox root", async () => {
  // A throwaway dir under $HOME: exists, not forbidden-exact, not under tmpdir -> rejected.
  const outside = await mkdtemp(path.join(os.homedir(), ".oc-guard-outside-"));
  try {
    await assert.rejects(() => assertInsideSandbox(outside), /outside sandbox root/);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("safeRmDir deletes a managed temp dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oc-guard-del-"));
  await writeFile(path.join(dir, "f.txt"), "x");
  const res = await safeRmDir(dir);
  assert.equal(res.deleted, true);
  assert.equal(await exists(dir), false);
});

test("safeRmDir refuses (and does not delete) a path outside the sandbox", async () => {
  const outside = await mkdtemp(path.join(os.homedir(), ".oc-guard-keep-"));
  try {
    const res = await safeRmDir(outside);
    assert.equal(res.deleted, false);
    assert.match(res.reason, /outside sandbox root/);
    assert.equal(await exists(outside), true); // proven not deleted
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("basicAuthHeader builds Basic auth", () => {
  assert.equal(basicAuthHeader("opencode", "secret"), `Basic ${Buffer.from("opencode:secret").toString("base64")}`);
  assert.equal(basicAuthHeader("opencode", ""), undefined);
});

test("redact removes secret-like keys recursively", () => {
  assert.deepEqual(JSON.parse(JSON.stringify(redact({ token: "a", authToken: "aa", clientSecret: "bb", nested: { apiKey: "b", ok: "c" }, list: [{ password: "d" }] }))), {
    token: "[redacted]",
    authToken: "[redacted]",
    clientSecret: "[redacted]",
    nested: { apiKey: "[redacted]", ok: "c" },
    list: [{ password: "[redacted]" }],
  });
});

test("redact and publicRedact keep __proto__ as data on null-prototype copies", () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":"value"},"password":"secret"}');
  const safe = redact(payload);
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.equal(Object.hasOwn(safe, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(safe.nested), null);
  assert.equal(Object.hasOwn(safe.nested, "__proto__"), true);
  assert.equal({}.polluted, undefined);
  assert.equal(safe.password, "[redacted]");

  const publicSafe = publicRedact(payload);
  assert.equal(Object.getPrototypeOf(publicSafe), null);
  assert.equal(Object.hasOwn(publicSafe, "__proto__"), true);
  assert.equal(publicSafe.password, "[redacted]");
});

test("canContactChildUrl refuses non-loopback plaintext HTTP when Basic auth is present", () => {
  assert.equal(isPlainHttpNonLoopbackUrl("http://192.0.2.1:1234"), true);
  assert.equal(isPlainHttpNonLoopbackUrl("http://127.0.0.1:1234"), false);
  assert.equal(isIpLiteralHostname("example.com"), false);
  assert.equal(isIpLiteralHostname("[2001:db8::1]"), true);
  assert.equal(canContactChildUrl({ baseUrl: "http://127.0.0.1:1234", auth: { password: "secret" } }), true);
  assert.equal(canContactChildUrl({ baseUrl: "http://192.0.2.1:1234", allowNonLoopback: true, auth: { password: "secret" } }), false);
  assert.equal(canContactChildUrl({ baseUrl: "https://192.0.2.1:1234", allowNonLoopback: true, auth: { password: "secret" } }), true);
  assert.equal(canContactChildUrl({ baseUrl: "https://example.com:1234", allowNonLoopback: true, auth: { password: "secret" } }), false);
});

test("isSecretKey treats camelCase keyword boundaries as secret-like", () => {
  assert.equal(isSecretKey("apiKey"), true);
  assert.equal(isSecretKey("authToken"), true);
  assert.equal(isSecretKey("clientSecret"), true);
  assert.equal(isSecretKey("serverPassword"), true);
  assert.equal(isSecretKey("notsecret"), false);
  assert.equal(isSecretKey("stonewall"), false);
});

test("redact caps recursion depth instead of overflowing the stack", () => {
  const root = {};
  let cursor = root;
  for (let index = 0; index < 5000; index += 1) {
    cursor.next = {};
    cursor = cursor.next;
  }

  const result = redact(root);
  assert.equal(JSON.stringify(result).includes("[max-depth]"), true);
});

test("truncate does not split UTF-16 surrogate pairs", () => {
  const out = truncate("a😀b", 2);
  const prefix = out.split("\n")[0];
  assert.equal(prefix, "a");
  assert.match(out, /\[truncated 3 chars\]/);
});

test("signalProcessGroup falls back to direct pid signaling and reports failure", () => {
  const originalKill = process.kill;
  const calls = [];
  try {
    process.kill = (pid, signal) => {
      calls.push([pid, signal]);
      if (pid < 0) throw new Error("no process group");
      return true;
    };
    assert.equal(signalProcessGroup(123, "SIGTERM"), true);
    assert.deepEqual(calls, [[-123, "SIGTERM"], [123, "SIGTERM"]]);

    process.kill = () => { throw new Error("no target"); };
    assert.equal(signalProcessGroup(123, "SIGTERM"), false);
  } finally {
    process.kill = originalKill;
  }
});

test("isLoopbackHostname rejects public bind addresses", () => {
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("0.0.0.0"), false);
});

test("modelFromParts returns object for a complete pair", () => {
  assert.deepEqual(modelFromParts("openai", "gpt-5.5"), { providerID: "openai", modelID: "gpt-5.5" });
});

test("modelFromParts returns undefined when both omitted", () => {
  assert.equal(modelFromParts(undefined, undefined), undefined);
  assert.equal(modelFromParts("", ""), undefined);
});

test("modelFromParts throws on a partial pair instead of dropping it", () => {
  assert.throws(() => modelFromParts("openai", ""), /both be provided/);
  assert.throws(() => modelFromParts("openai", undefined), /both be provided/);
  assert.throws(() => modelFromParts("", "gpt-5.5"), /both be provided/);
  assert.throws(() => modelFromParts(undefined, "gpt-5.5"), /both be provided/);
});
