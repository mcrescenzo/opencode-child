import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PLUGIN_PATH, EXPECTED_OPENCODE_CHILD_TOOLS, redactSmokeResult, runSmoke } from "../src/smoke-core.js";
import { disposeLifecycleState } from "../src/lifecycle.js";
import { writeFakeOpencodeBin } from "./helpers/fake-opencode.mjs";

async function withSmokeFixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-smoke-"));
  const stateDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  const previousBin = process.env.OPENCODE_BIN;
  const previousPath = process.env.PATH;
  const previousTools = process.env.FAKE_OPENCODE_TOOL_IDS;
  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFakeOpencodeBin(root, "opencode");
    delete process.env.OPENCODE_BIN;
    process.env.PATH = previousPath ? `${root}${path.delimiter}${previousPath}` : root;
    return await fn({ stateDir, projectDir });
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousTools === undefined) delete process.env.FAKE_OPENCODE_TOOL_IDS;
    else process.env.FAKE_OPENCODE_TOOL_IDS = previousTools;
    await disposeLifecycleState({ terminateOptions: { graceMs: 0 } }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

async function withMissingBinSmokeFixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-smoke-missing-bin-"));
  const stateDir = path.join(root, "state");
  const projectDir = path.join(root, "project");
  const previousBin = process.env.OPENCODE_BIN;
  const previousPath = process.env.PATH;
  try {
    await mkdir(stateDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    delete process.env.OPENCODE_BIN;
    process.env.PATH = root;
    return await fn({ stateDir, projectDir });
  } finally {
    if (previousBin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previousBin;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await disposeLifecycleState({ terminateOptions: { graceMs: 0 } }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test("runSmoke separates lifecycle, routes, tools, and safe-mode checks", async () => {
  await withSmokeFixture(async ({ stateDir, projectDir }) => {
    const env = { FAKE_OPENCODE_TOOL_IDS: EXPECTED_OPENCODE_CHILD_TOOLS.join(",") };

    const result = await runSmoke({ stateDir, projectDir, pluginPath: DEFAULT_PLUGIN_PATH, expectedTools: EXPECTED_OPENCODE_CHILD_TOOLS, env, timeoutMs: 3000 });

    assert.equal(result.ok, true);
    assert.equal(result.lifecycleOk, true);
    assert.equal(result.requiredRoutesOk, true);
    assert.equal(result.toolsOk, true);
    assert.equal(result.safetyOk, true);
    assert.equal(result.routeCompatibility.requiredRouteFailures.length, 0);
    assert.deepEqual(result.missingTools, []);
    assert.equal(result.toolRegistration.config.model, "fake/model");
    assert.equal(result.safeModeNegative.ok, true);
    assert.equal(result.lifecycle.stopped, true);
  });
});

test("redactSmokeResult scrubs secrets before standalone CLI output", () => {
  const result = redactSmokeResult({
    ok: false,
    phase: "status",
    serverPassword: "literal-child-password-123456",
    commands: {
      sample: [
        {
          name: "danger",
          token: "secret-token-value-123456",
          description: "failed with secret-token-value-123456 and Bearer abcdefghijklmnopqrstuvwxyz123456",
        },
      ],
    },
    agents: { sample: [{ id: "build", apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" }] },
    tools: { sample: ["tool saw password=hunter2"] },
  });

  const text = JSON.stringify(result);
  assert.equal(text.includes("literal-child-password-123456"), false, text);
  assert.equal(text.includes("secret-token-value-123456"), false, text);
  assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz123456"), false, text);
  assert.equal(text.includes("hunter2"), false, text);
  assert.equal(result.serverPassword, "[redacted]");
  assert.equal(result.commands.sample[0].token, "[redacted]");
  assert.equal(result.agents.sample[0].apiKey, "[redacted]");
});

test("standalone smoke CLI prints the redacted smoke result", async () => {
  const smokeScript = await import("node:fs/promises").then(({ readFile }) => readFile(path.resolve("scripts/smoke.js"), "utf8"));
  assert.match(smokeScript, /redactSmokeResult\(result\)/);
  assert.doesNotMatch(smokeScript, /JSON\.stringify\(result/);
});

test("runSmoke returns startup failure evidence when the child never becomes healthy", async () => {
  await withSmokeFixture(async ({ stateDir, projectDir }) => {
    const result = await runSmoke({
      stateDir,
      projectDir,
      pluginPath: false,
      expectedTools: [],
      env: { FAKE_OPENCODE_MODE: "unhealthy" },
      timeoutMs: 300,
    });

    assert.equal(result.ok, false);
    assert.equal(result.phase, "start");
    assert.equal(result.lifecycleOk, false);
    assert.equal(result.lifecycle.childStarted, false);
    assert.match(result.error, /child health check timed out/);
    assert.equal(result.toolRegistration.skipped, true);
  });
});

test("runSmoke returns startup failure evidence when opencode is missing", async () => {
  await withMissingBinSmokeFixture(async ({ stateDir, projectDir }) => {
    const result = await runSmoke({
      stateDir,
      projectDir,
      pluginPath: false,
      expectedTools: [],
      trustMode: "inherit",
      timeoutMs: 300,
    });

    assert.equal(result.ok, false);
    assert.equal(result.phase, "start");
    assert.equal(result.lifecycleOk, false);
    assert.match(result.error, /ENOENT|opencode/);
    assert.equal(result.toolRegistration.skipped, true);
  });
});

test("runSmoke fails tool registration when expected oc tools are absent", async () => {
  await withSmokeFixture(async ({ stateDir, projectDir }) => {
    const env = { FAKE_OPENCODE_TOOL_IDS: "oc_child_start,oc_child_status" };

    const result = await runSmoke({ stateDir, projectDir, pluginPath: DEFAULT_PLUGIN_PATH, expectedTools: EXPECTED_OPENCODE_CHILD_TOOLS, env, timeoutMs: 3000 });

    assert.equal(result.lifecycleOk, true);
    assert.equal(result.requiredRoutesOk, true);
    assert.equal(result.toolsOk, false);
    assert.equal(result.ok, false);
    assert.ok(result.missingTools.includes("oc_plugin_smoke_test"));
  });
});
