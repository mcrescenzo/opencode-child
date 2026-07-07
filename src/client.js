import { authHeaders, isPlainHttpNonLoopbackUrl, isSecretKey, scrubSecrets, truncate } from "./util.js";
import { PROBED_CAPABILITY_ROUTES } from "./routes.js";

function combinedAbortSignal(timeoutSignal, externalSignal) {
  if (!externalSignal) return { signal: timeoutSignal, cleanup: () => {} };
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any([timeoutSignal, externalSignal]), cleanup: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  timeoutSignal.addEventListener("abort", abort, { once: true });
  externalSignal.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      timeoutSignal.removeEventListener("abort", abort);
      externalSignal.removeEventListener("abort", abort);
    },
  };
}

function abortMessage(timeoutSignal, externalSignal, timeoutMs) {
  if (externalSignal?.aborted) {
    const reason = externalSignal.reason;
    if (reason === undefined) return "caller aborted request";
    const text = reason instanceof Error ? reason.message : String(reason);
    return text ? `caller aborted request: ${text}` : "caller aborted request";
  }
  if (timeoutSignal.aborted) return `timeout after ${timeoutMs}ms`;
  return undefined;
}

function collectSecretValues(value, secretContext = false, seen = new WeakSet(), out = new Set()) {
  if (value === null || value === undefined) return out;
  if (typeof value === "string") {
    if (secretContext && value.trim() && value !== "[redacted]") out.add(value);
    return out;
  }
  if (typeof value !== "object") return out;
  if (seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectSecretValues(item, secretContext, seen, out);
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    collectSecretValues(item, secretContext || isSecretKey(key), seen, out);
  }
  return out;
}

function scrubResponseData(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubResponseData(item, secrets, seen));
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSecretKey(key) ? "[redacted]" : scrubResponseData(item, secrets, seen);
  }
  return out;
}

export class ChildHttpClient {
  constructor(baseUrl, options = {}) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.username = options.username || "opencode";
    this.password = options.password || "";
    this.defaultTimeoutMs = options.timeoutMs ?? 5000;
  }

  async request(method, route, options = {}) {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (this.password && isPlainHttpNonLoopbackUrl(this.baseUrl)) {
      return {
        ok: false,
        status: 0,
        data: null,
        error: `${method} ${route} refused: refusing to send Basic auth over non-loopback plaintext HTTP`,
      };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = combinedAbortSignal(controller.signal, options.signal);
    const headers = { ...authHeaders({ username: this.username, password: this.password }) };
    if (options.body !== undefined) headers["content-type"] = "application/json";

    try {
      const res = await fetch(`${this.baseUrl}${route}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
        signal: abort.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      const secrets = [this.password, ...collectSecretValues(data)];
      const safeText = scrubSecrets(text, secrets);
      const safeData = scrubResponseData(data, secrets);
      if (!res.ok) {
        return { ok: false, status: res.status, data: safeData, error: `${method} ${route} failed ${res.status}: ${truncate(safeText, 1200)}` };
      }
      return { ok: true, status: res.status, data: safeData };
    } catch (error) {
      const rawMessage = abort.signal.aborted ? abortMessage(controller.signal, options.signal, timeoutMs) : undefined;
      const message = scrubSecrets(rawMessage || error?.message || String(error), [this.password]);
      return { ok: false, status: 0, data: null, error: `${method} ${route} failed: ${message}` };
    } finally {
      clearTimeout(timer);
      abort.cleanup();
    }
  }

  get(route, options) { return this.request("GET", route, options); }
  post(route, body, options = {}) { return this.request("POST", route, { ...options, body }); }

  async probeCapabilities(options = {}) {
    const result = {};
    const timeoutMs = options.timeoutMs ?? 2500;
    const responses = await Promise.all(PROBED_CAPABILITY_ROUTES.map(async (route) => {
      const response = await this.get(route, { timeoutMs, signal: options.signal });
      return [route, response];
    }));
    for (const [route, response] of responses) result[route] = { ok: response.ok, status: response.status, error: response.error };
    return result;
  }
}

export function assertOk(response, label) {
  if (!response.ok) throw new Error(`${label}: ${response.error}`);
  return response.data;
}
