import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { base58Encode, createWallet, main, parseReferralInput, signRequest } from "./renkai.mjs";
import { pledgeWar, selectBranch, startQuest } from "./lib/primitives.mjs";

test("base58 preserves leading zero bytes", () => {
  assert.equal(base58Encode(new Uint8Array([0, 0, 1, 2])), "115T");
});

test("creates a wallet whose request signature verifies", () => {
  const wallet = createWallet();
  const signature = signRequest({ ...wallet }, "POST", "/api/player/branch", "{}");
  assert.equal(typeof signature["X-Agent-Signature"], "string");
  assert.equal(signature["X-Agent-Wallet"], wallet.walletAddress);
});

test("accepts only the official referral origin or none", () => {
  assert.deepEqual(parseReferralInput("none"), null);
  assert.deepEqual(parseReferralInput("https://app.renkai.xyz/?ref=player_123"), { referrerPlayerId: "player_123", providedAs: "link" });
  assert.throws(() => parseReferralInput("https://evil.example/?ref=player_123"));
});

test("offline setup creates a neutral config without a gameplay action", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-setup-"));
  const configPath = join(directory, "agent.json");
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(["setup", "--config", configPath, "--referral", "none", "--offline"]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(config.version, 4);
  assert.equal(config.profile, undefined);
  assert.equal(config.battle, undefined);
  assert.equal(config.automation, undefined);
  assert.equal(writes.length, 1);
});

test("explicit primitives validate confirmation and route one mutation", async () => {
  const config = { ...createWallet(), baseUrl: "https://api.example.test", agentKey: "key" };
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ path: new URL(url).pathname, body: options.body ? JSON.parse(options.body) : null });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await assert.rejects(selectBranch(config, { branch: "fighter", confirm: "wrong" }));
    await startQuest(config, { "quest-id": "quest_1", confirm: "quest_1", "idempotency-key": "id_1" });
    await pledgeWar(config, { role: "defend", confirm: "defend", "idempotency-key": "id_2" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests.map((request) => request.path), ["/api/quest/start", "/api/war/pledge"]);
  assert.deepEqual(requests[0].body, { questId: "quest_1" });
  assert.deepEqual(requests[1].body, { role: "defend" });
});
