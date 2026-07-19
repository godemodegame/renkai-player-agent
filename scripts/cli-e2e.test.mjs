import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWallet } from "./renkai.mjs";
import { emptyNotificationState, readNotificationState } from "./lib/config.mjs";

const CLI_PATH = new URL("./renkai.mjs", import.meta.url).pathname;

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI_PATH, ...args], { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: typeof error?.code === "number" ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(response, payload, status = 200, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(payload));
}

async function httpFixture(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => send(response, { error: { code: "FIXTURE", message: error.message } }, 500));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function configFixture(baseUrl, filename = "agent.json") {
  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-e2e-"));
  const configPath = join(directory, filename);
  const config = {
    version: 3,
    ...createWallet(),
    baseUrl,
    agentKey: "e2e-agent-key",
    profile: { direction: "miner", resources: ["iron"], goal: "balanced" },
    battle: null,
    referral: null,
    automation: {
      runtime: null,
      jobId: null,
      scriptPath: null,
      lastRunAt: null,
      lastPledgedWindowId: null,
      lastAlertedWindowId: null,
      notification: null,
    },
  };
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  return { config, configPath };
}

test("runs notification status inventory and crafting through the real CLI", async () => {
  const events = [];
  const fixture = await httpFixture(async (request, response) => {
    const body = await requestBody(request);
    events.push({ method: request.method, path: request.url, body });
    if (request.url === "/api/player/state") return send(response, { data: { player: { level: 7, status: "idle" } } });
    if (request.url === "/api/notifications?limit=50") {
      return send(response, { data: { items: [{ id: "notification_web_read", type: "craft_ready", payload: { craftingJobId: "job_1" }, readAt: "2026-07-19T00:01:00.000Z", createdAt: "2026-07-19T00:00:00.000Z" }], nextCursor: null } });
    }
    if (request.url === "/api/notifications/ack") return send(response, { data: { results: body.notificationIds.map((id) => ({ id, status: "already_acknowledged" })) } });
    if (request.url === "/api/inventory?limit=25&cursor=cursor_1") {
      return send(response, { data: { observedAt: "2026-07-19T00:00:00.000Z", resources: { items: [], totalCount: 0 }, gear: { items: [], nextCursor: null }, weight: { system: "castle_population", activeWeight: 1, capacityWeight: null } } });
    }
    if (request.url === "/api/crafting/recipes") {
      return send(response, { data: { recipes: [{
        id: "recipe_1",
        name: "Iron Knife",
        tier: "T1",
        slot: "weapon",
        requiredStation: "forge",
        requiredPlayerLevel: 5,
        requiredCastleId: "ashkeep",
        requiredBranch: "laborer",
        durationSeconds: 60,
        gearPower: 4,
        bonuses: {},
        costGold: 10,
        costResources: { iron: 1 },
      }] } });
    }
    return send(response, { error: { code: "NOT_FOUND", message: request.url } }, 404);
  });
  const { config, configPath } = await configFixture(fixture.baseUrl);
  try {
    const status = await runCli(["status", "--config", configPath]);
    const inventory = await runCli(["inventory", "--limit", "25", "--cursor", "cursor_1", "--config", configPath]);
    const recipes = await runCli(["crafting", "recipes", "--config", configPath]);
    assert.deepEqual([status.code, inventory.code, recipes.code], [0, 0, 0]);
    assert.equal(status.stderr + inventory.stderr + recipes.stderr, "");
    const statusOutput = JSON.parse(status.stdout);
    assert.equal(statusOutput.player.level, 7);
    assert.equal(statusOutput.notifications.items[0].id, "notification_web_read");
    assert.equal(JSON.parse(inventory.stdout).weight.capacityWeight, null);
    assert.equal(JSON.parse(recipes.stdout).recipes[0].id, "recipe_1");
    assert.deepEqual(events.map(({ method, path }) => `${method} ${path}`), [
      "GET /api/player/state",
      "GET /api/notifications?limit=50",
      "POST /api/notifications/ack",
      "GET /api/inventory?limit=25&cursor=cursor_1",
      "GET /api/crafting/recipes",
    ]);
    assert.deepEqual((await readNotificationState(configPath)).receivedIds, ["notification_web_read"]);
    const output = status.stdout + inventory.stdout + recipes.stdout;
    assert.equal(output.includes(config.privateKeyPkcs8), false);
    assert.equal(output.includes(config.agentKey), false);
  } finally {
    await fixture.close();
  }
});

