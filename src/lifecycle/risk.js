import path from "node:path";
import { isLoopbackHostname, isSecretKey } from "../util.js";

function hasEntries(value) {
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

const CONFIG_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "agent",
  "attachment",
  "autoshare",
  "autoupdate",
  "command",
  "compaction",
  "default_agent",
  "disabled_providers",
  "enabled_providers",
  "enterprise",
  "experimental",
  "formatter",
  "instructions",
  "keybinds",
  "layout",
  "logLevel",
  "lsp",
  "mcp",
  "mode",
  "model",
  "permission",
  "plugin",
  "provider",
  "reference",
  "references",
  "server",
  "share",
  "shell",
  "skills",
  "small_model",
  "snapshot",
  "theme",
  "tool_output",
  "tools",
  "username",
  "watcher",
]);

function isConfigRecord(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function configRecord(value) {
  return isConfigRecord(value) && value ? value : {};
}

function unknownConfigKeys(config = {}) {
  return Object.keys(configRecord(config)).filter((key) => !CONFIG_TOP_LEVEL_KEYS.has(key));
}

function permissionHasAllow(value) {
  if (!value) return false;
  if (value === "allow") return true;
  if (typeof value !== "object") return false;
  for (const item of Object.values(value)) {
    if (item === "allow" || permissionHasAllow(item)) return true;
  }
  return false;
}

function pluginSpecKind(spec) {
  const value = Array.isArray(spec) ? spec[0] : spec;
  if (typeof value !== "string") return "unknown";
  if (value.startsWith(".") || value.startsWith("/") || value.startsWith("file://")) return "local";
  return "remote";
}

function pluginKinds(config = {}) {
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return new Set(plugins.map(pluginSpecKind));
}

function tokenLikeEnv(env = {}) {
  return Object.keys(env).filter(isSecretKey);
}

const DANGEROUS_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "PATH",
  "PYTHONPATH",
  "PERL5LIB",
  "RUBYOPT",
  "GEM_HOME",
  "GEM_PATH",
]);

function dangerousEnvKeys(env = {}) {
  return Object.keys(env).filter((key) => DANGEROUS_ENV_KEYS.has(key.toUpperCase()));
}

export function effectiveOpencodeBin(args = {}, env = process.env) {
  return args.opencodeBin || env.OPENCODE_BIN;
}

export function safePermissionBaseline(permission) {
  return permission ?? {
    read: "allow",
    list: "allow",
    glob: "allow",
    grep: "allow",
    lsp: "allow",
    skill: "allow",
    todowrite: "allow",
    edit: "ask",
    bash: "ask",
    task: "ask",
    webfetch: "ask",
    websearch: "ask",
    external_directory: "ask",
  };
}

export function safeEnv(mode, envOverrides = {}, inheritEnv = true) {
  if (inheritEnv) return { ...process.env, ...envOverrides };
  const keep = ["HOME", "PATH", "SHELL", "TERM", "TMPDIR", "USER", "LOGNAME"];
  const env = {};
  for (const key of keep) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...envOverrides };
}

function ipv4Parts(hostname) {
  const parts = String(hostname || "").trim().split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? octets : undefined;
}

export function isMetadataServiceHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  const ipv4 = ipv4Parts(host);
  if (ipv4?.[0] === 169 && ipv4[1] === 254) return true;
  if (host === "100.100.100.200") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
  return [
    "metadata",
    "metadata.google.internal",
    "metadata.google.internal.",
    "metadata.oraclecloud.com",
    "instance-data",
    "instance-data.ec2.internal",
  ].includes(host);
}

