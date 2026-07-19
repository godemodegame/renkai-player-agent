import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { agentRequest } from "./api.mjs";
import {
  acquireNotificationLock,
  emptyNotificationState,
  readNotificationState,
  releaseNotificationLock,
  writeNotificationState,
} from "./config.mjs";

export const NOTIFICATION_PAGE_LIMIT = 50;
export const NOTIFICATION_MAX_PAGES = 10;
export const NOTIFICATION_MAX_ROWS = 500;
const RETRY_DELAYS = [100, 250];

function clock(options) {
  return typeof options.now === "function" ? options.now : () => options.now ?? Date.now();
}

function retryable(error) {
  const status = Number(error?.status ?? error?.code?.match?.(/^HTTP_(\d{3})$/u)?.[1]);
  if (error?.code === "IDEMPOTENCY_IN_FLIGHT" || error?.name === "AbortError" || error?.code === "ABORT_ERR") return true;
  if (status === 408 || status === 429 || status >= 500) return true;
  if (Number.isFinite(status) || error?.code) return /^(?:ECONN|ETIMEDOUT|EAI_AGAIN|ENET|EHOST|UND_|ERR_NETWORK|NETWORK_ERROR|FETCH_FAILED)/u.test(error.code ?? "");
  return error instanceof TypeError || /(?:network|fetch|socket|timeout|connection)/iu.test(error?.message ?? "");
}

function retryAt(error, now) {
  if (error?.retryAt) return error.retryAt;
  return new Date(now() + 1_000).toISOString();
}

function retryError(error, now) {
  if (error?.retryAt) return error;
  const wrapped = new Error(error?.message ?? String(error));
  Object.assign(wrapped, error, { retryAt: retryAt(error, now) });
  return wrapped;
}

async function retryRequest(operation, options = {}) {
  const now = clock(options);
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!retryable(error) || attempt === 2) throw retryError(error, now);
      let delay = RETRY_DELAYS[attempt];
      if (error?.retryAt) {
        const target = typeof error.retryAt === "number" ? error.retryAt : Date.parse(error.retryAt);
        const remaining = target - now();
        if (Number.isFinite(remaining)) {
          if (remaining > 1_000) throw retryError(error, now);
          delay = Math.max(0, remaining);
        }
      }
      if (delay > 0) await sleep(delay);
    }
  }
  throw new Error("Notification request retry loop ended unexpectedly.");
}

