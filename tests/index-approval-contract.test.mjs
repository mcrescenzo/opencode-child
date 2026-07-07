import test from "node:test";
import assert from "node:assert/strict";
import { ChildRegistry } from "../src/registry.js";
import {
  BEARER_SECRET,
  assertNoSecrets,
  withDiagnosticsRoot,
  withPluginContext,
} from "./helpers.mjs";

test("oc_child_stop requires parent approval before signaling registry-only PIDs", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await assert.rejects(
      () => plugin.tool.oc_child_stop.execute({ childId: "child_missing", allowRegistryPidSignal: true }, context),
      /parent approval required for stop\.registry-pid-signal/,
    );
  });
});

test("oc_child_start requires and forwards parent approval for high-risk start args", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({ id: "child_needs_approval", trustMode: "full-trust", dangerouslySkipPermissions: true }, context),
        /parent approval required for start/,
      );

      let approval;
      const approvedContext = {
        ...context,
        async ask(request) {
          approval = request;
          return { status: "approved" };
        },
      };

      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({
          id: "child_approved_bad_bin",
          opencodeBin: "/no/such/opencode",
          timeoutMs: 300,
        }, approvedContext),
        /no such|ENOENT|timed out/i,
      );

      assert.equal(approval.permission, "opencode-child.start");
      assert.ok(approval.metadata.risks.some((risk) => risk.id === "custom-opencode-bin"));
    });
  });
});

test("oc_child_start approval merge authorizes external dirs and unsafe safe-mode overrides", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context, projectDir }) => {
      let approval;
      const approvedContext = {
        ...context,
        async ask(request) {
          approval = request;
          return { status: "approved" };
        },
      };

      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({
          id: "child_approved_merge_bad_bin",
          trustMode: "safe",
          opencodeBin: "/no/such/opencode",
          configDir: `${projectDir}/external-config`,
          allowExternalDirs: true,
          allowUnsafeSafeOverrides: true,
          config: { plugin: ["@example/remote-plugin"] },
          timeoutMs: 300,
        }, approvedContext),
        /no such|ENOENT|timed out/i,
      );

      assert.equal(approval.permission, "opencode-child.start");
      const riskIds = approval.metadata.risks.map((risk) => risk.id);
      assert.ok(riskIds.includes("external-dirs"));
      assert.ok(riskIds.includes("unsafe-safe-overrides"));
      assert.ok(riskIds.includes("custom-opencode-bin"));
      assert.ok(riskIds.includes("config-plugin"));
    });
  });
});

test("oc_child_start approval merge authorizes dangerous env overrides", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      let approval;
      const approvedContext = {
        ...context,
        async ask(request) {
          approval = request;
          return { status: "approved" };
        },
      };

      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({
          id: "child_approved_env_bad_bin",
          opencodeBin: "/no/such/opencode",
          env: { NODE_OPTIONS: "--require ./hook.js" },
          allowUnsafeEnvOverrides: true,
          timeoutMs: 300,
        }, approvedContext),
        /no such|ENOENT|timed out/i,
      );

      assert.equal(approval.permission, "opencode-child.start");
      assert.ok(approval.metadata.risks.some((risk) => risk.id === "dangerous-env-overrides"));
      assert.ok(approval.metadata.risks.some((risk) => /NODE_OPTIONS/.test(risk.description)));
    });
  });
});

test("oc_child_start approval merge authorizes allow-permission config", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      let approval;
      const approvedContext = {
        ...context,
        async ask(request) {
          approval = request;
          return { status: "approved" };
        },
      };

      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({
          id: "child_approved_permission_bad_bin",
          opencodeBin: "/no/such/opencode",
          config: { permission: "allow" },
          allowUnsafeConfigPermissions: true,
          timeoutMs: 300,
        }, approvedContext),
        /no such|ENOENT|timed out/i,
      );

      assert.equal(approval.permission, "opencode-child.start");
      assert.ok(approval.metadata.risks.some((risk) => risk.id === "config-permission-allow"));
    });
  });
});

test("oc_child_start approval merge authorizes unknown config keys", async () => {
  await withDiagnosticsRoot(async () => {
    await withPluginContext(async ({ plugin, context }) => {
      let approval;
      const approvedContext = {
        ...context,
        async ask(request) {
          approval = request;
          return { status: "approved" };
        },
      };

      await assert.rejects(
        () => plugin.tool.oc_child_start.execute({
          id: "child_approved_unknown_config_bad_bin",
          opencodeBin: "/no/such/opencode",
          config: { experimentalDanger: true },
          allowUnknownConfigKeys: true,
          timeoutMs: 300,
        }, approvedContext),
        /no such|ENOENT|timed out/i,
      );

      assert.equal(approval.permission, "opencode-child.start");
      assert.ok(approval.metadata.risks.some((risk) => risk.id === "unknown-config-keys"));
      assert.ok(approval.metadata.risks.some((risk) => /experimentalDanger/.test(risk.description)));
    });
  });
});

test("oc_child_restart fails closed when parent approval is unavailable", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await assert.rejects(
      () => plugin.tool.oc_child_restart.execute({ childId: "child_missing" }, context),
      /parent approval required for restart/,
    );
  });
});

