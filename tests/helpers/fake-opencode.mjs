import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeFakeOpencodeBin(dir, name = "fake-opencode.mjs") {
  const bin = path.join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const hostname = argValue("--hostname", "127.0.0.1");
const port = Number(argValue("--port", "0"));
const mode = process.env.FAKE_OPENCODE_MODE || "ok";
const marker = process.env.FAKE_OPENCODE_MARKER;
const missingRoutes = new Set((process.env.FAKE_OPENCODE_MISSING_ROUTES || "").split(",").map((route) => route.trim()).filter(Boolean));
const toolIds = (process.env.FAKE_OPENCODE_TOOL_IDS || "").split(",").map((tool) => tool.trim()).filter(Boolean);

if (mode === "eaddrinuse-once" && marker && !fs.existsSync(marker)) {
  fs.writeFileSync(marker, String(port));
  console.error("EADDRINUSE: address already in use");
  process.exit(1);
}

if (mode === "idle") {
  setInterval(() => {}, 1000);
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

const send = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const routes = {
  "/path": { cwd: process.cwd() },
  "/project/current": { name: "fake-project" },
  "/config": { model: "fake/model" },
  "/command": [],
  "/agent": [],
  "/mcp": [],
  "/lsp": [],
  "/formatter": [],
  "/experimental/tool/ids": toolIds,
  "/session": [],
  "/session/status": {},
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (missingRoutes.has(url.pathname)) {
    send(res, { error: "missing by fixture" }, 404);
    return;
  }
  if (req.method === "POST" && url.pathname === "/instance/dispose") {
    send(res, { disposed: true });
    setTimeout(() => server.close(() => process.exit(0)), 10);
    return;
  }
  if (req.method === "POST" && url.pathname === "/session") {
    send(res, { id: "ses_fake_smoke", title: "fake smoke" });
    return;
  }
  if (url.pathname === "/global/health") {
    send(res, mode === "unhealthy" ? { ok: false } : { ok: true }, mode === "unhealthy" ? 503 : 200);
    return;
  }
  if (Object.hasOwn(routes, url.pathname)) {
    send(res, routes[url.pathname]);
    return;
  }
  send(res, { error: "not found" }, 404);
});
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, hostname);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, { mode: 0o755 });
  await chmod(bin, 0o755);
  return bin;
}
