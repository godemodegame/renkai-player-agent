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
  namedJobIds,
  parseReferralInput,
  repairAutomation,
  registrationRequestBody,
  resolveHermesScriptsDir,
  signRequest,
  uninstallAutomation,
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
      "--referral", "https://app.renkai.xyz/?ref=player_ref_123", "--offline",
    ]);
  } finally {
    process.stdout.write = originalWrite;
  }
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  const output = writes.join("");
  assert.equal(stored.profile.direction, "miner");
  assert.equal(stored.version, 3);
  assert.equal(stored.battle, null);
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

test("version 1 config migrates to optional-battle version 3", async () => {
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
  assert.equal(migrated.version, 3);
  assert.equal(migrated.battle, null);
  assert.equal(output.setupStatus, "wallet_only");
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

test("battle tick treats no policy and no pledge as a valid opt-out", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-battle-opt-out-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 3,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "miner", resources: ["common"], goal: "balanced" },
    battle: null,
    automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  const result = await battleTick(configPath, config, {
    nowMs: Date.UTC(2026, 6, 18, 7, 45),
    force: true,
    warState: {
      nextWindowId: "war_optional",
      nextWarAt: "2026-07-18T08:00:00.000Z",
      pledgeLockedAt: "2026-07-18T07:55:00.000Z",
      policy: null,
      pledge: null,
    },
  });
  assert.deepEqual(result, {
    action: "no_battle_instruction",
    windowId: "war_optional",
    pledge: null,
    nextWarAt: "2026-07-18T08:00:00.000Z",
  });
});

test("battle-next creates and clears only a one-window pledge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-battle-next-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 3,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "miner", resources: ["common"], goal: "balanced" },
    battle: null,
    automation: { runtime: null, jobId: null, lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config));
  const requests = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ method: options.method ?? "GET", path, body: options.body ? JSON.parse(String(options.body)) : null });
    const data = path === "/api/war/state"
      ? { nextWindowId: "war_next", nextWarAt: "2026-07-18T08:00:00.000Z", pledgeLockedAt: "2026-07-18T07:55:00.000Z", policy: null, pledge: null }
      : path === "/api/player/state"
        ? { player: { castleId: "ashkeep" } }
        : { pledge: null, policy: null };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await main(["battle-next", "set", "--mode", "attack-cycle", "--config", configPath]);
    await main(["battle-next", "clear", "--config", configPath]);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
  const pledge = requests.find((request) => request.method === "POST" && request.path === "/api/war/pledge");
  assert.equal(pledge.body.role, "attack");
  assert.notEqual(pledge.body.targetCastleId, "ashkeep");
  assert.equal(requests.some((request) => request.method === "DELETE" && request.path === "/api/war/pledge"), true);
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(stored.battle, null);
  assert.equal(stored.automation.jobId, null);
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

test("explicit all-battles scheduler pledges three consecutive wars and uses a changed policy next", async () => {
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
    let jobs = [];
    const renderJobs = () => runtime === "hermes"
      ? jobs.map((job) => `  ${job.id} enabled\n    Name:      ${job.name}\n    Schedule:  every 1m`).join("\n\n")
      : JSON.stringify({ jobs });
    const runner = (binary, args) => {
      calls.push({ binary, args });
      if (args[0] === "cron" && args[1] === "list") return { stdout: renderJobs() };
      if (args[0] === "cron" && args[1] === "remove") {
        jobs = jobs.filter((job) => job.id !== args[2]);
        return { stdout: "removed" };
      }
      if (args[0] === "cron" && args[1] === "create") {
        const id = runtime === "hermes" ? "a1b2c3d4e5f6" : "openclaw12345678";
        jobs.push({ id, name: "renkai-all-battles" });
        return { stdout: JSON.stringify({ id }) };
      }
      return { stdout: "ok" };
    };
    const flags = runtime === "hermes"
      ? { "notify-channel": "origin" }
      : { "notify-channel": "telegram", "notify-to": "123" };
    const options = {
      runner,
      hermesScriptsDir: join(directory, "scripts"),
      request: async () => ({ policy: { mode: "defend", targetCastleId: null, updatedAt: "2026-07-18T00:00:00.000Z" } }),
    };
    const first = await installAutomation(configPath, config, runtime, flags, options);
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
    const repeated = await installAutomation(configPath, config, runtime, flags, options);
    assert.equal(repeated.existing, true);
    assert.equal(calls.filter((call) => call.args[1] === "create").length, before);
    assert.equal((await automationStatus(config, { runner })).installed, true);
    const repaired = await repairAutomation(configPath, config, runtime, flags, options);
    assert.equal(repaired.testRun, "passed");
    assert.equal(calls.some((call) => call.args[1] === "remove"), true);
    assert.equal(calls.filter((call) => call.args[1] === "create").length, before + 1);
  }
});

test("Hermes Docker scripts directory honors HERMES_HOME and survives missing Gateway env", () => {
  assert.equal(resolveHermesScriptsDir({ env: { HERMES_HOME: "/srv/hermes" }, pathExists: () => false }), "/srv/hermes/scripts");
  assert.equal(resolveHermesScriptsDir({ env: {}, pathExists: (path) => path === "/opt/data" }), "/opt/data/scripts");
  assert.equal(resolveHermesScriptsDir({ env: {}, pathExists: () => false, homeDir: "/home/player" }), "/home/player/.hermes/scripts");
});

