import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireNotificationLock,
  emptyNotificationState,
  notificationLockPath,
  notificationStatePath,
  readNotificationState,
  releaseNotificationLock,
} from "./lib/config.mjs";
import { drainNotifications } from "./lib/notifications.mjs";

const config = { agentKey: "test-agent", walletAddress: "wallet", privateKeyPkcs8: "not-used" };

async function fixture(prefix = "renkai-notifications-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return { directory, configPath: join(directory, "agent.json") };
}

function item(number, readAt = null) {
  const id = `notification_${String(number).padStart(4, "0")}`;
  return { id, type: "quest", payload: { reward: number }, readAt, createdAt: `2026-07-19T00:${String(number % 60).padStart(2, "0")}:00.000Z` };
}

function page(items, nextCursor = null) {
  return { items, nextCursor };
}

function pagedRequest(pages, calls = []) {
  return async (_config, method, path, body, options) => {
    calls.push({ method, path, body, options });
    if (method === "GET") {
      const cursor = new URL(`https://fixture.test${path}`).searchParams.get("cursor") ?? "first";
      const result = pages[cursor];
      if (!result) throw new Error(`missing page ${cursor}`);
      return result;
    }
    return { results: body.notificationIds.map((id) => ({ id, status: "acknowledged" })) };
  };
}

test("drains unread rows and checkpoints after output then acknowledgement", async () => {
  const { configPath } = await fixture();
  const first = Array.from({ length: 50 }, (_, index) => item(150 - index, index === 1 ? "2026-07-18T00:00:00.000Z" : null));
  const second = [item(100), item(99), item(98)];
  const calls = [];
  const order = [];
  const output = await drainNotifications(configPath, config, async () => { order.push("primary"); return { action: "step" }; }, {
    request: pagedRequest({ first: page(first, "notification_0101"), notification_0101: page(second) }, calls),
    writer: async () => { order.push("writer"); },
  });
  assert.deepEqual(order, ["primary", "writer"]);
  assert.equal(output.notifications.count, 52);
  assert.equal(output.notifications.more, false);
  assert.equal(output.notifications.items.some((notification) => notification.id === first[1].id), false);
  assert.deepEqual(calls.filter((call) => call.method === "GET").map((call) => call.path), [
    "/api/notifications?limit=50", "/api/notifications?limit=50&cursor=notification_0101",
  ]);
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.body.notificationIds.length), [49, 3]);
  assert.equal((await readNotificationState(configPath)).lastAcknowledgedId, "notification_0150");
  assert.deepEqual(await readNotificationState(configPath), { version: 1, lastAcknowledgedId: "notification_0150", sweep: null });
  assert.equal((await stat(notificationStatePath(configPath))).mode & 0o777, 0o600);
  assert.deepEqual(order, ["primary", "writer"]);
});

test("resumes a bounded sweep and revisits the top for insertions", async () => {
  const { configPath } = await fixture();
  const calls = [];
  const pages = { first: page(Array.from({ length: 50 }, (_, i) => item(1000 - i)), "notification_0951") };
  for (let pageIndex = 1; pageIndex < 10; pageIndex += 1) {
    const high = 1000 - pageIndex * 50;
    pages[`notification_${String(high + 1).padStart(4, "0")}`] = page(Array.from({ length: 50 }, (_, i) => item(high - i)), `notification_${String(high - 49).padStart(4, "0")}`);
  }
  const callsForRun = [];
  const request = pagedRequest(pages, callsForRun);
  const firstRun = await drainNotifications(configPath, config, async () => ({ action: "status" }), { request, writer: async () => {} });
  assert.equal(firstRun.notifications.count, 500);
  assert.equal(firstRun.notifications.more, true);
  assert.deepEqual((await readNotificationState(configPath)).sweep, { headId: "notification_1000", nextCursor: "notification_0501" });

  const resumePages = {
    notification_0501: page(Array.from({ length: 50 }, (_, i) => item(500 - i)), "notification_0451"),
    notification_0451: page(Array.from({ length: 49 }, (_, i) => item(449 - i))),
  };
  const resumed = await drainNotifications(configPath, config, async () => ({ action: "status" }), { request: pagedRequest(resumePages, calls), writer: async () => {} });
  assert.equal(resumed.notifications.count, 99);
  assert.equal(resumed.notifications.more, false);
  assert.deepEqual(await readNotificationState(configPath), { version: 1, lastAcknowledgedId: "notification_1000", sweep: null });

  const top = [item(1001), ...Array.from({ length: 49 }, (_, i) => item(1000 - i))];
  const revisit = await drainNotifications(configPath, config, async () => ({ action: "status" }), {
    request: pagedRequest({ first: page(top, "notification_0952"), notification_0952: page(Array.from({ length: 49 }, (_, i) => item(951 - i))) }),
    writer: async () => {},
  });
  assert.equal(revisit.notifications.count, 1);
  assert.equal(revisit.notifications.items[0].id, "notification_1001");
});

test("does not acknowledge or persist when the stdout writer fails", async () => {
  const { configPath } = await fixture();
  const calls = [];
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request: pagedRequest({ first: page([item(2)]) }, calls),
    writer: async () => { throw new Error("stdout failed"); },
  }), /stdout failed/);
  assert.equal(calls.some((call) => call.method === "POST"), false);
  assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
});

