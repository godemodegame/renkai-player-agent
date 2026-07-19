import assert from "node:assert/strict";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentRequest,
  agentRequestWithMetadata,
  createWallet,
  parseResponse,
} from "./lib/api.mjs";
import {
  runCraftingCommand,
} from "./lib/crafting.mjs";
import { notificationLockPath } from "./lib/config.mjs";
import { mutationStatePath, readMutationState } from "./lib/mutations.mjs";

function testConfig() {
  return {
    ...createWallet(),
    baseUrl: "https://crafting.example.test",
    agentKey: "agent-key",
  };
}

async function configPath() {
  return join(await mkdtemp(join(tmpdir(), "renkai-crafting-")), "agent.json");
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withFetch(handler, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("maps every crafting subcommand to its canonical route", async () => {
  const config = testConfig();
  const options = { configPath: await configPath() };
  const calls = [];
  const recipe = {
    id: "recipe_iron_sword",
    name: "Iron Sword",
    tier: "T1",
    slot: "weapon",
    requiredPlayerLevel: 5,
    requiredCastleId: "ashkeep",
    requiredBranch: "fighter",
    durationSeconds: 90,
    gearPower: 12,
    bonuses: { strength: 2 },
    costGold: 50,
    costResources: { iron: 3 },
  };
  const readyAt = "2099-01-01T00:01:30.000Z";
  const jobId = "craft_job_123";
  const handler = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const method = options.method ?? "GET";
    const body = options.body ? JSON.parse(String(options.body)) : undefined;
    calls.push({ method, path, body, headers: options.headers ?? {} });
    if (path === "/api/crafting/recipes") return jsonResponse({ data: { recipes: [recipe] } });
    if (path === "/api/crafting/jobs") {
      return jsonResponse({
        serverTime: "2099-01-01T00:00:00.000Z",
        nextRecommendedPollAt: readyAt,
        data: { jobs: [{
          craftingJobId: jobId,
          recipeId: recipe.id,
          status: "in_progress",
          startedAt: "2099-01-01T00:00:00.000Z",
          readyAt,
          claimedAt: null,
          mintStatus: null,
          mintError: null,
        }] },
      });
    }
    if (path === "/api/crafting/request") return jsonResponse({ data: { craftingJobId: jobId, readyAt } });
    if (path === "/api/crafting/cancel") return jsonResponse({ data: { craftingJobId: jobId, status: "cancelled" } });
    if (path === "/api/crafting/claim") {
      return jsonResponse({ data: { craft: { gearItemId: "gear_123", mintStatus: "failed_recoverable", mintError: "RPC unavailable" } } });
    }
    if (path === "/api/crafting/retry-mint") {
      return jsonResponse({ data: { craft: { gearItemId: "gear_123", mintStatus: "complete", mintAddress: "mint_123" } } });
    }
    return jsonResponse({ error: { code: "NOT_FOUND", message: path } }, 404);
  };

  await withFetch(handler, async () => {
    const recipes = await runCraftingCommand(config, "recipes", {}, options);
    assert.deepEqual(recipes, { recipes: [recipe] });

    const list = await runCraftingCommand(config, "list", {}, options);
    assert.deepEqual(list, {
      jobs: [{
        craftingJobId: jobId,
        recipeId: recipe.id,
        status: "in_progress",
        startedAt: "2099-01-01T00:00:00.000Z",
        readyAt,
        claimedAt: null,
        mintStatus: null,
        mintError: null,
      }],
      nextRecommendedPollAt: readyAt,
    });

    const started = await runCraftingCommand(config, "start", { recipe: recipe.id, confirm: recipe.id }, options);
    assert.deepEqual(started, { craftingJobId: jobId, readyAt, nextRecommendedPollAt: readyAt });

    const cancelled = await runCraftingCommand(config, "cancel", { job: jobId, confirm: jobId }, options);
    assert.deepEqual(cancelled, { craftingJobId: jobId, status: "cancelled" });

    const failedClaim = await runCraftingCommand(config, "claim", { job: jobId, confirm: jobId }, options);
    assert.deepEqual(failedClaim, { craft: { gearItemId: "gear_123", mintStatus: "failed_recoverable", mintError: "RPC unavailable" } });

    const retried = await runCraftingCommand(config, "retry-mint", { job: jobId, confirm: jobId }, options);
    assert.deepEqual(retried, { craft: { gearItemId: "gear_123", mintStatus: "complete", mintAddress: "mint_123" } });
  });

  assert.deepEqual(calls.map(({ method, path, body }) => ({ method, path, body })), [
    { method: "GET", path: "/api/crafting/recipes", body: undefined },
    { method: "GET", path: "/api/crafting/jobs", body: undefined },
    { method: "POST", path: "/api/crafting/request", body: { recipeId: recipe.id } },
    { method: "POST", path: "/api/crafting/cancel", body: { craftingJobId: jobId } },
    { method: "POST", path: "/api/crafting/claim", body: { craftingJobId: jobId } },
    { method: "POST", path: "/api/crafting/retry-mint", body: { craftingJobId: jobId } },
  ]);
  for (const call of calls.filter(({ method }) => method === "POST")) {
    assert.equal(typeof call.headers["X-Agent-Wallet"], "string");
    assert.equal(call.headers["X-Agent-Key"], config.agentKey);
    assert.equal(call.headers["X-Idempotency-Key"]?.length > 0, true);
  }
});

test("preserves crafting polling hints and keeps legacy responses data-only", async () => {
  const config = testConfig();
  const readyAt = "2099-01-01T00:05:00.000Z";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/crafting/jobs") {
      return jsonResponse({ data: { jobs: [] }, nextRecommendedPollAt: readyAt });
    }
    if (path === "/api/empty") return jsonResponse({ data: { stable: true }, serverTime: "2099-01-01T00:00:00.000Z" });
    return jsonResponse({ data: { stable: true }, nextRecommendedPollAt: readyAt });
  };
  try {
    assert.deepEqual(await runCraftingCommand(config, "list", {}), { jobs: [], nextRecommendedPollAt: readyAt });
    assert.deepEqual(await agentRequest(config, "GET", "/api/empty"), { stable: true });
    assert.deepEqual(await agentRequestWithMetadata(config, "GET", "/api/empty"), {
      data: { stable: true },
      nextRecommendedPollAt: null,
    });
    const raw = new Response(JSON.stringify({ data: { stable: true }, nextRecommendedPollAt: readyAt }), { status: 200 });
    assert.deepEqual(await parseResponse(raw, { metadata: true }), { data: { stable: true }, nextRecommendedPollAt: readyAt });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const completedJob = {
    craftingJobId: "done",
    recipeId: "recipe_done",
    status: "complete",
    startedAt: "2099-01-01T00:00:00.000Z",
    readyAt: "2099-01-01T00:01:00.000Z",
    claimedAt: "2099-01-01T00:02:00.000Z",
    mintStatus: "minted",
    mintError: null,
  };
  const noHint = await runCraftingCommand(config, "list", {}, {
    requestWithMetadata: async () => ({ data: { jobs: [completedJob] } }),
  });
  assert.deepEqual(noHint, { jobs: [completedJob], nextRecommendedPollAt: null });

  for (const invalidHint of [{}, [], 1, "2026-07-19"]) {
    await assert.rejects(
      runCraftingCommand(config, "list", {}, {
        requestWithMetadata: async () => ({ data: { jobs: [] }, nextRecommendedPollAt: invalidHint }),
      }),
      (error) => error.code === "API_RESPONSE_INVALID",
    );
  }
});