export function assertNoUnsafeSafeOverrides(args, trustMode) {
  if (trustMode !== "safe") return [];
  const config = args.config || {};
  const risks = [];
  if (args.inheritEnv) risks.push("safe mode cannot inherit the full parent environment");
  const tokenKeys = tokenLikeEnv(args.env || {});
  if (tokenKeys.length) risks.push(`safe mode env contains token-like keys: ${tokenKeys.join(", ")}`);
  if (permissionHasAllow(config.permission)) risks.push("safe mode config.permission contains allow");
  if (hasEntries(config.mcp)) risks.push("safe mode config contains MCP servers");
  const kinds = pluginKinds(config);
  if (kinds.has("remote") || kinds.has("unknown")) risks.push("safe mode config contains remote/npm plugin specs");
  if (effectiveOpencodeBin(args)) risks.push("safe mode cannot use a custom opencodeBin");
  if (risks.length && !(args.allowUnsafeSafeOverrides && args._parentApprovedRisks?.includes("unsafe-safe-overrides"))) {
    throw new Error(`unsafe safe-mode overrides rejected: ${risks.join("; ")}`);
  }
  return risks;
}

export function collectStartRisks(args = {}) {
  const trustMode = args.trustMode || "inherit";
  const hostname = args.hostname || "127.0.0.1";
  const risks = [];
  const config = configRecord(args.config);
  const unknownKeys = unknownConfigKeys(config);
  if (trustMode === "full-trust") risks.push({ id: "full-trust", description: "start child in full-trust mode" });
  if (args.dangerouslySkipPermissions) risks.push({ id: "dangerously-skip-permissions", description: "auto-approve child permissions not explicitly denied" });
  if (isMetadataServiceHostname(hostname)) risks.push({ id: "metadata-service-host", description: `bind child server to metadata/link-local host ${hostname}` });
  if (!isLoopbackHostname(hostname)) risks.push({ id: "non-loopback", description: `bind child server to ${hostname}` });
  if (args.inheritData) risks.push({ id: "inherit-data", description: "share real OpenCode data/cache/state with child" });
  const opencodeBin = effectiveOpencodeBin(args);
  if (opencodeBin) risks.push({ id: "custom-opencode-bin", description: `run custom opencode binary: ${opencodeBin}` });
  if (["configDir", "dataDir", "cacheDir", "xdgStateDir"].some((key) => args[key])) risks.push({ id: "external-dirs", description: "use caller-supplied child config/data dirs" });
  if (unknownKeys.length) risks.push({ id: "unknown-config-keys", description: `unknown child config keys: ${unknownKeys.join(", ")}` });
  const envKeys = dangerousEnvKeys(args.env || {});
  if (envKeys.length) risks.push({ id: "dangerous-env-overrides", description: `override interpreter/loader env vars: ${envKeys.join(", ")}` });
  if (permissionHasAllow(config.permission)) risks.push({ id: "config-permission-allow", description: "child config.permission grants allow" });
  if (hasEntries(config.mcp)) risks.push({ id: "config-mcp", description: "load child MCP configuration" });
  if (Array.isArray(config.plugin) && config.plugin.length) risks.push({ id: "config-plugin", description: "load child plugin configuration" });
  if (trustMode === "safe") {
    const unsafe = [];
    if (args.inheritEnv) unsafe.push("inheritEnv");
    if (tokenLikeEnv(args.env || {}).length) unsafe.push("token-like env");
    if (permissionHasAllow(config.permission)) unsafe.push("allow permissions");
    if (hasEntries(config.mcp)) unsafe.push("mcp");
    const kinds = pluginKinds(config);
    if (kinds.has("remote") || kinds.has("unknown")) unsafe.push("remote/npm plugin");
    if (opencodeBin) unsafe.push("custom opencodeBin");
    if (unsafe.length) risks.push({ id: "unsafe-safe-overrides", description: `unsafe safe-mode overrides: ${unsafe.join(", ")}` });
  }
  return risks;
}

function assertConfigRecord(args) {
  if (!isConfigRecord(args.config)) {
    throw new Error("child config must be a JSON object");
  }
}

