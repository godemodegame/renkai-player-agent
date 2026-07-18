import assert from "node:assert/strict";
import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  automationStatus,
  base58Encode,
  battleTick,
  battleWindowContext,
  buildSignatureMessage,
  chooseQuestArchetype,
  cliErrorOutput,
  createWallet,
  cycleTarget,
  installAutomation,
  main,
  parseReferralInput,
  repairAutomation,
  registrationRequestBody,
  signRequest,
} from "./renkai.mjs";

function base58Decode(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    assert.notEqual(digit, -1);
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number % 256n));
    number /= 256n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

test("base58 encodes leading zeroes and known bytes", () => {
  assert.equal(base58Encode(Uint8Array.from([])), "");
  assert.equal(base58Encode(Uint8Array.from([0])), "1");
  assert.equal(base58Encode(Uint8Array.from([0, 0, 1])), "112");
});

test("creates a Solana-sized Ed25519 address and valid signatures", () => {
  const wallet = createWallet();
  assert.match(wallet.walletAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  const config = { ...wallet };
  const headers = signRequest(config, "POST", "/api/quest/start", '{"questId":"q1"}');
  const message = buildSignatureMessage(
    "POST",
    "/api/quest/start",
    '{"questId":"q1"}',
    headers["X-Agent-Timestamp"],
    headers["X-Agent-Nonce"],
  );
  const privateKey = createPrivateKey({ key: Buffer.from(wallet.privateKeyPkcs8, "base64"), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  assert.equal(verify(null, Buffer.from(message), publicKey, base58Decode(headers["X-Agent-Signature"])), true);
  assert.equal(verify(null, Buffer.from(message), publicKey, sign(null, Buffer.from(message), privateKey)), true);
});

test("maps resource focus to quest archetypes", () => {
  assert.equal(chooseQuestArchetype({ resources: ["iron"] }), "gathering");
  assert.equal(chooseQuestArchetype({ resources: ["rune_dust"] }), "forbidden_expedition");
  assert.equal(chooseQuestArchetype({ resources: ["relic_fragment"] }), "scouting");
  assert.equal(chooseQuestArchetype({ resources: [], goal: "xp" }), "forbidden_expedition");
});

test("offline setup creates a private reusable config without printing secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-skill-test-"));
  const configPath = join(directory, "agent.json");
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await main([
      "setup", "--config", configPath, "--direction", "miner", "--resources", "iron,coal",
      "--battle-mode", "defend", "--referral", "https://app.renkai.xyz/?ref=player_ref_123", "--offline",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  const output = writes.join("");
  assert.equal(stored.profile.direction, "miner");
  assert.equal(stored.version, 2);
  assert.equal(stored.battle.mode, "defend");
  assert.deepEqual(stored.referral, { referrerPlayerId: "player_ref_123", providedAs: "link" });
  assert.ok(stored.privateKeyPkcs8);
  assert.equal(output.includes(stored.privateKeyPkcs8), false);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("accepts only app.renkai.xyz referral links or an explicit no-referrer choice", () => {
  assert.deepEqual(parseReferralInput("https://app.renkai.xyz/start?ref=player_abc-123&utm_source=agent"), {
    referrerPlayerId: "player_abc-123",
    providedAs: "link",
  });
  assert.equal(parseReferralInput("none"), null);
  assert.throws(() => parseReferralInput("player_abc-123"), /app\.renkai\.xyz/);
  assert.throws(() => parseReferralInput("https://app.renkai.xyz/start"), /no ref query parameter/);
  assert.throws(() => parseReferralInput("http://app.renkai.xyz/?ref=player_abc"), /Only referral links/);
  assert.throws(() => parseReferralInput("https://sub.app.renkai.xyz/?ref=player_abc"), /Only referral links/);
  assert.throws(() => parseReferralInput("https://app.renkai.xyz:444/?ref=player_abc"), /Only referral links/);
  assert.throws(() => parseReferralInput(undefined), /--referral is required/);
  assert.throws(() => parseReferralInput("https://waitlist.renkai.xyz/?ref=opaque-code"), /Only referral links/);
  const walletOnly = { referral: parseReferralInput("https://app.renkai.xyz/?ref=player_ref_123") };
  assert.deepEqual(registrationRequestBody(walletOnly), {
    action: "create",
    label: "renkai-player",
    referrerPlayerId: "player_ref_123",
  });
  assert.deepEqual(registrationRequestBody({ ...walletOnly, agentKey: "already-registered" }), {
    action: "rotate",
    label: "renkai-player",
  });
});

test("waitlist denial exposes the public agent wallet and official access links only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-waitlist-test-"));
  const configPath = join(directory, "agent.json");
  const wallet = createWallet();
  const config = {
    version: 2,
    ...wallet,
    baseUrl: "https://api.renkai.xyz",
    profile: { direction: "miner", resources: ["iron"], goal: "resources" },
    battle: { mode: "defend", targetCastleId: null },
    referral: null,
    automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: "FORBIDDEN", message: "This wallet has not been granted game access." },
  }), { status: 403, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(main(["register", "--config", configPath]), (error) => {
      const output = cliErrorOutput(error);
      assert.equal(output.error.code, "WAITLIST_REQUIRED");
      assert.deepEqual(output.waitlist, {
        walletAddress: wallet.walletAddress,
        discord: "https://discord.gg/fGVDhhk9t",
        x: "https://x.com/renkaigame",
      });
      const serialized = JSON.stringify(output);
      assert.equal(serialized.includes(wallet.privateKeyPkcs8), false);
      assert.equal(serialized.includes("agentKey"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("version 1 config migrates to version 2 and requires battle setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-v1-test-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify({
    version: 1,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    profile: { direction: "miner", resources: ["iron"], goal: "resources" },
  }), { mode: 0o600 });
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await main(["profile", "--config", configPath]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const migrated = JSON.parse(await readFile(configPath, "utf8"));
  const output = JSON.parse(writes.join(""));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.battle, null);
  assert.equal(output.setupStatus, "battle_setup_required");
});

test("battle tick performs no network request outside the local 20-minute reserve", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-battle-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 2,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "defender", resources: ["common"], goal: "balanced" },
    battle: { mode: "defend", targetCastleId: null },
    automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  let calls = 0;
  const context = battleWindowContext(Date.UTC(2026, 6, 18, 7, 0));
  assert.equal(context.inReserve, false);
  const result = await battleTick(configPath, config, {
    nowMs: Date.UTC(2026, 6, 18, 7, 0),
    request: async () => { calls += 1; throw new Error("must not run"); },
  });
  assert.equal(result.action, "outside_reserve");
  assert.equal(calls, 0);
});