test("retries a transient ack with one idempotency key and leaves state retryable", async () => {
  const { configPath } = await fixture();
  const calls = [];
  const waits = [];
  let attempts = 0;
  const request = async (_config, method, path, body, options) => {
    calls.push({ method, path, body, options });
    if (method === "GET") return page([item(2)]);
    attempts += 1;
    if (attempts < 4) throw new TypeError("socket closed");
    return { results: body.notificationIds.map((id) => ({ id, status: "already_acknowledged" })) };
  };
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request, writer: async () => {}, sleep: async (delay) => waits.push(delay), now: () => 1_000_000,
  }), (error) => error.retryAt && error.message === "socket closed");
  const ackCalls = calls.filter((call) => call.method === "POST");
  assert.equal(ackCalls.length, 3);
  assert.deepEqual(ackCalls.map((call) => call.options.idempotencyKey), [ackCalls[0].options.idempotencyKey, ackCalls[0].options.idempotencyKey, ackCalls[0].options.idempotencyKey]);
  assert.deepEqual(waits, [100, 250]);
  assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
  const success = await drainNotifications(configPath, config, async () => ({ action: "step" }), { request, writer: async () => {} });
  assert.equal(success.notifications.count, 1);
  assert.equal((await readNotificationState(configPath)).lastAcknowledgedId, "notification_0002");
});

test("retries transient GETs but does not loop on validation failures", async () => {
  const { configPath } = await fixture();
  const waits = [];
  let getAttempts = 0;
  const request = async (_config, method, path) => {
    if (method === "GET") {
      getAttempts += 1;
      if (getAttempts < 3) { const error = new Error("busy"); error.status = 503; throw error; }
      return page([item(3)]);
    }
    return { results: [{ id: "notification_0003", status: "acknowledged" }] };
  };
  const result = await drainNotifications(configPath, config, async () => ({ action: "step" }), { request, writer: async () => {}, sleep: async (delay) => waits.push(delay) });
  assert.equal(result.notifications.count, 1);
  assert.deepEqual(waits, [100, 250]);
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request: async (_config, method) => method === "GET" ? page([item(4)], "bad") : { results: [] }, writer: async () => {},
  }), (error) => error.code === "NOTIFICATION_PAGE_INVALID");
  let authCalls = 0;
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request: async () => { authCalls += 1; throw new Error("authorization failed"); }, writer: async () => {},
  }), /authorization failed/);
  assert.equal(authCalls, 1);
});

test("rejects incomplete acknowledgements without advancing the sidecar", async () => {
  const { configPath } = await fixture();
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request: async (_config, method, _path, body) => method === "GET" ? page([item(5)]) : { results: [{ id: body.notificationIds[0], status: "not_found" }] },
    writer: async () => {},
  }), (error) => error.code === "NOTIFICATION_ACK_INCOMPLETE");
  assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
});

test("keeps acknowledged output retryable when the sidecar write fails", async () => {
  const { configPath } = await fixture();
  let acknowledgements = 0;
  await assert.rejects(drainNotifications(configPath, config, async () => ({ action: "step" }), {
    request: async (_config, method, _path, body) => {
      if (method === "GET") return page([item(6)]);
      acknowledgements += 1;
      return { results: [{ id: body.notificationIds[0], status: "acknowledged" }] };
    },
    writer: async () => {},
    writeState: async () => { throw new Error("sidecar unavailable"); },
  }), /sidecar unavailable/);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
});

test("locks notification drains, reclaims only genuinely stale locks, and releases by owner token", async () => {
  const { configPath } = await fixture();
  const lockPath = notificationLockPath(configPath);
  const old = Date.now() - 16 * 60 * 1000;
  await writeFile(lockPath, JSON.stringify({ token: "stale", timestamp: old }), { mode: 0o600 });
  await utimes(lockPath, old / 1000, old / 1000);
  const reclaimed = await acquireNotificationLock(configPath);
  assert.equal((await stat(lockPath)).mode & 0o777, 0o600);
  assert.equal(await releaseNotificationLock(reclaimed), true);

  const live = await acquireNotificationLock(configPath);
  let primaryCalled = false;
  await assert.rejects(drainNotifications(configPath, config, async () => { primaryCalled = true; return {}; }, {
    request: async () => page([]), writer: async () => {},
  }), (error) => Boolean(error.code === "NOTIFICATION_DRAIN_BUSY" && error.retryAt));
  assert.equal(primaryCalled, false);
  assert.equal(await releaseNotificationLock(live), true);
});

test("sidecar writes are mode 0600 and use the config-derived path", async () => {
  const { configPath } = await fixture();
  assert.equal(notificationStatePath(configPath), `${configPath}.notifications.json`);
  const state = await readNotificationState(configPath);
  assert.deepEqual(state, emptyNotificationState());
  const mode = await stat(notificationStatePath(configPath)).catch((error) => error);
  assert.equal(mode.code, "ENOENT");
  await mkdir(join(configPath, "unused"), { recursive: true }).catch(() => {});
  await chmod(configPath, 0o600).catch(() => {});
  assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
});
