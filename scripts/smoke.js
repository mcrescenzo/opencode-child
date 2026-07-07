#!/usr/bin/env node
import { DEFAULT_PLUGIN_PATH, EXPECTED_OPENCODE_CHILD_TOOLS, redactSmokeResult, runSmoke } from "../src/smoke-core.js";

const expectedTools = process.env.OPENCODE_CHILD_EXPECTED_TOOLS
  ? process.env.OPENCODE_CHILD_EXPECTED_TOOLS.split(",").map((tool) => tool.trim()).filter(Boolean)
  : EXPECTED_OPENCODE_CHILD_TOOLS;
const result = await runSmoke({
  projectDir: process.env.OPENCODE_CHILD_PROJECT_DIR,
  trustMode: process.env.OPENCODE_CHILD_TRUST_MODE || "safe",
  pluginPath: process.env.OPENCODE_CHILD_PLUGIN_PATH || DEFAULT_PLUGIN_PATH,
  expectedTools,
});
console.log(JSON.stringify(redactSmokeResult(result), null, 2));
if (!result.ok) process.exitCode = 1;
