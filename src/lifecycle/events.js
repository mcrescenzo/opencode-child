import { appendBoundedEvent, authHeaders, redact, scrubSecrets, sleep, truncate } from "../util.js";

const EVENT_LIMIT = 200;
const EVENT_TEXT_LIMIT = 4000;
const EVENT_BUFFER_LIMIT = 65536;

function scrubParsedData(value, secrets = [], seen = new WeakSet()) {
  if (typeof value === "string") return truncate(scrubSecrets(value, secrets), EVENT_TEXT_LIMIT);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubParsedData(item, secrets, seen));
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) out[key] = scrubParsedData(item, secrets, seen);
  return out;
}

export function parseSseBlock(block, secrets = []) {
  const event = { raw: scrubSecrets(truncate(block, EVENT_TEXT_LIMIT), secrets) };
  const data = [];
  for (const line of String(block).split(/\r?\n/)) {
    if (line.startsWith("event:")) event.type = line.slice(6).trim();
    if (line.startsWith("id:")) event.id = line.slice(3).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length) {
    const text = data.join("\n");
    try {
      event.data = scrubParsedData(redact(JSON.parse(text)), secrets);
    } catch {
      event.data = scrubSecrets(truncate(text, EVENT_TEXT_LIMIT), secrets);
    }
  }
  return event;
}

async function eventTailTerminated(registry, child, controller, terminalStatuses) {
  if (controller.signal.aborted) return true;
  const current = await registry.get(child.id).catch(() => undefined);
  return Boolean(current?.expectedStop || terminalStatuses.has(current?.status));
}

export async function startEventTail(registry, child, notifier, options = {}) {
  const { eventReaders, terminalStatuses } = options;
  if (!eventReaders || !terminalStatuses) throw new Error("startEventTail requires eventReaders and terminalStatuses");
  // The caller (startChildUnlocked) passes a stateDir-namespaced lifecycleKey so the
  // module-level eventReaders map does not collide across projects that reuse a child
  // id. Fall back to the bare id when called without one (direct/unit invocation).
  const key = options.key ?? child.id;
  const persistDebounceMs = options.persistDebounceMs ?? 250;
  const persistEvery = options.persistEvery ?? 25;
  const initialBackoffMs = options.initialBackoffMs ?? 1000;
  const maxBackoffMs = options.maxBackoffMs ?? 4000;
  const sleepFn = options.sleepFn || sleep;

  // Abort any reader still registered for this id before installing a new one, so
  // a re-tail (restart/retry) never orphans a previous AbortController.
  eventReaders.get(key)?.abort();
  const controller = new AbortController();
  eventReaders.set(key, controller);

  const buffer = {
    events: Array.isArray(child.events) ? child.events : [],
    seq: Array.isArray(child.events) && child.events.length > 0 ? child.events.at(-1).index + 1 : 0,
  };
  child.events = buffer.events;

  const headers = authHeaders(child.auth);
  const secrets = [child.auth?.password];
  let dirtyEvents = 0;
  let persistTimer;
  let persistChain = Promise.resolve();

  const persist = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (!dirtyEvents) return persistChain;
    dirtyEvents = 0;
    persistChain = persistChain.then(
      () => registry.upsertIfCurrentActive(child).catch(() => {}),
      () => registry.upsertIfCurrentActive(child).catch(() => {}),
    );
    return persistChain;
  };

  const schedulePersist = () => {
    dirtyEvents += 1;
    if (dirtyEvents >= persistEvery) {
      persist().catch(() => {});
      return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persist().catch(() => {});
    }, persistDebounceMs);
    persistTimer.unref?.();
  };

  const flushPersist = async () => {
    await persist();
    await persistChain;
  };

  const push = async (event) => {
    appendBoundedEvent(buffer, redact(event), EVENT_LIMIT);
    child.events = buffer.events;
    schedulePersist();
  };

  const connectOnce = async () => {
    const res = await fetch(`${child.baseUrl}/global/event`, { headers, redirect: "manual", signal: controller.signal });
    if (!res.ok || !res.body) {
      await push({ type: "event.error", status: res.status });
      return false;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    let discarding = false;
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (discarding) {
        // An oversized frame is being discarded. Wait for the next blank-line
        // block boundary, then resume normal parsing after it.
        const boundary = raw.indexOf("\n\n");
        if (boundary === -1) {
          raw = "";
          continue;
        }
        raw = raw.slice(boundary + 2);
        discarding = false;
        if (!raw) continue;
      }
      // Split off complete blocks first; the tail is the unterminated frame.
      const blocks = raw.split("\n\n");
      raw = blocks.pop() || "";
      for (const block of blocks) {
        const event = parseSseBlock(block, secrets);
        await push(event);
        await notifier?.handleChildEvent(child, event).catch(() => {});
      }
      // If the unterminated tail exceeds the limit, the in-progress frame is
      // oversized. Emit one bounded error marker and discard until the next
      // block boundary so the misparsed frame cannot corrupt later valid frames.
      if (raw.length > EVENT_BUFFER_LIMIT) {
        await push({ type: "event.error", error: truncate("frame exceeded buffer limit; discarding until next block boundary", EVENT_TEXT_LIMIT) });
        discarding = true;
        raw = "";
      }
    }
    return true;
  };

  const run = async () => {
    try {
      let backoff = initialBackoffMs;
      while (!(await eventTailTerminated(registry, child, controller, terminalStatuses))) {
        let streamed = false;
        try {
          streamed = await connectOnce();
        } catch (error) {
          if (controller.signal.aborted) break;
          const event = { type: "event.error", error: error.message };
          await push(event);
          await notifier?.handleChildEvent(child, event).catch(() => {});
        }
        if (await eventTailTerminated(registry, child, controller, terminalStatuses)) break;
        if (streamed) backoff = initialBackoffMs;
        await sleepFn(backoff);
        backoff = Math.min(backoff * 2, maxBackoffMs);
      }
    } finally {
      await flushPersist();
      if (eventReaders.get(key) === controller) eventReaders.delete(key);
    }
  };
  run().catch(() => {});
}