test("drains notifications when the config filename ends with the sidecar suffix", async () => {
  const fixture = await httpFixture(async (request, response) => {
    if (request.url === "/api/player/state") return send(response, { data: { player: { level: 7 } } });
    if (request.url === "/api/notifications?limit=50") return send(response, { data: { items: [], nextCursor: null } });
    return send(response, { error: { code: "NOT_FOUND", message: request.url } }, 404);
  });
  const { configPath } = await configFixture(fixture.baseUrl, "agent.notifications.json");
  try {
    const result = await runCli(["status", "--config", configPath]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).player.level, 7);
    assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
  } finally {
    await fixture.close();
  }
});

test("keeps post-output acknowledgement failure retryable", async () => {
  const ackKeys = [];
  const fixture = await httpFixture(async (request, response) => {
    const body = await requestBody(request);
    if (request.url === "/api/player/state") return send(response, { data: { player: { level: 8 } } });
    if (request.url === "/api/notifications?limit=50") {
      return send(response, { data: { items: [{ id: "notification_retry", type: "quest", payload: { gold: 1 }, readAt: null, createdAt: "2026-07-19T00:00:00.000Z" }], nextCursor: null } });
    }
    if (request.url === "/api/notifications/ack") {
      ackKeys.push(request.headers["x-idempotency-key"]);
      assert.deepEqual(body, { notificationIds: ["notification_retry"] });
      return send(response, { error: { code: "TEMPORARY", message: "retry" } }, 503);
    }
    return send(response, { error: { code: "NOT_FOUND", message: request.url } }, 404);
  });
  const { configPath } = await configFixture(fixture.baseUrl);
  try {
    const result = await runCli(["status", "--config", configPath]);
    assert.equal(result.code, 1);
    assert.equal(JSON.parse(result.stdout).notifications.items[0].id, "notification_retry");
    assert.equal(JSON.parse(result.stderr).error.code, "TEMPORARY");
    assert.equal(ackKeys.length, 3);
    assert.equal(new Set(ackKeys).size, 1);
    assert.deepEqual(await readNotificationState(configPath), emptyNotificationState());
  } finally {
    await fixture.close();
  }
});

test("blocks unconfirmed crafting in the real CLI", async () => {
  let requests = 0;
  const fixture = await httpFixture(async (_request, response) => {
    requests += 1;
    send(response, { error: { code: "UNEXPECTED", message: "mutation reached network" } }, 500);
  });
  const { configPath } = await configFixture(fixture.baseUrl);
  try {
    const result = await runCli(["crafting", "start", "--recipe", "recipe_1", "--config", configPath]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(JSON.parse(result.stderr).error.message, /requires --confirm/);
    assert.equal(requests, 0);
  } finally {
    await fixture.close();
  }
});

test("does not forward signed headers across redirects", async () => {
  let redirectedRequests = 0;
  const target = await httpFixture(async (_request, response) => {
    redirectedRequests += 1;
    send(response, { data: {} });
  });
  const redirect = await httpFixture(async (_request, response) => {
    response.writeHead(302, { Location: `${target.baseUrl}/capture` });
    response.end();
  });
  const { configPath } = await configFixture(redirect.baseUrl);
  try {
    const result = await runCli(["inventory", "--config", configPath]);
    assert.equal(result.code, 1);
    assert.equal(redirectedRequests, 0);
  } finally {
    await Promise.all([redirect.close(), target.close()]);
  }
});