function assertUnknownConfigApproval(args) {
  const keys = unknownConfigKeys(args.config);
  if (keys.length && !(args.allowUnknownConfigKeys && args._parentApprovedRisks?.includes("unknown-config-keys"))) {
    throw new Error(`unknown child config keys require allowUnknownConfigKeys=true and parent approval: ${keys.join(", ")}`);
  }
}

function assertDangerousEnvApproval(args) {
  const envKeys = dangerousEnvKeys(args.env || {});
  if (envKeys.length && !(args.allowUnsafeEnvOverrides && args._parentApprovedRisks?.includes("dangerous-env-overrides"))) {
    throw new Error(`dangerous env overrides require allowUnsafeEnvOverrides=true and parent approval: ${envKeys.join(", ")}`);
  }
}

function assertConfigPermissionApproval(args) {
  if (permissionHasAllow(args.config?.permission) && !(args.allowUnsafeConfigPermissions && args._parentApprovedRisks?.includes("config-permission-allow"))) {
    throw new Error("child config.permission allow requires allowUnsafeConfigPermissions=true and parent approval");
  }
}

function assertExternalDirApproval(args, managedDirs = []) {
  const callerDirs = ["configDir", "dataDir", "cacheDir", "xdgStateDir"].filter((key) => args[key] && !managedDirs.includes(path.resolve(args[key])));
  if (callerDirs.length && !(args.allowExternalDirs && args._parentApprovedRisks?.includes("external-dirs"))) {
    throw new Error(`caller-supplied child dirs require allowExternalDirs=true and parent approval: ${callerDirs.join(", ")}`);
  }
}

function assertHighRiskApproval(args, trustMode, hostname) {
  const highRisk = effectiveOpencodeBin(args) || trustMode === "full-trust" || args.dangerouslySkipPermissions || args.inheritData || !isLoopbackHostname(hostname);
  if (highRisk && !args._parentApprovedRisks?.includes("high-risk-start")) {
    throw new Error("high-risk child start requires parent approval");
  }
}

export function validateStartPreflight(args = {}, values = {}) {
  const trustMode = values.trustMode || args.trustMode || "inherit";
  const hostname = values.hostname || args.hostname || "127.0.0.1";
  if (isMetadataServiceHostname(hostname)) {
    throw new Error("metadata-service and link-local child hostnames are not supported");
  }
  if (!isLoopbackHostname(hostname) && !args.allowNonLoopback) {
    throw new Error("non-loopback child servers require allowNonLoopback=true and parent approval");
  }
  if (!isLoopbackHostname(hostname)) {
    throw new Error("non-loopback child servers require a TLS-backed child connection; refusing to send Basic auth over non-loopback plaintext HTTP");
  }
  if (args.dangerouslySkipPermissions && trustMode !== "full-trust") {
    throw new Error("dangerouslySkipPermissions requires trustMode=full-trust");
  }
  if ((args.inheritGlobalConfig === false || args.inheritMcp === false) && trustMode !== "safe") {
    throw new Error("inheritGlobalConfig=false and inheritMcp=false are only supported when trustMode=safe (the --pure child mode); omit these flags for trustMode=inherit or full-trust");
  }
  assertConfigRecord(args);
  assertUnknownConfigApproval(args);
  assertDangerousEnvApproval(args);
  assertConfigPermissionApproval(args);
  assertNoUnsafeSafeOverrides(args, trustMode);
  assertExternalDirApproval(args, values.managedDirs || []);
  assertHighRiskApproval(args, trustMode, hostname);
}

export async function validateStartArgs(registry, args, values, options = {}) {
  const terminalStatuses = options.terminalStatuses || new Set();
  await registry.load();
  const existing = registry.children.get(values.id);
  if (!args._allowExistingId) {
    if (existing) throw new Error(`child id already exists: ${values.id}`);
  } else if (existing && !(existing.expectedStop || terminalStatuses.has(existing.status))) {
    throw new Error(`child id already exists and is not terminal: ${values.id}`);
  }
}