test("attack cycle is deterministic and advances with stable eight-hour slots", () => {
  const first = cycleTarget("ashkeep", "2026-07-18T08:00:00.000Z");
  assert.equal(cycleTarget("ashkeep", "2026-07-18T08:00:00.000Z"), first);
  const sequence = [0, 1, 2, 3].map((index) => cycleTarget("ashkeep", new Date(Date.UTC(2026, 6, 18, 8) + index * 8 * 60 * 60 * 1000).toISOString()));
  assert.equal(new Set(sequence).size, 4);
  assert.equal(sequence.includes("ashkeep"), false);
});

test("battle tick pledges during reserve and emits only one missed-window error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-battle-window-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 2,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "attacker", resources: ["rare"], goal: "balanced" },
    battle: { mode: "attack_cycle", targetCastleId: null },
    automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config));
  const scheduledAt = "2026-07-18T08:00:00.000Z";
  const warState = {
    nextWindowId: "war_test",
    nextWarAt: scheduledAt,
    pledgeLockedAt: "2026-07-18T07:55:00.000Z",
    policy: { mode: "attack_cycle", targetCastleId: null },
    pledge: null,
  };
  const requests = [];
  const pledged = await battleTick(configPath, config, {
    nowMs: Date.UTC(2026, 6, 18, 7, 45),
    force: true,
    warState,
    request: async (_config, method, path, body) => {
      requests.push({ method, path, body });
      if (path === "/api/player/state") return { player: { castleId: "ashkeep" } };
      return {};
    },
  });
  assert.equal(pledged.action, "pledged");
  assert.equal(requests.some((request) => request.path === "/api/war/pledge"), true);

  const missedConfig = { ...config, automation: { ...config.automation, lastAlertedWindowId: null } };
  await writeFile(configPath, JSON.stringify(missedConfig));
  const failing = async () => { throw Object.assign(new Error("offline"), { code: "NETWORK" }); };
  await assert.rejects(
    battleTick(configPath, missedConfig, { nowMs: Date.UTC(2026, 6, 18, 7, 56), force: true, warState, request: failing }),
    { code: "BATTLE_PLEDGE_MISSED" },
  );
  const second = await battleTick(configPath, missedConfig, {
    nowMs: Date.UTC(2026, 6, 18, 7, 57), force: true, warState, request: failing,
  });
  assert.equal(second.action, "already_alerted");

  const offlineConfig = { ...config, automation: { ...config.automation, lastAlertedWindowId: null } };
  await writeFile(configPath, JSON.stringify(offlineConfig));
  await assert.rejects(
    battleTick(configPath, offlineConfig, { nowMs: Date.UTC(2026, 6, 18, 7, 56), request: failing }),
    { code: "BATTLE_PLEDGE_MISSED" },
  );
  const suppressedOffline = await battleTick(configPath, offlineConfig, {
    nowMs: Date.UTC(2026, 6, 18, 7, 57), request: failing,
  });
  assert.equal(suppressedOffline.action, "already_alerted");
});

