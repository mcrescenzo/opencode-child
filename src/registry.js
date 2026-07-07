import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPidAlive, isSecretKey, nowIso, projectStatePath, redact, scrubSecrets, sleep } from "./util.js";

const REGISTRY_FILE = "children.json";
const LOCK_STALE_MS = 30000;
const LOCK_TIMEOUT_MS = 10000;
const LOCK_RETRY_MS = 25;
export const TERMINAL_STATUSES = new Set(["stopping", "stopped", "exited", "failed"]);
// Retention bounds for terminal (stopped/exited/failed) rows so children.json and
// the in-memory map do not grow without bound over a long-lived state directory.
export const MAX_TERMINAL_CHILDREN = 200;
export const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function terminalTimestamp(child) {
  const value = child?.stoppedAt || child?.updatedAt;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function validateChildRow(child, file) {
  if (!child || typeof child !== "object" || typeof child.id !== "string" || !child.id) {
    throw new Error(`invalid child registry row in ${file}: each child must be an object with a non-empty string id`);
  }
  if (child.baseUrl !== undefined) {
    if (typeof child.baseUrl !== "string" || !child.baseUrl) {
      throw new Error(`invalid child registry row in ${file}: child ${child.id} baseUrl must be a non-empty string`);
    }
    try {
      new URL(child.baseUrl);
    } catch (error) {
      throw new Error(`invalid child registry row in ${file}: child ${child.id} baseUrl must be a valid URL`, { cause: error });
    }
  }
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

function scrubRegistryStrings(value, secrets, seen = new WeakSet()) {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubRegistryStrings(item, secrets, seen));
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) out[key] = scrubRegistryStrings(item, secrets, seen);
  return out;
}

function persistedChildRow(child) {
  const secrets = [...collectSecretValues(child)];
  return scrubRegistryStrings(redact(child), secrets);
}