test("rejects cleartext remote API origins before signing or fetch", async () => {
  const config = { ...testConfig(), baseUrl: "http://api.example.test" };
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run");
  };
  try {
    await assert.rejects(agentRequest(config, "GET", "/api/crafting/recipes"), (error) => error.code === "INSECURE_API_ORIGIN");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("requires target-matching confirmation before every crafting mutation", async () => {
  const config = testConfig();
  let calls = 0;
  const request = async () => {
    calls += 1;
    throw new Error("request should not run");
  };
  const mutations = [
    ["start", { recipe: "recipe_1" }],
    ["start", { recipe: "recipe_1", confirm: "recipe_2" }],
    ["cancel", { job: "job_1" }],
    ["cancel", { job: "job_1", confirm: "job_2" }],
    ["claim", { job: "job_1" }],
    ["claim", { job: "job_1", confirm: "job_2" }],
    ["retry-mint", { job: "job_1" }],
    ["retry-mint", { job: "job_1", confirm: "job_2" }],
  ];
  for (const [subcommand, flags] of mutations) {
    await assert.rejects(
      runCraftingCommand(config, subcommand, flags, { request }),
      (error) => error.code === "CONFIRMATION_REQUIRED",
    );
  }
  assert.equal(calls, 0);

  await assert.rejects(runCraftingCommand(config, "start", {}, { request }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(runCraftingCommand(config, "cancel", {}, { request }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(runCraftingCommand(config, "claim", {}, { request }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(runCraftingCommand(config, "retry-mint", {}, { request }), (error) => error.code === "VALIDATION_ERROR");
  assert.equal(calls, 0);
});

test("preserves structured retryAt errors from claim and retry-mint", async () => {
  const config = testConfig();
  const path = await configPath();
  const retryAt = "2099-01-01T00:10:00.000Z";
  const request = async (_config, _method, path) => {
    const error = new Error(path.endsWith("claim") ? "This craft is not finished yet." : "Mint is still in flight.");
    error.code = path.endsWith("claim") ? "COOLDOWN_ACTIVE" : "IDEMPOTENCY_IN_FLIGHT";
    error.status = path.endsWith("claim") ? 429 : 409;
    error.retryAt = retryAt;
    error.details = { state: "submitted_unknown" };
    throw error;
  };
  for (const subcommand of ["claim", "retry-mint"]) {
    await assert.rejects(
      runCraftingCommand(config, subcommand, { job: "job_1", confirm: "job_1" }, { request, configPath: path }),
      (error) => error.code && error.retryAt === retryAt && error.details.state === "submitted_unknown",
    );
  }
});

test("retains the durable mutation identity after an ambiguous HTTP 408", async () => {
  const config = testConfig();
  const path = await configPath();
  const keys = [];
  let attempts = 0;
  const request = async (_config, _method, _path, _body, options) => {
    keys.push(options.idempotencyKey);
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("Request timed out after reaching the server.");
      error.code = "HTTP_408";
      error.status = 408;
      throw error;
    }
    return { craftingJobId: "job_timeout", readyAt: "2099-01-01T00:01:00.000Z" };
  };
  const flags = { recipe: "recipe_timeout", confirm: "recipe_timeout" };
  await assert.rejects(runCraftingCommand(config, "start", flags, { request, configPath: path }), /timed out/);
  const pending = (await readMutationState(path)).pending;
  assert.equal(pending.idempotencyKey, keys[0]);
  assert.equal(Number.isFinite(Date.parse(pending.createdAt)), true);
  await runCraftingCommand(config, "start", flags, { request, configPath: path });
  assert.equal(keys[0], keys[1]);
  assert.equal((await readMutationState(path)).pending, null);
});

test("retains the durable mutation identity after a malformed HTTP 409", async () => {
  const config = testConfig();
  const path = await configPath();
  const keys = [];
  let attempts = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    keys.push(options.headers["X-Idempotency-Key"]);
    attempts += 1;
    return attempts === 1
      ? jsonResponse({ error: { code: 409, message: { malformed: true }, retryAt: 17 } }, 409)
      : jsonResponse({ data: { craftingJobId: "job_conflict", readyAt: "2099-01-01T00:01:00.000Z" } });
  };
  const flags = { recipe: "recipe_conflict", confirm: "recipe_conflict" };
  try {
    await assert.rejects(
      runCraftingCommand(config, "start", flags, { request: agentRequest, configPath: path }),
      (error) => error.code === "HTTP_409" && error.status === 409,
    );
    assert.equal((await readMutationState(path)).pending.idempotencyKey, keys[0]);
    await runCraftingCommand(config, "start", flags, { request: agentRequest, configPath: path });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(keys[0], keys[1]);
  assert.equal((await readMutationState(path)).pending, null);
});

test("preserves a stable timeout error when native fields are read-only", async () => {
  const config = testConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  try {
    await assert.rejects(
      agentRequest(config, "GET", "/api/crafting/recipes"),
      (error) => error.name === "TimeoutError" && error.code === "ETIMEDOUT"
        && error.message === "The operation was aborted due to timeout",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fails closed on malformed success and reuses durable mutation identity", async () => {
  const config = testConfig();
  const path = await configPath();
  const keys = [];
  let attempts = 0;
  const request = async (_config, _method, _path, _body, options) => {
    keys.push(options.idempotencyKey);
    attempts += 1;
    if (attempts === 1) throw new TypeError("response lost");
    return { craftingJobId: "job_safe", readyAt: "2099-01-01T00:01:00.000Z" };
  };
  const flags = { recipe: "recipe_safe", confirm: "recipe_safe" };
  await assert.rejects(runCraftingCommand(config, "start", flags, { request, configPath: path }), /response lost/);
  const recovered = await runCraftingCommand(config, "start", flags, { request, configPath: path });
  assert.equal(recovered.craftingJobId, "job_safe");
  assert.equal(keys[0], keys[1]);
  assert.equal((await readMutationState(path)).pending, null);

  const malformedKeys = [];
  let malformedAttempts = 0;
  const malformedRequest = async (_config, _method, _path, _body, options) => {
    malformedKeys.push(options.idempotencyKey);
    malformedAttempts += 1;
    return malformedAttempts === 1 ? null : { craftingJobId: "job_valid", readyAt: "2099-01-01T00:02:00.000Z" };
  };
  const nextFlags = { recipe: "recipe_next", confirm: "recipe_next" };
  await assert.rejects(
    runCraftingCommand(config, "start", nextFlags, { request: malformedRequest, configPath: path }),
    (error) => error.code === "API_RESPONSE_INVALID",
  );
  await runCraftingCommand(config, "start", nextFlags, { request: malformedRequest, configPath: path });
  assert.equal(malformedKeys[0], malformedKeys[1]);
});

test("fails closed on malformed nested recipe and job contracts", async () => {
  const config = testConfig();
  for (const malformed of [
    { recipes: [{}] },
    { recipes: [{ id: "recipe_only" }] },
  ]) {
    await assert.rejects(
      runCraftingCommand(config, "recipes", {}, { request: async () => malformed }),
      (error) => error.code === "API_RESPONSE_INVALID",
    );
  }
  for (const malformed of [
    { jobs: [{}] },
    {
      jobs: [{
        craftingJobId: "job_1",
        recipeId: "recipe_1",
        status: "in_progress",
        startedAt: "not-a-time",
        readyAt: "",
        claimedAt: null,
        mintStatus: null,
        mintError: null,
      }],
    },
  ]) {
    await assert.rejects(
      runCraftingCommand(config, "list", {}, { requestWithMetadata: async () => ({ data: malformed }) }),
      (error) => error.code === "API_RESPONSE_INVALID",
    );
  }
  await assert.rejects(
    runCraftingCommand(
      config,
      "start",
      { recipe: "recipe_1", confirm: "recipe_1" },
      {
        configPath: await configPath(),
        request: async () => ({ craftingJobId: "job_1", readyAt: "not-a-time" }),
      },
    ),
    (error) => error.code === "API_RESPONSE_INVALID",
  );
  for (const malformedClaim of [
    { craft: { gearItemId: "gear_1", mintStatus: "complete" } },
    { craft: { gearItemId: "gear_1", mintStatus: "complete", mintAddress: "" } },
  ]) {
    await assert.rejects(
      runCraftingCommand(
        config,
        "claim",
        { job: "job_1", confirm: "job_1" },
        { configPath: await configPath(), request: async () => malformedClaim },
      ),
      (error) => error.code === "API_RESPONSE_INVALID",
    );
  }
  await assert.rejects(
    runCraftingCommand(
      config,
      "start",
      { recipe: "recipe_year", confirm: "recipe_year" },
      {
        configPath: await configPath(),
        request: async () => ({ craftingJobId: "job_year", readyAt: "2026" }),
      },
    ),
    (error) => error.code === "API_RESPONSE_INVALID",
  );
});

test("retains mutation identity until the validated receipt is written", async () => {
  const config = testConfig();
  const path = await configPath();
  const keys = [];
  let writes = 0;
  const request = async (_config, _method, _path, _body, options) => {
    keys.push(options.idempotencyKey);
    return { craftingJobId: "job_receipt", readyAt: "2099-01-01T00:01:00.000Z" };
  };
  const flags = { recipe: "recipe_receipt", confirm: "recipe_receipt" };
  const onResult = async () => {
    writes += 1;
    if (writes === 1) {
      const error = new Error("stdout closed");
      error.status = 400;
      throw error;
    }
  };
  await assert.rejects(
    runCraftingCommand(config, "start", flags, { request, configPath: path, onResult }),
    /stdout closed/,
  );
  assert.equal((await readMutationState(path)).pending.idempotencyKey, keys[0]);
  await runCraftingCommand(config, "start", flags, { request, configPath: path, onResult });
  assert.equal(keys[0], keys[1]);
  assert.equal((await readMutationState(path)).pending, null);
});

test("does not turn delivered success into failure when lock cleanup fails", async () => {
  const path = await configPath();
  const lockPath = notificationLockPath(path);
  const keys = [];
  const result = await runCraftingCommand(
    testConfig(),
    "start",
    { recipe: "recipe_release", confirm: "recipe_release" },
    {
      configPath: path,
      request: async (_config, _method, _path, _body, options) => {
        keys.push(options.idempotencyKey);
        return { craftingJobId: "job_release", readyAt: "2099-01-01T00:01:00.000Z" };
      },
      onResult: async () => {
        await unlink(lockPath);
        await mkdir(lockPath);
      },
    },
  );
  await rmdir(lockPath);
  assert.equal(result.craftingJobId, "job_release");
  assert.equal(keys.length, 1);
  assert.equal((await readMutationState(path)).pending, null);
});

test("rejects empty durable mutation identities", async () => {
  const path = await configPath();
  const createdAt = "2099-01-01T00:00:00.000Z";
  for (const pending of [
    { operation: "", idempotencyKey: "key", createdAt },
    { operation: "operation", idempotencyKey: "", createdAt },
    { operation: "operation", idempotencyKey: "key", createdAt: "not-a-time" },
  ]) {
    await writeFile(mutationStatePath(path), JSON.stringify({ version: 1, pending }), { mode: 0o600 });
    await assert.rejects(readMutationState(path), (error) => error.code === "MUTATION_STATE_INVALID");
  }
});

test("never replays a durable mutation after the server idempotency window", async () => {
  const path = await configPath();
  const recipeId = "recipe_expired";
  const operation = JSON.stringify({ method: "POST", path: "/api/crafting/request", body: { recipeId } });
  const pending = { operation, idempotencyKey: "expired-key", createdAt: "2000-01-01T00:00:00.000Z" };
  await writeFile(mutationStatePath(path), JSON.stringify({ version: 1, pending }), { mode: 0o600 });
  let requests = 0;
  await assert.rejects(
    runCraftingCommand(
      testConfig(),
      "start",
      { recipe: recipeId, confirm: recipeId },
      { configPath: path, request: async () => { requests += 1; } },
    ),
    (error) => error.code === "MUTATION_RETRY_EXPIRED",
  );
  assert.equal(requests, 0);
  assert.deepEqual((await readMutationState(path)).pending, pending);
});