test("oc_child_restart approval metadata represents the saved high-risk posture", async () => {
  await withPluginContext(async ({ plugin, context, stateDir, projectDir }) => {
    const registry = new ChildRegistry(stateDir);
    const childId = "child_restart_risky";
    const configDir = `${projectDir}/external-config`;
    const dataDir = `${projectDir}/external-data`;
    const cacheDir = `${projectDir}/external-cache`;
    const xdgStateDir = `${projectDir}/external-state`;
    await registry.upsert({
      id: childId,
      pid: 2147483646,
      status: "stopped",
      expectedStop: true,
      baseUrl: "http://127.0.0.1:9",
      hostname: "0.0.0.0",
      port: 34567,
      projectDir,
      configDir,
      dataDir,
      cacheDir,
      xdgStateDir,
      managedDirs: [configDir, dataDir, cacheDir, xdgStateDir],
      inheritData: true,
      cleanupPolicy: "keep",
      trustMode: "full-trust",
      spec: {
        id: childId,
        projectDir,
        hostname: "0.0.0.0",
        trustMode: "full-trust",
        dangerouslySkipPermissions: true,
        opencodeBin: "/tmp/custom-opencode",
        inheritData: true,
        allowUnsafeSafeOverrides: true,
      },
    });

    const sentinel = new Error("approval captured");
    let approval;
    await assert.rejects(
      () => plugin.tool.oc_child_restart.execute({ childId, port: 45678 }, {
        ...context,
        ask(request) {
          approval = request;
          throw sentinel;
        },
      }),
      sentinel,
    );

    assert.equal(approval.permission, "opencode-child.restart");
    assert.equal(approval.metadata.childId, childId);
    assert.equal(approval.metadata.requestedPort, 45678);
    assert.equal(approval.metadata.restart.trustMode, "full-trust");
    assert.equal(approval.metadata.restart.hostname, "0.0.0.0");
    assert.equal(approval.metadata.restart.nonLoopback, true);
    assert.equal(approval.metadata.restart.customBinary, "/tmp/custom-opencode");
    assert.equal(approval.metadata.restart.inheritData, true);
    assert.equal(approval.metadata.restart.allowUnsafeSafeOverrides, true);
    assert.equal(approval.metadata.restart.dangerouslySkipPermissions, true);
    assert.deepEqual(approval.metadata.restart.externalDirs.managedDirs, [configDir, dataDir, cacheDir, xdgStateDir]);
    const riskIds = approval.metadata.restart.risks.map((risk) => risk.id);
    assert.ok(riskIds.includes("full-trust"));
    assert.ok(riskIds.includes("non-loopback"));
    assert.ok(riskIds.includes("external-dirs"));
    assert.ok(riskIds.includes("custom-opencode-bin"));
    assert.ok(riskIds.includes("inherit-data"));
    assert.ok(riskIds.includes("dangerously-skip-permissions"));
  });
});

test("oc_shell approval metadata scrubs freeform authorization tokens", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    const sentinel = new Error("approval rejected by fixture");
    let approval;
    const shellContext = {
      ...context,
      ask(request) {
        approval = request;
        throw sentinel;
      },
    };

    await assert.rejects(
      () => plugin.tool.oc_shell.execute({
        childId: "child_1",
        sessionId: "ses_child",
        command: `curl -H "Authorization: ${BEARER_SECRET}" https://example.invalid`,
      }, shellContext),
      sentinel,
    );

    assert.equal(approval.permission, "opencode-child.shell");
    assert.match(approval.metadata.command, /Bearer \[redacted\]/);
    assertNoSecrets(approval);
  });
});

test("oc_command requires parent approval before forwarding slash commands", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await assert.rejects(
      () => plugin.tool.oc_command.execute({
        childId: "child_missing",
        sessionId: "ses_child",
        command: "build",
      }, context),
      /parent approval required for command/,
    );
  });
});

test("oc_command approval metadata scrubs freeform authorization tokens", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    const sentinel = new Error("approval rejected by fixture");
    let approval;
    const commandContext = {
      ...context,
      ask(request) {
        approval = request;
        throw sentinel;
      },
    };

    await assert.rejects(
      () => plugin.tool.oc_command.execute({
        childId: "child_1",
        sessionId: "ses_child",
        command: `curl -H "Authorization: ${BEARER_SECRET}" https://example.invalid`,
        arguments: `--token ${BEARER_SECRET}`,
      }, commandContext),
      sentinel,
    );

    assert.equal(approval.permission, "opencode-child.command");
    assert.match(approval.metadata.command, /Bearer \[redacted\]/);
    assert.match(approval.metadata.arguments, /Bearer \[redacted\]/);
    assertNoSecrets(approval);
  });
});

test("oc_child_status with omitted childId requires cross-owner approval for foreign-owned children", async () => {
  await withPluginContext(async ({ plugin, context, stateDir }) => {
    const registry = new ChildRegistry(stateDir);
    const foreignId = "child_foreign_status";
    await registry.upsert({
      id: foreignId,
      pid: 2147483646,
      status: "running",
      baseUrl: "http://127.0.0.1:9",
      hostname: "127.0.0.1",
      port: 34567,
      trustMode: "full-trust",
      owner: { sessionID: "ses_other" },
    });

    const sentinel = new Error("approval captured before aggregate status");
    let approval;
    await assert.rejects(
      () => plugin.tool.oc_child_status.execute({}, {
        ...context,
        ask(request) {
          approval = request;
          throw sentinel;
        },
      }),
      sentinel,
    );

    assert.equal(approval.permission, "opencode-child.status.cross-owner");
    assert.deepEqual(approval.metadata.childIds, [foreignId]);
  });
});

test("oc_permission asks only for approving responses", async () => {
  await withPluginContext(async ({ plugin, context }) => {
    await assert.rejects(
      () => plugin.tool.oc_permission.execute({ childId: "child_missing", sessionId: "ses_child", permissionID: "perm_1", response: "once" }, context),
      /parent approval required for permission/,
    );

    let asked = false;
    await assert.rejects(
      () => plugin.tool.oc_permission.execute({
        childId: "child_missing",
        sessionId: "ses_child",
        permissionID: "perm_1",
        response: "reject",
      }, { ...context, ask() { asked = true; } }),
      /unknown child: child_missing/,
    );
    assert.equal(asked, false);
  });
});
