import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWallet } from "./renkai.mjs";
import { takeStep } from "./lib/battle.mjs";
import { allocateStats } from "./lib/stats.mjs";

async function mutationPath() {
  return join(await mkdtemp(join(tmpdir(), "renkai-stats-")), "agent.json");
}

test("allocates stats through the idempotent agent API with explicit confirmation", async () => {
  const calls = [];
  const configPath = await mutationPath();
  const result = await allocateStats({ agentKey: "key" }, {
    stat: "strength",
    points: "2",
    confirm: "strength:2",
  }, {
    configPath,
    request: async (_config, method, path, body, options) => {
      calls.push({ method, path, body, options });
      return { stat: "strength", points: 2, costGold: 20 };
    },
  });
  assert.deepEqual(result, { stat: "strength", points: 2, costGold: 20 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { stat: "strength", points: 2 });
  assert.equal(calls[0].options.idempotent, true);
  assert.equal(typeof calls[0].options.idempotencyKey, "string");
  assert.deepEqual(JSON.parse(await readFile(`${configPath}.mutations.json`, "utf8")), { version: 1, pending: null });
});

test("fails before network access when a stat spend is not explicitly confirmed", async () => {
  let requests = 0;
  await assert.rejects(
    allocateStats({}, { stat: "luck", points: 1 }, {
      configPath: await mutationPath(),
      request: async () => { requests += 1; },
    }),
    /requires --confirm luck:1/,
  );
  assert.equal(requests, 0);
});

test("rejects malformed allocation receipts and retains the retry identity", async () => {
  const configPath = await mutationPath();
  await assert.rejects(
    allocateStats({}, { stat: "defence", confirm: "defence:1" }, {
      configPath,
      request: async () => ({ stat: "defence", points: 2, costGold: 10 }),
    }),
    (error) => error.code === "API_RESPONSE_INVALID",
  );
  const pending = JSON.parse(await readFile(`${configPath}.mutations.json`, "utf8"));
  assert.equal(pending.pending.operation.includes("defence"), true);
  assert.equal(typeof pending.pending.idempotencyKey, "string");
});

test("step starts the first affordable blacksmith recipe before a quest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-step-craft-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 3,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "key",
    profile: { direction: "blacksmith", resources: ["iron"], goal: "balanced", craftingReserve: { iron: 1 } },
    battle: null,
    automation: { runtime: null, jobId: null, scriptPath: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ method: options.method ?? "GET", path });
    const data = path === "/api/war/state"
      ? { nextWarAt: "2099-01-01T00:00:00.000Z", policy: null, pledge: null }
      : path === "/api/player/state"
        ? { player: { level: 20, branch: "laborer", class: "blacksmith", gold: 100, status: "idle", currentStamina: 10 } }
        : path === "/api/crafting/recipes"
          ? { recipes: [{ id: "recipe_a", name: "Iron Blade", tier: "T1", slot: "weapon", requiredStation: "forge", requiredPlayerLevel: 5, requiredCastleId: null, requiredBranch: "laborer", durationSeconds: 60, gearPower: 5, bonuses: {}, costGold: 10, costResources: { iron: 1 } }] }
          : path === "/api/crafting/jobs"
            ? { jobs: [] }
            : path === "/api/inventory"
              ? { observedAt: "2099-01-01T00:00:00.000Z", resources: { items: [{ resourceId: "iron", category: "ore", amount: 2 }], totalCount: 1 }, gear: { items: [], nextCursor: null }, weight: { system: "castle_population", activeWeight: 1, capacityWeight: null } }
              : { craftingJobId: "job_a", readyAt: "2099-01-01T00:01:00.000Z" };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await takeStep(configPath, config);
    assert.equal(result.action, "started_craft");
    assert.equal(result.recipe.id, "recipe_a");
    assert.equal(calls.some(({ method, path }) => method === "POST" && path === "/api/crafting/request"), true);
    assert.equal(calls.some(({ path }) => path === "/api/quests"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