export class ChildRegistry {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.file = path.join(stateDir, REGISTRY_FILE);
    this.lockDir = `${this.file}.lock`;
    this.children = new Map();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
    this.tmpCounter = 0;
  }

  async load() {
    if (this.loaded) return;
    await this.reload();
  }

  // Re-read the on-disk file, REPLACING the in-memory map. children.json is the
  // source of truth (every mutation persists immediately), so reloading before a
  // mutation lets this instance merge in entries written by another instance/process
  // sharing the same state dir instead of clobbering them with a stale snapshot.
  // (A residual read->rename window remains under true multi-process concurrency;
  // single-process ownership per state dir is still the recommended deployment.)
  async readFreshMap() {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700).catch(() => {});
    const next = new Map();
    try {
      const rawText = await readFile(this.file, "utf8");
      let raw;
      try {
        raw = JSON.parse(rawText);
      } catch (error) {
        throw new Error(`invalid child registry JSON at ${this.file}: ${error.message}`, { cause: error });
      }
      const rawChildren = raw?.children;
      if (rawChildren !== undefined && rawChildren !== null && !Array.isArray(rawChildren)) {
        throw new Error(`invalid child registry JSON at ${this.file}: 'children' must be an array`);
      }
      for (const child of rawChildren ?? []) {
        validateChildRow(child, this.file);
        next.set(child.id, child);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return next;
  }

  async reload() {
    const next = await this.readFreshMap();
    this.children = next;
    this.loaded = true;
  }

  async saveMap(childrenMap) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700).catch(() => {});
    this.tmpCounter += 1;
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${this.tmpCounter}.tmp`;
    const children = [...childrenMap.values()].map(persistedChildRow).sort((a, b) => a.id.localeCompare(b.id));
    for (const child of children) validateChildRow(child, this.file);
    await writeFile(tmp, JSON.stringify({ version: 2, updatedAt: nowIso(), children }, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
    await chmod(this.file, 0o600).catch(() => {});
  }

  async save() {
    await this.saveMap(this.children);
  }

  async withFileLock(fn) {
    const started = Date.now();
    while (true) {
      try {
        await mkdir(this.lockDir, { mode: 0o700 });
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (await this.reclaimStaleLock()) continue;
        if (Date.now() - started > LOCK_TIMEOUT_MS) throw new Error(`timed out acquiring child registry lock: ${this.lockDir}`);
        await sleep(LOCK_RETRY_MS);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(this.lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async reclaimStaleLock() {
    const first = await stat(this.lockDir).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!first || Date.now() - first.mtimeMs <= LOCK_STALE_MS) return false;

    await sleep(LOCK_RETRY_MS);
    const latest = await stat(this.lockDir).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!latest) return true;
    if (latest.mtimeMs !== first.mtimeMs || Date.now() - latest.mtimeMs <= LOCK_STALE_MS) return false;

    await rm(this.lockDir, { recursive: true, force: false }).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  }

  async writeLocked(operation) {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => {});
    return await run;
  }

  async transact(mutator) {
    return await this.writeLocked(async () => await this.withFileLock(async () => {
      const base = await this.readFreshMap();
      const next = new Map(base);
      const result = await mutator(next, base);
      this.pruneTerminal(next);
      await this.saveMap(next);
      this.children = next;
      this.loaded = true;
      return result;
    }));
  }

  async list() {
    await this.load();
    return [...this.children.values()].map((child) => ({ ...child, processAlive: isPidAlive(child.pid) }));
  }

  async get(id) {
    await this.load();
    const child = this.children.get(id);
    if (!child) throw new Error(`unknown child: ${id}`);
    // Return a shallow clone (matching list()) so callers cannot mutate the cached
    // Map value in place. Lifecycle sites mutate the returned row (expectedStop,
    // status, logs) before/independently of upsert/markStopped; without this clone a
    // failed persist (call sites use .catch(()=>{})) would leave the in-memory cache
    // diverged from disk.
    return { ...child };
  }

  async upsert(child) {
    return await this.transact(async (next) => {
      const updated = { ...child, updatedAt: nowIso() };
      next.set(child.id, updated);
      return updated;
    });
  }

  async insert(child, options = {}) {
    return await this.transact(async (next) => {
      const existing = next.get(child.id);
      const canReuse = options.allowExistingTerminal && existing && (existing.expectedStop || TERMINAL_STATUSES.has(existing.status));
      if (existing && !canReuse) throw new Error(`child id already exists: ${child.id}`);
      const updated = { ...child, updatedAt: nowIso() };
      next.set(child.id, updated);
      return updated;
    });
  }

  async upsertIfCurrentActive(child) {
    return await this.transact(async (next) => {
      const current = next.get(child.id);
      if (!current) return undefined;
      if (current.expectedStop || TERMINAL_STATUSES.has(current.status)) return current;
      if (child.nonce && current.nonce && child.nonce !== current.nonce) return current;
      const updated = { ...current, ...child, updatedAt: nowIso() };
      next.set(child.id, updated);
      return updated;
    });
  }

  // Evict terminal (stopped/exited/failed/stopping) rows from the given map so it
  // does not grow without bound: drop the oldest rows past maxTerminal and any
  // terminal row whose stoppedAt/updatedAt is older than maxAgeMs. Mutates the map
  // in place and is invoked on the locked write path (transact()). Live (non-terminal)
  // rows are never pruned. Rows touched by the current mutation carry a fresh
  // updatedAt/stoppedAt, so they survive both the age and over-cap checks.
  pruneTerminal(childrenMap, maxTerminal = MAX_TERMINAL_CHILDREN, maxAgeMs = TERMINAL_RETENTION_MS) {
    const now = Date.now();
    const terminal = [];
    for (const child of childrenMap.values()) {
      if (TERMINAL_STATUSES.has(child.status)) terminal.push(child);
    }
    if (terminal.length === 0) return childrenMap;
    terminal.sort((a, b) => terminalTimestamp(a) - terminalTimestamp(b));
    const overCap = maxTerminal >= 0 ? Math.max(0, terminal.length - maxTerminal) : 0;
    for (let i = 0; i < terminal.length; i += 1) {
      const child = terminal[i];
      const tooOld = maxAgeMs >= 0 && now - terminalTimestamp(child) > maxAgeMs;
      if (i < overCap || tooOld) childrenMap.delete(child.id);
    }
    return childrenMap;
  }

  async remove(id) {
    return await this.transact(async (next) => {
      const existed = next.delete(id);
      return existed;
    });
  }

  async markStopped(id, extra = {}) {
    return await this.transact(async (next) => {
      const child = next.get(id);
      if (!child) throw new Error(`unknown child: ${id}`);
      const updated = { ...child, ...extra, status: "stopped", stoppedAt: nowIso(), updatedAt: nowIso() };
      next.set(id, updated);
      return updated;
    });
  }
}

export function defaultStateDir(directory) {
  return process.env.OPENCODE_CHILD_STATE_DIR || projectStatePath(directory || process.cwd());
}