test("onboarded scheduler pledges three consecutive wars and uses a changed policy next", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-three-wars-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 2,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "attacker", resources: ["rare"], goal: "balanced" },
    battle: { mode: "attack_cycle", targetCastleId: null },
    automation: { runtime: "openclaw", jobId: "job", lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: { channel: "telegram", recipient: "123" } },
  };
  await writeFile(configPath, JSON.stringify(config));
  const pledges = [];
  const request = async (_config, method, path, body) => {
    if (path === "/api/player/state") return { player: { castleId: "ashkeep" } };
    if (method === "POST" && path === "/api/war/pledge") pledges.push(body);
    return {};
  };
  const firstWarMs = Date.UTC(2026, 6, 18, 8);
  for (let index = 0; index < 3; index += 1) {
    const nextWarAt = new Date(firstWarMs + index * 8 * 60 * 60 * 1000).toISOString();
    const result = await battleTick(configPath, config, {
      nowMs: Date.parse(nextWarAt) - 15 * 60 * 1000,
      force: true,
      warState: {
        nextWindowId: `war_${index}`,
        nextWarAt,
        pledgeLockedAt: new Date(Date.parse(nextWarAt) - 5 * 60 * 1000).toISOString(),
        policy: { mode: "attack_cycle", targetCastleId: null },
        pledge: null,
      },
      request,
    });
    assert.equal(result.action, "pledged");
  }
  assert.equal(pledges.length, 3);
  assert.equal(new Set(pledges.map((pledge) => pledge.targetCastleId)).size, 3);

  const fourthWarAt = new Date(firstWarMs + 3 * 8 * 60 * 60 * 1000).toISOString();
  await battleTick(configPath, config, {
    nowMs: Date.parse(fourthWarAt) - 15 * 60 * 1000,
    force: true,
    warState: {
      nextWindowId: "war_3",
      nextWarAt: fourthWarAt,
      pledgeLockedAt: new Date(Date.parse(fourthWarAt) - 5 * 60 * 1000).toISOString(),
      policy: { mode: "defend", targetCastleId: null },
      pledge: null,
    },
    request,
  });
  assert.deepEqual(pledges[3], { role: "defend", targetCastleId: "ashkeep" });
});

test("Hermes and OpenClaw adapters install exact script-only jobs without duplicates", async () => {
  for (const runtime of ["hermes", "openclaw"]) {
    const directory = await mkdtemp(join(tmpdir(), `renkai-${runtime}-test-`));
    const configPath = join(directory, "agent.json");
    const config = {
      version: 2,
      ...createWallet(),
      baseUrl: "https://example.invalid",
      agentKey: "secret",
      profile: { direction: "defender", resources: ["common"], goal: "balanced" },
      battle: { mode: "defend", targetCastleId: null },
      automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
    };
    await writeFile(configPath, JSON.stringify(config));
    const calls = [];
    let installed = false;
    const runner = (binary, args) => {
      calls.push({ binary, args });
      if (args[0] === "cron" && args[1] === "list") return { stdout: installed ? `job ${runtime} renkai-mandatory-battles` : "" };
      if (args[0] === "cron" && args[1] === "remove") {
        installed = false;
        return { stdout: "removed" };
      }
      if (args[0] === "cron" && args[1] === "create") {
        installed = true;
        return { stdout: JSON.stringify({ id: `${runtime}12345678` }) };
      }
      return { stdout: "ok" };
    };
    const flags = runtime === "hermes"
      ? { "notify-channel": "origin" }
      : { "notify-channel": "telegram", "notify-to": "123" };
    const first = await installAutomation(configPath, config, runtime, flags, { runner, hermesScriptsDir: join(directory, "scripts") });
    assert.equal(first.testRun, "passed");
    const createCall = calls.find((call) => call.args[1] === "create");
    if (runtime === "hermes") {
      assert.equal(createCall.args.includes("--no-agent"), true);
      assert.equal(createCall.args.includes("--script"), true);
    } else {
      const argv = JSON.parse(createCall.args[createCall.args.indexOf("--command-argv") + 1]);
      assert.deepEqual(argv.slice(-4), ["battle-tick", "--quiet", "--config", configPath]);
      assert.equal(createCall.args.includes("--exact"), true);
    }
    const before = calls.filter((call) => call.args[1] === "create").length;
    const repeated = await installAutomation(configPath, config, runtime, flags, { runner, hermesScriptsDir: join(directory, "scripts") });
    assert.equal(repeated.existing, true);
    assert.equal(calls.filter((call) => call.args[1] === "create").length, before);
    assert.equal((await automationStatus(config, { runner })).installed, true);
    const repaired = await repairAutomation(configPath, config, runtime, flags, { runner, hermesScriptsDir: join(directory, "scripts") });
    assert.equal(repaired.testRun, "passed");
    assert.equal(calls.some((call) => call.args[1] === "remove"), true);
    assert.equal(calls.filter((call) => call.args[1] === "create").length, before + 1);
  }
});
