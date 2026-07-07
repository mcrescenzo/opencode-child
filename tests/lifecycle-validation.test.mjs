import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChildRegistry } from "../src/registry.js";
import { collectStartRisks, startChild, _test } from "../src/lifecycle.js";
import { isMetadataServiceHostname, safeEnv } from "../src/lifecycle/risk.js";

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

async function withEnv(key, value, fn) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

test("startChild rejects non-loopback hostnames by default", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(() => startChild(registry, { hostname: "0.0.0.0" }, { directory: stateDir }), /non-loopback/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects approved non-loopback HTTP because child auth would be plaintext", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(
      () => startChild(registry, {
        hostname: "192.0.2.10",
        allowNonLoopback: true,
        _parentApprovedRisks: ["high-risk-start"],
      }, { directory: stateDir }),
      /refusing to send Basic auth over non-loopback plaintext HTTP/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects caller configDir before writing opencode.json", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-config-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(() => startChild(registry, { configDir }, { directory: stateDir }), /caller-supplied child dirs/);
    assert.equal(await exists(path.join(configDir, "opencode.json")), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("startChild rejects unsafe safe-mode overrides", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(() => startChild(registry, { trustMode: "safe", env: { API_TOKEN: "secret" } }, { directory: stateDir }), /unsafe safe-mode overrides/);
    await assert.rejects(() => startChild(registry, { trustMode: "safe", config: { mcp: { demo: {} } } }, { directory: stateDir }), /unsafe safe-mode overrides/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects dangerous env overrides without explicit approval", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    const riskIds = collectStartRisks({ env: { NODE_OPTIONS: "--require ./hook.js", PATH: "/tmp/bin" } }).map((risk) => risk.id);
    assert.ok(riskIds.includes("dangerous-env-overrides"));

    await assert.rejects(
      () => startChild(registry, { env: { NODE_OPTIONS: "--require ./hook.js" } }, { directory: stateDir }),
      /dangerous env overrides require allowUnsafeEnvOverrides=true and parent approval: NODE_OPTIONS/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("safeEnv honors inheritEnv=false outside safe mode", async () => {
  await withEnv("NODE_OPTIONS", "--require ./parent-hook.js", async () => {
    const env = safeEnv("inherit", { CUSTOM_CHILD_ENV: "ok" }, false);
    assert.equal(env.CUSTOM_CHILD_ENV, "ok");
    assert.equal(env.HOME, process.env.HOME);
    assert.equal(env.OPENCODE_SERVER_PASSWORD, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
  });
});

test("startChild rejects allow-permission config outside safe mode without explicit approval", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    const riskIds = collectStartRisks({ trustMode: "inherit", config: { permission: "allow" } }).map((risk) => risk.id);
    assert.ok(riskIds.includes("config-permission-allow"));

    await assert.rejects(
      () => startChild(registry, { trustMode: "inherit", config: { permission: "allow" } }, { directory: stateDir }),
      /config\.permission allow requires allowUnsafeConfigPermissions=true and parent approval/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects unknown config keys without explicit approval", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    const risks = collectStartRisks({ config: { experimentalDanger: true, model: "openai/example" } });
    assert.ok(risks.some((risk) => risk.id === "unknown-config-keys" && /experimentalDanger/.test(risk.description)));

    await assert.rejects(
      () => startChild(registry, { config: { experimentalDanger: true } }, { directory: stateDir }),
      /unknown child config keys require allowUnknownConfigKeys=true and parent approval: experimentalDanger/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects non-object config input before writing child config", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(
      () => startChild(registry, { config: ["plugin"] }, { directory: stateDir }),
      /child config must be a JSON object/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild treats OPENCODE_BIN as a safe-mode custom-binary override", async () => {
  await withEnv("OPENCODE_BIN", "/no/such/opencode-from-env", async () => {
    const riskIds = collectStartRisks({ trustMode: "safe" }).map((risk) => risk.id);
    assert.ok(riskIds.includes("custom-opencode-bin"));
    assert.ok(riskIds.includes("unsafe-safe-overrides"));

    const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
    try {
      const registry = new ChildRegistry(stateDir);
      await assert.rejects(
        () => startChild(registry, { trustMode: "safe" }, { directory: stateDir }),
        /unsafe safe-mode overrides rejected: .*custom opencodeBin/,
      );
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

test("collectStartRisks reports high-risk start options", () => {
  const risks = collectStartRisks({ trustMode: "full-trust", hostname: "0.0.0.0", inheritData: true, config: { mcp: { demo: {} } } }).map((risk) => risk.id);
  assert.ok(risks.includes("full-trust"));
  assert.ok(risks.includes("non-loopback"));
  assert.ok(risks.includes("inherit-data"));
  assert.ok(risks.includes("config-mcp"));
});

test("collectStartRisks reports metadata-service hostnames separately from generic non-loopback", () => {
  const risks = collectStartRisks({ hostname: "169.254.169.254" }).map((risk) => risk.id);
  assert.ok(risks.includes("metadata-service-host"));
  assert.ok(risks.includes("non-loopback"));
  assert.equal(isMetadataServiceHostname("metadata.google.internal"), true);
  assert.equal(isMetadataServiceHostname("[fe80::1]"), true);
  assert.equal(isMetadataServiceHostname("192.0.2.10"), false);
});

test("startChild rejects metadata-service hostnames with a specific error", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(
      () => startChild(registry, {
        hostname: "169.254.169.254",
        allowNonLoopback: true,
        _parentApprovedRisks: ["high-risk-start"],
      }, { directory: stateDir }),
      /metadata-service and link-local child hostnames are not supported/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects inheritGlobalConfig=false outside safe mode with actionable guidance", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(
      () => startChild(registry, { trustMode: "inherit", inheritGlobalConfig: false }, { directory: stateDir }),
      /omit these flags for trustMode=inherit or full-trust/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("startChild rejects inheritMcp=false for full-trust even with high-risk approval", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(
      () => startChild(registry, { trustMode: "full-trust", inheritMcp: false, _parentApprovedRisks: ["high-risk-start"] }, { directory: stateDir }),
      /omit these flags for trustMode=inherit or full-trust/,
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("failed starts keep secrets out of restart spec and clean managed dirs", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "oc-start-state-"));
  try {
    const registry = new ChildRegistry(stateDir);
    await assert.rejects(() => startChild(registry, {
      id: "child_bad_bin",
      opencodeBin: "/no/such/opencode",
      config: { model: "openai/example" },
      env: { API_TOKEN: "secret-token" },
      serverPassword: "server-secret",
      _parentApprovedRisks: ["high-risk-start"],
    }, { directory: stateDir, sessionID: "owner_session", messageID: "owner_message" }), /no such|ENOENT|timed out/i);

    const child = await registry.get("child_bad_bin");
    const specText = JSON.stringify(child.spec);
    assert.equal(child.owner.sessionID, "owner_session");
    assert.equal(child.owner.messageID, "owner_message");
    assert.equal(child.owner.directory, path.resolve(stateDir));
    assert.equal(child.spec.config, undefined);
    assert.equal(child.spec.env, undefined);
    assert.equal(child.spec.serverPassword, undefined);
    assert.equal(specText.includes("secret-token"), false);
    assert.equal(specText.includes("server-secret"), false);
    for (const dir of child.managedDirs) assert.equal(await exists(dir), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("writeChildConfig creates the config dir with 0700 mode (not world-readable)", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "oc-child-cfg-"));
  try {
    const configDir = path.join(base, "new-child-config");
    assert.equal(await exists(configDir), false);
    await _test.writeChildConfig(configDir, { model: "x" }, "inherit");
    const dirStat = await stat(configDir);
    assert.equal(dirStat.mode & 0o777, 0o700);
    const fileStat = await stat(path.join(configDir, "opencode.json"));
    assert.equal(fileStat.mode & 0o777, 0o600);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
