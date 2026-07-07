import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isSecretKey } from "./util.js";

const SCHEMA = "opencode.plugin.diagnostic.v1";
const PLUGIN = "opencode-child";
const LEVELS = new Set(["debug", "info", "warn", "error"]);
const MAX_STRING = 4_000;
const MAX_RECORD = 16_000;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 100;
const PROJECT_KEY_CACHE_MAX = 128;
const projectKeyCache = new Map();
const SECRET_PATTERNS = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: "-----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----" },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: "Bearer <redacted>" },
  { re: /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, replace: "Basic <redacted>" },
  { re: /\b(sk|pk|ghp|gho|github_pat|xox[baprs])-[_A-Za-z0-9]{12,}\b/g, replace: "$1-<redacted>" },
  { re: /\b(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s"'`,;]{8,}/gi, replace: (_match, key) => `${key}=<redacted>` },
];

function redactText(value) {
  if (value === undefined || value === null) return "";
  let text = String(value);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern.re, pattern.replace);
  if (text.length <= MAX_STRING) return text;
  let end = MAX_STRING;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // back off a lone high surrogate
  return `${text.slice(0, end)}\n[truncated ${text.length - MAX_STRING} chars]`;
}

function redactValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value !== "object") return redactText(String(value));
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[max-depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, seen, depth + 1));
    if (value.length > MAX_ENTRIES) items.push(`[${value.length - MAX_ENTRIES} more items]`);
    return items;
  }
  const out = Object.create(null);
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (count >= MAX_ENTRIES) {
      out.__truncated_entries = Object.keys(value).length - MAX_ENTRIES;
      break;
    }
    out[key] = isSecretKey(key) ? "[redacted]" : redactValue(item, seen, depth + 1);
    count += 1;
  }
  return out;
}

export function summarizeError(error) {
  if (!error) return undefined;
  if (typeof error === "string") return { message: redactText(error) };
  return redactValue({ name: error.name || error.constructor?.name || "Error", message: error.message || String(error), code: error.code });
}

function diagnosticsRoot() {
  if (process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR) return path.resolve(process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DIR);
  const base = process.env.XDG_STATE_HOME ? path.resolve(process.env.XDG_STATE_HOME) : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opencode", "plugin-diagnostics");
}

function safeName(value, fallback = "project") {
  return (String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || fallback);
}

async function projectKey(directory) {
  const resolved = path.resolve(directory || process.cwd());
  const cached = projectKeyCache.get(resolved);
  if (cached) {
    projectKeyCache.delete(resolved);
    projectKeyCache.set(resolved, cached);
    return cached;
  }
  let canonical = resolved;
  try { canonical = await realpath(resolved); } catch {}
  const key = `${safeName(path.basename(canonical || resolved))}-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
  projectKeyCache.set(resolved, key);
  while (projectKeyCache.size > PROJECT_KEY_CACHE_MAX) projectKeyCache.delete(projectKeyCache.keys().next().value);
  return key;
}

function jsonLine(record) {
  let text = JSON.stringify(record);
  if (text.length <= MAX_RECORD) return `${text}\n`;
  text = JSON.stringify({ ...record, data: record.data === undefined ? undefined : "[omitted: record too large]" });
  return `${text}\n`;
}

export function createChildDiagnostics(ctx = {}) {
  let disabled = process.env.OPENCODE_PLUGIN_DIAGNOSTICS_DISABLED === "1";
  const directory = ctx.directory || process.cwd();
  let filePromise;
  async function filePath() {
    if (!filePromise) {
      filePromise = (async () => {
        const dir = path.join(diagnosticsRoot(), await projectKey(directory), PLUGIN);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await chmod(dir, 0o700).catch(() => {});
        return path.join(dir, `${PLUGIN}-${new Date().toISOString().slice(0, 10)}-${process.pid}.jsonl`);
      })();
    }
    return filePromise;
  }
  return {
    async emit(input = {}) {
      if (disabled) return;
      try {
        const record = redactValue({
          schema: SCHEMA,
          ts: new Date().toISOString(),
          plugin: PLUGIN,
          level: LEVELS.has(input.level) ? input.level : "info",
          event: input.event || "plugin_event",
          message: input.message || "",
          sessionID: input.sessionID,
          childID: input.childID,
          tool: input.tool,
          operation: input.operation,
          outcome: input.outcome,
          durationMs: input.durationMs,
          error: summarizeError(input.error),
          data: input.data,
        });
        const target = await filePath();
        await appendFile(target, jsonLine(record), { mode: 0o600 });
        await chmod(target, 0o600).catch(() => {});
      } catch {
        disabled = true;
      }
    },
  };
}

export const __test = { redactText, redactValue, projectKey, diagnosticsRoot, projectKeyCache };