test("Hermes job parser finds every exact duplicate ID without touching other jobs", () => {
  const output = [
    "  8dbaa619c480 enabled\n    Name:      renkai-mandatory-battles\n    Schedule:  every 1m",
    "  d7dcda121c84 enabled\n    Name:      renkai-mandatory-battles\n    Schedule:  every 1m",
    "  e81c471fbf75 enabled\n    Name:      renkai-quests-step\n    Schedule:  every 1m",
    "  deadbeef1234 enabled\n    Name:      unrelated\n    Schedule:  every 1m",
  ].join("\n\n");
  assert.deepEqual(namedJobIds(output, "renkai-mandatory-battles"), ["8dbaa619c480", "d7dcda121c84"]);
  assert.deepEqual(namedJobIds(output, "renkai-quests-step"), ["e81c471fbf75"]);
});

test("Hermes install repairs duplicate battle jobs, removes legacy quest jobs, and writes the Gateway wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-hermes-repair-test-"));
  const configPath = join(directory, "agent.json");
  const scriptsDir = join(directory, "opt-data", "scripts");
  const config = {
    version: 2,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "defender", resources: ["common"], goal: "balanced" },
    battle: { mode: "defend", targetCastleId: null },
    automation: { runtime: "hermes", jobId: "8dbaa619c480", lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config));
  let jobs = [
    { id: "8dbaa619c480", name: "renkai-mandatory-battles" },
    { id: "d7dcda121c84", name: "renkai-mandatory-battles" },
    { id: "e81c471fbf75", name: "renkai-quests-step" },
    { id: "0556ebf1ded1", name: "renkai-quests-step" },
  ];
  const removed = [];
  const runner = (_binary, args) => {
    if (args[0] === "cron" && args[1] === "list") {
      return { stdout: jobs.map((job) => `  ${job.id} enabled\n    Name:      ${job.name}`).join("\n\n") };
    }
    if (args[0] === "cron" && args[1] === "remove") {
      removed.push(args[2]);
      jobs = jobs.filter((job) => job.id !== args[2]);
      return { stdout: "removed" };
    }
    if (args[0] === "cron" && args[1] === "create") {
      jobs.push({ id: "abc123def456", name: "renkai-all-battles" });
      return { stdout: JSON.stringify({ id: "abc123def456" }) };
    }
    return { stdout: "ok" };
  };
  const result = await installAutomation(configPath, config, "hermes", { "notify-channel": "origin" }, {
    runner,
    hermesScriptsDir: scriptsDir,
    request: async () => ({ policy: { mode: "defend", targetCastleId: null, updatedAt: "2026-07-18T00:00:00.000Z" } }),
  });
  assert.deepEqual(new Set(removed), new Set(["8dbaa619c480", "d7dcda121c84", "e81c471fbf75", "0556ebf1ded1"]));
  assert.deepEqual(jobs, [{ id: "abc123def456", name: "renkai-all-battles" }]);
  assert.equal(result.scriptPath, join(scriptsDir, "renkai-all-battles.sh"));
  assert.match(await readFile(result.scriptPath, "utf8"), /battle-tick --quiet/);
});

test("automation creates no cron job until the server confirms battle policy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-policy-guard-test-"));
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
  const calls = [];
  await assert.rejects(
    installAutomation(configPath, config, "hermes", { "notify-channel": "origin" }, {
      runner: (binary, args) => { calls.push({ binary, args }); return { stdout: "" }; },
      request: async () => ({ policy: null }),
    }),
    { code: "NO_BATTLE_INSTRUCTION" },
  );
  assert.deepEqual(calls, []);
});

test("automation uninstall removes optional battle and obsolete quest jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-uninstall-test-"));
  const configPath = join(directory, "agent.json");
  const config = {
    version: 3,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "secret",
    profile: { direction: "defender", resources: ["common"], goal: "balanced" },
    battle: null,
    automation: { runtime: "hermes", jobId: "8dbaa619c480", scriptPath: "/opt/data/scripts/renkai-mandatory-battles.sh", lastRunAt: null, lastPledgedWindowId: null, lastAlertedWindowId: null, notification: null },
  };
  await writeFile(configPath, JSON.stringify(config));
  const jobs = [
    { id: "8dbaa619c480", name: "renkai-mandatory-battles" },
    { id: "0556ebf1ded1", name: "renkai-quests-step" },
  ];
  const removed = [];
  const runner = (_binary, args) => {
    if (args[1] === "list") return { stdout: jobs.map((job) => `  ${job.id} enabled\n    Name:      ${job.name}`).join("\n\n") };
    if (args[1] === "remove") removed.push(args[2]);
    return { stdout: "ok" };
  };
  const result = await uninstallAutomation(configPath, config, "hermes", { runner });
  assert.deepEqual(new Set(result.removedJobIds), new Set(["8dbaa619c480", "0556ebf1ded1"]));
  assert.deepEqual(new Set(removed), new Set(["8dbaa619c480", "0556ebf1ded1"]));
  assert.equal(config.automation.runtime, null);
  assert.equal(config.automation.jobId, null);
});
