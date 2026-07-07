import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOpenCodeChildPlugin } from "../src/index-core.js";
import { ChildRegistry } from "../src/registry.js";

export const BEARER_SECRET = "Bearer abcdefghijklmnopqrstuvwxyz123456";
export const BASIC_SECRET = "Basic dXNlcjpzdXBlcnNlY3JldA==";
export const API_KEY_SECRET = "sk-abcdefghijklmnopqrstuvwxyz123456";
export const CHILD_PASSWORD = "literal-child-password-123456";

// Lightweight stand-in for the opencode plugin `tool` helper so contract
// suites never transitively import the package that requires opencode
// infrastructure. The real helper is an identity function whose `schema` is
// the zod schema builder; these tests exercise tool `execute`/hook behavior
// and never validate the arg schemas, so a chainable no-op proxy is faithful.
function makeSchemaStub() {
  const handler = {
    get: () => (..._args) => proxy,
    apply: () => proxy,
  };
  const proxy = new Proxy(function noop() {}, handler);
  return proxy;
}

const toolStub = (definition) => definition;
toolStub.schema = makeSchemaStub();

export const OpenCodeChildPlugin = createOpenCodeChildPlugin(toolStub);

export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function withTempRegistry(prefix, fn) {
  if (typeof prefix === "function") {
    fn = prefix;
    prefix = "opencode-child-registry-";
  }
  return await withTempDir(prefix, async (stateDir) => fn({ stateDir, registry: new ChildRegistry(stateDir) }));
}

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

export async function withMockChildServer(handler, fn) {
  const server = http.createServer(handler);
  await listenLoopback(server);

  const { port } = server.address();
  try {
    return await fn({ server, port, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await closeServer(server);
  }
}

export async function withPluginContext(fn) {
  return await withTempDir("opencode-child-index-project-", async (projectDir) => {
    return await withTempDir("opencode-child-index-state-", async (stateDir) => {
      const previousStateDir = process.env.OPENCODE_CHILD_STATE_DIR;
      process.env.OPENCODE_CHILD_STATE_DIR = stateDir;
      try {
        const plugin = await OpenCodeChildPlugin({});
        const context = { directory: projectDir, sessionID: "ses_parent" };
        return await fn({ plugin, context, projectDir, stateDir });
      } finally {
        if (previousStateDir === undefined) delete process.env.OPENCODE_CHILD_STATE_DIR;
        else process.env.OPENCODE_CHILD_STATE_DIR = previousStateDir;
      }
    });
  });
}

export async function withDiagnosticsRoot(fn) {
  return await withTempDir("opencode-child-diagnostics-", async (dir) => {
    const previous = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
    const previousDisabled = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = dir;
    delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
    try {
      return await fn(dir);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR;
      else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR = previous;
      if (previousDisabled === undefined) delete process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED;
      else process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED = previousDisabled;
    }
  });
}

export async function diagnosticLines(root) {
  const projects = await readdir(root).catch(() => []);
  const lines = [];
  for (const project of projects) {
    const pluginDir = path.join(root, project, "opencode-child");
    for (const file of await readdir(pluginDir).catch(() => [])) {
      if (!file.endsWith(".jsonl")) continue;
      const content = await readFile(path.join(pluginDir, file), "utf8");
      lines.push(...content.trim().split(/\r?\n/).filter(Boolean));
    }
  }
  return lines;
}

export function stringify(value) {
  return JSON.stringify(value);
}

export function assertNoSecrets(value) {
  const text = stringify(value);
  assert.equal(text.includes("abcdefghijklmnopqrstuvwxyz123456"), false, text);
  assert.equal(text.includes("dXNlcjpzdXBlcnNlY3JldA"), false, text);
  assert.equal(text.includes(CHILD_PASSWORD), false, text);
}
