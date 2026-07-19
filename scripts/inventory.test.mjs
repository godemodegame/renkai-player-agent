import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey, verify } from "node:crypto";
import test from "node:test";
import {
  buildSignatureMessage,
  createWallet,
} from "./lib/api.mjs";
import {
  handleInventory,
  inventoryPath,
  readInventory,
} from "./lib/inventory.mjs";

function testConfig() {
  return {
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "inventory-agent-key",
  };
}

function inventoryPayload() {
  return {
    observedAt: "2026-07-19T12:00:00.000Z",
    resources: {
      items: [
        { resourceId: "iron", category: "common", amount: 12 },
        { resourceId: "unknown_resource", category: "unlisted", amount: 0 },
      ],
      totalCount: 2,
    },
    gear: {
      items: [
        {
          id: "gear_equipped",
          recipeId: "recipe_template_01",
          name: "Equipped Blade",
          slot: "weapon",
          tier: "T1",
          requiredBranch: "fighter",
          bonuses: { strength: 3 },
          durability: 41,
          attuned: true,
          isEquipped: true,
          power: 8,
          mintAddress: "mint_equipped",
          state: "equipped",
        },
        {
          id: "gear_attuned",
          recipeId: "recipe_template_02",
          name: "Attuned Helm",
          slot: "helm",
          tier: "T2",
          requiredBranch: null,
          bonuses: { defence: 4 },
          durability: 100,
          attuned: true,
          isEquipped: false,
          power: 6,
          mintAddress: null,
          state: "attuned",
        },
        {
          id: "gear_durable",
          recipeId: "recipe_template_03",
          name: "Durable Chest",
          slot: "chest",
          tier: "T3",
          requiredBranch: "laborer",
          bonuses: {},
          durability: 99,
          attuned: false,
          isEquipped: false,
          power: 11,
          mintAddress: null,
          state: "owned",
        },
        {
          id: "gear_pending",
          recipeId: "recipe_template_pending",
          name: null,
          slot: "weapon",
          tier: "T1",
          requiredBranch: null,
          bonuses: {},
          durability: 0,
          attuned: false,
          isEquipped: false,
          power: 0,
          mintAddress: null,
          state: "mint_pending",
        },
      ],
      nextCursor: "gear_cursor_next",
    },
    weight: {
      system: "castle_population",
      activeWeight: 7.5,
      capacityWeight: null,
    },
  };
}

function jsonResponse(data) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("reads the authoritative aggregate with no flags and preserves the exact payload", async () => {
  const config = testConfig();
  const payload = inventoryPayload();
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    return payload;
  };

  const result = await readInventory(config, {}, { request });

  assert.strictEqual(result, payload);
  assert.deepEqual(calls, [[config, "GET", "/api/inventory"]]);
  assert.equal(calls.some(([, method]) => method !== "GET"), false);
  assert.deepEqual(result.weight, payload.weight);
  assert.equal(result.gear.nextCursor, "gear_cursor_next");
});

test("bounds limit at 100, passes an opaque cursor, and signs the exact path", async () => {
  const config = testConfig();
  const payload = inventoryPayload();
  const path = inventoryPath({ limit: 100, cursor: "opaque_cursor-01" });
  assert.equal(path, "/api/inventory?limit=100&cursor=opaque_cursor-01");

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return jsonResponse(payload);
  };
  try {
    const result = await readInventory(config, { limit: "100", cursor: "opaque_cursor-01" });
    assert.deepEqual(result, payload);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(new URL(call.url).pathname + new URL(call.url).search, path);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.body, undefined);
  const headers = call.options.headers;
  const privateKey = createPrivateKey({ key: Buffer.from(config.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const message = buildSignatureMessage("GET", path, "", headers["X-Agent-Timestamp"], headers["X-Agent-Nonce"]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let signatureNumber = 0n;
  for (const character of headers["X-Agent-Signature"]) signatureNumber = signatureNumber * 58n + BigInt(alphabet.indexOf(character));
  const signatureBytes = [];
  while (signatureNumber > 0n) {
    signatureBytes.unshift(Number(signatureNumber % 256n));
    signatureNumber /= 256n;
  }
  assert.equal(verify(null, Buffer.from(message), publicKey, Buffer.from(signatureBytes)), true);
});

test("passes through empty inventory, states, recipe IDs, pagination, and weight parity", async () => {
  const empty = {
    observedAt: "2026-07-19T13:00:00.000Z",
    resources: { items: [], totalCount: 0 },
    gear: { items: [], nextCursor: null },
    weight: { system: "castle_population", activeWeight: 0, capacityWeight: null },
  };
  const result = await readInventory({}, { limit: 1 }, { request: async () => empty });
  assert.strictEqual(result, empty);
  assert.deepEqual(result, empty);
  const full = inventoryPayload();
  const passthrough = await handleInventory({}, { cursor: "opaque" }, { request: async () => full });
  assert.strictEqual(passthrough, full);
  assert.equal(passthrough.gear.items[0].state, "equipped");
  assert.equal(passthrough.gear.items[1].state, "attuned");
  assert.equal(passthrough.gear.items[2].durability, 99);
  assert.equal(passthrough.gear.items[3].state, "mint_pending");
  assert.equal(passthrough.gear.items[0].recipeId, "recipe_template_01");
  assert.equal(passthrough.weight.activeWeight, 7.5);
  assert.equal(passthrough.weight.capacityWeight, null);
});

test("rejects invalid limits and cursors before signing or requesting", async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    return {};
  };
  for (const limit of [0, 101, "1.5", "abc", "", true]) {
    await assert.rejects(
      readInventory({}, { limit }, { request }),
      /--limit must be an integer from 1 to 100\./,
    );
  }
  for (const cursor of ["", "x".repeat(129), 12, true]) {
    await assert.rejects(
      readInventory({}, { cursor }, { request }),
      /--cursor must be a non-empty opaque value no longer than 128 characters\./,
    );
  }
  assert.equal(calls, 0);
});

test("prints one unchanged structured payload and never mutates", async () => {
  const config = testConfig();
  const payload = inventoryPayload();
  const before = structuredClone(config);
  const printed = [];
  const methods = [];
  const result = await handleInventory(config, { limit: 2 }, {
    request: async (_config, method, path) => {
      methods.push({ method, path });
      return payload;
    },
    print: (value) => printed.push(value),
  });
  assert.strictEqual(result, payload);
  assert.deepEqual(printed, [payload]);
  assert.deepEqual(methods, [{ method: "GET", path: "/api/inventory?limit=2" }]);
  assert.deepEqual(config, before);
});
