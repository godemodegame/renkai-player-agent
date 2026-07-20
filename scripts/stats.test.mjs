import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
