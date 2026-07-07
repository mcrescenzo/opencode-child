import { createHash, randomBytes } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export function childId() {
  return `child_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function randomPassword(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function basicAuthHeader(username = "opencode", password = "") {
  if (!password) return undefined;
  return `Basic ${Buffer.from(`${username || "opencode"}:${password}`).toString("base64")}`;
}

export function authHeaders(auth = {}) {
  const authorization = basicAuthHeader(auth.username, auth.password);
  return authorization ? { authorization } : {};
}

export function truncate(value, max = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text.length <= max) return text || "";
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\n[truncated ${text.length - end} chars]`;
}

const SECRET_KEY_RE = /(^|_|-|\.)(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|refresh[_-]?token|serverPassword)($|_|-|\.)/i;
const CAMEL_CASE_BOUNDARY_RE = /([a-z0-9])([A-Z])/g;
const REDACT_MAX_DEPTH = 64;

export function isSecretKey(key) {
  const normalized = String(key).replace(CAMEL_CASE_BOUNDARY_RE, "$1_$2");
  return SECRET_KEY_RE.test(normalized);
}

export function redact(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  if (depth >= REDACT_MAX_DEPTH) return "[max-depth]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, depth + 1));
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redact(item, seen, depth + 1);
  }
  return out;
}

const VALUE_SECRET_PATTERNS = [
  // PEM private keys.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----"],
  // Provider, GitHub, and Slack token prefixes.
  [/\b(sk|pk|ghp|gho|github_pat|xox[baprs])-[-_A-Za-z0-9]{12,}\b/g, "$1-[redacted]"],
  // HTTP Authorization tokens.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{12,}/gi, "Basic [redacted]"],
  // Common URL/query/log assignment forms.
  [/\b(api[_-]?key|token|secret|password|passwd|authorization|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*["']?[^\s&"'`,;\[\]]{7,}/gi, "$1=[redacted]"],
];
const LITERAL_SECRET_RE_CACHE_MAX = 256;
const literalSecretReCache = new Map();

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalSecretRe(secret) {
  let pattern = literalSecretReCache.get(secret);
  if (pattern) {
    literalSecretReCache.delete(secret);
    literalSecretReCache.set(secret, pattern);
    return pattern;
  }
  pattern = new RegExp(escapeRegExp(secret), "g");
  literalSecretReCache.set(secret, pattern);
  while (literalSecretReCache.size > LITERAL_SECRET_RE_CACHE_MAX) literalSecretReCache.delete(literalSecretReCache.keys().next().value);
  return pattern;
}

/**
 * Value-level secret scrubber for FREEFORM strings (child stdout/stderr, raw SSE
 * text, message bodies) where redact()'s key-based masking does not reach. Masks
 * common token shapes plus any caller-supplied literal secrets (e.g. the child's
 * generated auth password). Non-strings are returned unchanged.
 */
export function scrubSecrets(value, extraSecrets = []) {
  if (typeof value !== "string") return value;
  let out = value;
  for (const secret of extraSecrets) {
    if (typeof secret !== "string" || !secret.trim()) continue;
    out = out.replace(literalSecretRe(secret), "[redacted]");
  }
  for (const [pattern, replacement] of VALUE_SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function publicRedact(value) {
  const secrets = new Set();
  const stringRefs = [];
  const outputSeen = new WeakSet();
  const secretSeen = new WeakSet();

  const collectSecrets = (item) => {
    if (item === null || item === undefined) return;
    if (typeof item === "string") {
      if (item.trim()) secrets.add(item);
      return;
    }
    if (typeof item !== "object") return;
    if (secretSeen.has(item)) return;
    secretSeen.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) collectSecrets(entry);
      return;
    }
    for (const entry of Object.values(item)) collectSecrets(entry);
  };

  const visit = (item, assign) => {
    if (typeof item === "string") {
      const scrubbed = scrubSecrets(item);
      stringRefs.push({ value: scrubbed, assign });
      return scrubbed;
    }
    if (item === null || item === undefined || typeof item !== "object") return item;
    if (outputSeen.has(item)) return "[circular]";
    outputSeen.add(item);
    if (Array.isArray(item)) {
      const out = [];
      item.forEach((entry, index) => {
        out[index] = visit(entry, (next) => { out[index] = next; });
      });
      return out;
    }
    const out = Object.create(null);
    for (const [key, entry] of Object.entries(item)) {
      if (isSecretKey(key)) {
        collectSecrets(entry);
        out[key] = "[redacted]";
      } else {
        out[key] = visit(entry, (next) => { out[key] = next; });
      }
    }
    return out;
  };

  let safe;
  safe = visit(value, (next) => { safe = next; });
  const secretList = [...secrets];
  for (const ref of stringRefs) ref.assign(scrubSecrets(ref.value, secretList));
  return safe;
}

export function isLoopbackHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

export function isIpLiteralHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return net.isIP(host) !== 0;
}

export function isLoopbackUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function isPlainHttpNonLoopbackUrl(rawUrl = "") {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" && !isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

export function canContactChildUrl(child = {}) {
  try {
    const url = new URL(child.baseUrl);
    if ((url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname)) return true;
    if (url.protocol === "http:" && child.auth?.password) return false;
    return url.protocol === "https:" && child.allowNonLoopback === true && isIpLiteralHostname(url.hostname);
  } catch {
    return false;
  }
}

export function projectStatePath(directory) {
  const resolved = path.resolve(directory || process.cwd());
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const sanitized = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
  const name = /[a-zA-Z0-9]/.test(sanitized) ? sanitized : "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
  return path.join(base, "opencode-child", `${name}-${hash}`);
}

export function childOwnerFromContext(context = {}) {
  if (!context?.sessionID) return undefined;
  return {
    sessionID: String(context.sessionID),
    ...(context.messageID ? { messageID: String(context.messageID) } : {}),
    ...(context.directory ? { directory: path.resolve(context.directory) } : {}),
    ...(context.agent ? { agent: String(context.agent) } : {}),
  };
}

export function childOwnerMatches(owner, context = {}) {
  if (!owner?.sessionID) return true;
  if (String(owner.sessionID) !== String(context?.sessionID || "")) return false;
  if (owner.directory && context?.directory && path.resolve(owner.directory) !== path.resolve(context.directory)) return false;
  return true;
}

export function abortReason(signal) {
  if (!signal?.aborted) return undefined;
  const reason = signal.reason;
  if (reason === undefined) return "operation aborted";
  return reason instanceof Error ? reason.message : String(reason);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error(abortReason(signal));
}

export function sleep(ms, options = {}) {
  return delay(ms, undefined, { signal: options.signal });
}

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeModel(input) {
  if (!input) return undefined;
  if (typeof input === "object" && input.providerID && input.modelID) return input;
  const text = String(input);
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error("model must be provider/model-id, for example openai/gpt-5.5, or pass providerID and modelID separately. Bare model IDs are not accepted");
  }
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

/**
 * Build a model override object from a separate providerID/modelID pair. Both
 * must be non-empty strings, or both omitted. Supplying exactly one (e.g. a
 * provider with an empty model id) throws instead of silently dropping the
 * partial selection, mirroring normalizeModel's strictness for malformed
 * string models. Returns undefined when neither is provided.
 */
export function modelFromParts(providerID, modelID) {
  const hasProvider = typeof providerID === "string" && providerID.length > 0;
  const hasModel = typeof modelID === "string" && modelID.length > 0;
  if (hasProvider !== hasModel) {
    throw new Error("providerID and modelID must both be provided (or both omitted)");
  }
  return hasProvider && hasModel ? { providerID, modelID } : undefined;
}

export function textParts(text, parts) {
  if (Array.isArray(parts) && parts.length > 0) return parts;
  if (typeof text !== "string" || text.length === 0) throw new Error("text or parts is required");
  return [{ type: "text", text }];
}

/**
 * Append `event` to a bounded ring buffer, assigning a MONOTONIC index from
 * buffer.seq (which keeps increasing even after the buffer is trimmed past
 * `limit`). Using a persistent counter instead of events.length keeps indices
 * unique and increasing across wraps, so `since`-based pagination stays correct.
 */
export function appendBoundedEvent(buffer, event, limit) {
  buffer.events.push({ index: buffer.seq, at: nowIso(), ...event });
  buffer.seq += 1;
  if (limit && buffer.events.length > limit) buffer.events.splice(0, buffer.events.length - limit);
  return buffer;
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export function summarizeList(value, limit = 20) {
  if (Array.isArray(value)) return { count: value.length, sample: value.slice(0, limit) };
  if (value && typeof value === "object") return { count: Object.keys(value).length, keys: Object.keys(value).slice(0, limit) };
  return value ?? null;
}

const FORBIDDEN_EXACT = new Set(["/", os.homedir()]);
const PROTECTED_PREFIX = path.join(os.homedir(), ".config", "opencode");

/**
 * Resolve the realpath of `p` and assert it is STRICTLY inside an allowed sandbox
 * root (os.tmpdir() by default, plus any extraRoots). Throws on violation.
 * Returns the resolved realpath, or null if the path does not exist (nothing to delete).
 *
 * realpath defeats symlink/".." escapes; "/", $HOME, and ~/.config/opencode are
 * hard-denied even if a symlink somehow points into the temp tree.
 */
export async function assertInsideSandbox(p, extraRoots = []) {
  if (!p || typeof p !== "string") throw new Error("refusing unsafe delete: empty path");
  let resolved;
  try {
    resolved = await realpath(p);
  } catch (err) {
    if (err?.code === "ENOENT") return null; // nothing there to delete
    throw err;
  }
  const norm = path.resolve(resolved);
  if (FORBIDDEN_EXACT.has(norm)) throw new Error(`refusing recursive delete of protected path: ${norm}`);
  if (norm === PROTECTED_PREFIX || norm.startsWith(PROTECTED_PREFIX + path.sep)) {
    throw new Error(`refusing recursive delete inside ~/.config/opencode: ${norm}`);
  }
  const roots = await resolveSandboxRoots(extraRoots);
  const inside = roots.some((root) => {
    const rr = path.resolve(root);
    return norm !== rr && norm.startsWith(rr + path.sep);
  });
  if (!inside) throw new Error(`refusing recursive delete outside sandbox root: ${norm}`);
  return norm;
}

export async function resolveSandboxRoots(extraRoots = []) {
  const roots = [];
  for (const r of [os.tmpdir(), ...extraRoots]) {
    try { roots.push(await realpath(r)); } catch { roots.push(path.resolve(r)); }
  }
  return roots;
}

/**
 * Guarded recursive remove: deletes `p` only if it passes assertInsideSandbox.
 * On violation (or missing path) it skips and returns a structured result instead
 * of throwing, so it is safe to call from finally/exit cleanup paths.
 */
export async function safeRmDir(p, { extraRoots = [], sandboxRoots, onSkip } = {}) {
  try {
    const target = await assertInsideSandboxWithRoots(p, sandboxRoots || await resolveSandboxRoots(extraRoots));
    if (target === null) return { deleted: false, reason: "missing" };
    await rm(target, { recursive: true, force: true });
    return { deleted: true, path: target };
  } catch (err) {
    onSkip?.(p, err);
    return { deleted: false, reason: err.message };
  }
}

async function assertInsideSandboxWithRoots(p, roots) {
  if (!p || typeof p !== "string") throw new Error("refusing unsafe delete: empty path");
  let resolved;
  try {
    resolved = await realpath(p);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const norm = path.resolve(resolved);
  if (FORBIDDEN_EXACT.has(norm)) throw new Error(`refusing recursive delete of protected path: ${norm}`);
  if (norm === PROTECTED_PREFIX || norm.startsWith(PROTECTED_PREFIX + path.sep)) {
    throw new Error(`refusing recursive delete inside ~/.config/opencode: ${norm}`);
  }
  const inside = roots.some((root) => {
    const rr = path.resolve(root);
    return norm !== rr && norm.startsWith(rr + path.sep);
  });
  if (!inside) throw new Error(`refusing recursive delete outside sandbox root: ${norm}`);
  return norm;
}