function pagePath(cursor) {
  return `/api/notifications?limit=${NOTIFICATION_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
}

function invalidPage(message) {
  const error = new Error(message);
  error.code = "NOTIFICATION_PAGE_INVALID";
  return error;
}

function validatePage(page) {
  if (!page || typeof page !== "object" || !Array.isArray(page.items) || page.items.length > NOTIFICATION_PAGE_LIMIT
    || (page.nextCursor !== null && (typeof page.nextCursor !== "string" || page.nextCursor.length === 0))) throw invalidPage("Notification page has an invalid shape.");
  if (page.items.length === 0 && page.nextCursor !== null) throw invalidPage("An empty notification page cannot include nextCursor.");
  for (const item of page.items) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || item.id.length < 1
      || typeof item.type !== "string" || !(item.readAt === null || typeof item.readAt === "string")
      || typeof item.createdAt !== "string" || !("payload" in item)) throw invalidPage("Notification item has an invalid shape.");
  }
  return page;
}

function ackError(message, code = "NOTIFICATION_ACK_INCOMPLETE") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateAck(response, ids) {
  const results = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(results) || results.length !== ids.length) throw ackError("Notification acknowledgement response is incomplete.", "NOTIFICATION_ACK_INVALID");
  results.forEach((result, index) => {
    if (!result || result.id !== ids[index] || !["acknowledged", "already_acknowledged"].includes(result.status)) {
      throw ackError("Notification acknowledgement did not complete every item.");
    }
  });
}

async function acknowledge(config, ids, options) {
  const request = options.request ?? agentRequest;
  const idempotencyKey = randomUUID();
  const body = { notificationIds: ids };
  const response = await retryRequest(
    () => request(config, "POST", "/api/notifications/ack", body, { idempotent: true, idempotencyKey }),
    options,
  );
  validateAck(response, ids);
}

function outputValue(primary, notifications) {
  if (primary && typeof primary === "object" && !Array.isArray(primary)) return { ...primary, notifications };
  return { result: primary, notifications };
}

export function writeJsonToStdout(value, stream = process.stdout) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return new Promise((resolve, reject) => {
    let callbackDone = stream.write.length < 2;
    let drained = true;
    let settled = false;
    const finish = () => {
      if (!settled && callbackDone && drained) { settled = true; resolve(); }
    };
    const callback = (error) => {
      callbackDone = true;
      if (error) reject(error);
      else finish();
    };
    try {
      drained = stream.write(text, callback);
      if (stream.write.length < 2) callbackDone = true;
      if (!drained) once(stream, "drain").then(() => { drained = true; finish(); }, reject);
      finish();
    } catch (error) {
      reject(error);
    }
  });
}

function parseArguments(configPath, config, primary, options) {
  if (configPath && typeof configPath === "object") {
    const input = configPath;
    return {
      configPath: input.configPath,
      config: input.config,
      primary: input.primary ?? input.runPrimary ?? input.run ?? input.command,
      options: { ...input, ...(input.options ?? {}) },
    };
  }
  return { configPath, config, primary, options: options ?? {} };
}

async function listPages(config, state, options) {
  const request = options.request ?? agentRequest;
  const pages = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = state.sweep?.nextCursor ?? null;
  let headId = state.sweep?.headId ?? null;
  let boundary = false;
  let more = false;
  for (let pageNumber = 0; pageNumber < NOTIFICATION_MAX_PAGES; pageNumber += 1) {
    if (cursor !== null) {
      if (seenCursors.has(cursor)) throw invalidPage("Notification pagination cursor repeated.");
      seenCursors.add(cursor);
    }
    const page = validatePage(await retryRequest(() => request(config, "GET", pagePath(cursor)), options));
    if (!headId && page.items.length > 0) headId = page.items[0].id;
    const selected = [];
    for (const item of page.items) {
      if (seenIds.has(item.id)) throw invalidPage("Notification pagination repeated an item.");
      seenIds.add(item.id);
      if (boundary) continue;
      if (state.lastAcknowledgedId !== null && item.id <= state.lastAcknowledgedId) {
        boundary = true;
        continue;
      }
      if (item.readAt === null) selected.push(item);
    }
    pages.push({ items: selected, nextCursor: page.nextCursor });
    if (boundary || page.nextCursor === null) break;
    if (pageNumber + 1 === NOTIFICATION_MAX_PAGES) {
      more = true;
      break;
    }
    cursor = page.nextCursor;
  }
  const items = pages.flatMap((page) => page.items);
  if (items.length > NOTIFICATION_MAX_ROWS) throw invalidPage("Notification sweep exceeded its row limit.");
  return { pages, items, headId, more, terminal: !more && (boundary || pages.at(-1)?.nextCursor === null) };
}

function stateAfterPage(state, headId, nextCursor, terminal) {
  return terminal
    ? { ...emptyNotificationState(), lastAcknowledgedId: headId && (!state.lastAcknowledgedId || headId > state.lastAcknowledgedId) ? headId : state.lastAcknowledgedId }
    : { version: 1, lastAcknowledgedId: state.lastAcknowledgedId, sweep: { headId, nextCursor } };
}

export async function drainNotifications(configPath, config, primary, options) {
  const args = parseArguments(configPath, config, primary, options);
  const { options: settings } = args;
  if (!args.configPath || !args.config || typeof args.primary !== "function") throw new TypeError("Notification drain requires configPath, config, and primary.");
  const lock = settings.acquireLock ? await settings.acquireLock(args.configPath, settings) : await acquireNotificationLock(args.configPath, settings);
  const release = settings.releaseLock ?? releaseNotificationLock;
  try {
    const primaryResult = await args.primary();
    const state = settings.readState ? await settings.readState(args.configPath) : await readNotificationState(args.configPath);
    let listed;
    try {
      listed = await listPages(args.config, state, settings);
    } catch (error) {
      if (!retryable(error)) throw error;
      const notificationResult = { status: "retry", items: [], count: 0, more: true, retryAt: retryAt(error, clock(settings)), error: { code: error.code ?? "NETWORK_ERROR", message: error.message } };
      const output = outputValue(primaryResult, notificationResult);
      await (settings.writer ?? settings.output ?? settings.print ?? settings.write ?? writeJsonToStdout)(output);
      return output;
    }
    const notificationResult = { status: "ready", items: listed.items, count: listed.items.length, more: listed.more };
    const output = outputValue(primaryResult, notificationResult);
    await (settings.writer ?? settings.output ?? settings.print ?? settings.write ?? writeJsonToStdout)(output);
    const writeState = settings.writeState ?? ((path, value) => writeNotificationState(path, value));
    for (let index = 0; index < listed.pages.length; index += 1) {
      const page = listed.pages[index];
      if (page.items.length > 0) await acknowledge(args.config, page.items.map((item) => item.id), settings);
      const terminal = !listed.more && index === listed.pages.length - 1;
      if (page.items.length > 0 || terminal || state.sweep) {
        await writeState(args.configPath, stateAfterPage(state, listed.headId, page.nextCursor, terminal));
      }
    }
    return output;
  } finally {
    await release(lock);
  }
}

export const drain = drainNotifications;
export const notificationDrain = drainNotifications;
