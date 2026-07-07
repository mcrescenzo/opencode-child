import test from "node:test";
import assert from "node:assert/strict";
import { ChildRegistry, defaultStateDir } from "../src/registry.js";
import {
  diagnosticLines,
  withDiagnosticsRoot,
  withMockChildServer,
  withPluginContext,
} from "./helpers.mjs";

// Regression: oc_prompt called WITHOUT a sessionId mints a fresh session at
// runtime (createSession). withDiagnostics must record that concrete minted
// sessionId in the diagnostics record, not undefined, so session correlation
// survives the common new-conversation case.
test("oc_prompt without sessionId records the runtime-minted sessionId in diagnostics", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await withMockChildServer((req, res) => {
        req.resume();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        if (req.method === "POST" && req.url === "/session") {
          // createSession mints a fresh session id the caller never supplied.
          res.end(JSON.stringify({ id: "ses_minted_runtime" }));
          return;
        }
        // prompt_async accepted, status settled, inspection endpoints all clean
        // (empty JSON) so the prompt resolves as a plain success, no warning.
        res.end(JSON.stringify(req.url === "/session/status" ? {} : {}));
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_no_session",
          status: "ready",
          pid: process.pid,
          baseUrl,
        });

        const res = await plugin.tool.oc_prompt.execute({
          childId: "child_no_session",
          // no sessionId on purpose
          text: "hello",
          httpTimeoutMs: 200,
          timeoutMs: 1000,
          settleGraceMs: 0,
        }, context);
        assert.ok(res);

        const prompts = (await diagnosticLines(diagRoot))
          .map((line) => JSON.parse(line))
          .filter((r) => r.tool === "oc_prompt");
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        const record = prompts[0];
        assert.equal(record.event, "child_prompt_completed");
        assert.equal(record.outcome, "success");
        assert.equal(record.childID, "child_no_session");
        // The whole point: the minted id is present, not undefined.
        assert.equal(record.sessionID, "ses_minted_runtime");
      });
    });
  });
});

// When sessionId IS supplied, the resolver falls back to args.sessionId.
test("oc_prompt with an explicit sessionId records that sessionId in diagnostics", async () => {
  await withDiagnosticsRoot(async (diagRoot) => {
    await withPluginContext(async ({ plugin, context }) => {
      await withMockChildServer((req, res) => {
        req.resume();
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        // No POST /session should be needed since sessionId is provided.
        res.end(JSON.stringify(req.url === "/session/status" ? {} : {}));
      }, async ({ baseUrl }) => {
        const registry = new ChildRegistry(defaultStateDir(context.directory));
        await registry.upsert({
          id: "child_explicit_session",
          status: "ready",
          pid: process.pid,
          baseUrl,
        });

        await plugin.tool.oc_prompt.execute({
          childId: "child_explicit_session",
          sessionId: "ses_explicit",
          text: "hello",
          httpTimeoutMs: 200,
          timeoutMs: 1000,
          settleGraceMs: 0,
        }, context);

        const prompts = (await diagnosticLines(diagRoot))
          .map((line) => JSON.parse(line))
          .filter((r) => r.tool === "oc_prompt");
        assert.equal(prompts.length, 1, JSON.stringify(prompts));
        assert.equal(prompts[0].sessionID, "ses_explicit");
      });
    });
  });
});
