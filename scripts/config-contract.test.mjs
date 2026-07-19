import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cliErrorOutput, createWallet, main } from "./renkai.mjs";

async function temporaryDirectory(prefix = "renkai-config-contract-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function configFixture(overrides = {}) {
  const wallet = createWallet();
  return {
    version: 2,
    ...wallet,
    baseUrl: "https://api.example.test",
    agentKey: "api-key-for-contract-test",
    profile: { direction: "miner", resources: ["iron", "coal"], goal: "resources" },
    battle: { mode: "attack_cycle", targetCastleId: null, updatedAt: "2026-07-18T00:00:00.000Z" },
    referral: { referrerPlayerId: "player_ref_123", providedAs: "link" },
    automation: {
      runtime: "hermes",
      jobId: "job-contract-test",
      scriptPath: "/tmp/renkai-contract.sh",
      lastRunAt: "2026-07-18T01:02:03.000Z",
      lastPledgedWindowId: "war_contract",
      lastAlertedWindowId: null,
      notification: "origin",
    },
    createdAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:00:00.000Z",
    ...overrides,
  };
}

async function writeFixture(configPath, config, mode = 0o600) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config), { mode });
}

async function captureMain(argv) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const result = await main(argv);
    return { result, text: chunks.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function assertPrettyDocument(text) {
  assert.match(text, /^\{\n[\s\S]*\n\}\n$/);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.equal(text.trim().startsWith("{") && text.trim().endsWith("}"), true);
}

async function assertNoTempResidue(directory) {
  const entries = await readdir(directory);
  assert.deepEqual(entries.filter((entry) => entry.endsWith(".tmp")), []);
}

test("uses explicit config, then RENKAI_CONFIG, then the XDG default", async () => {
  const directory = await temporaryDirectory("renkai-config-path-");
  const explicitPath = join(directory, "explicit.json");
  const environmentPath = join(directory, "environment.json");
  const defaultPath = join(directory, "xdg", "renkai", "agent.json");
  await writeFixture(explicitPath, configFixture({ profile: { direction: "attacker", resources: ["rare"], goal: "xp" } }));
  await writeFixture(environmentPath, configFixture({ profile: { direction: "defender", resources: ["stone"], goal: "balanced" } }));
  await writeFixture(defaultPath, configFixture({ profile: { direction: "blacksmith", resources: ["wood"], goal: "gold" } }));

  await withEnvironment({ RENKAI_CONFIG: environmentPath, XDG_CONFIG_HOME: join(directory, "xdg") }, async () => {
    const explicit = await captureMain(["profile", "--config", explicitPath]);
    assert.equal(JSON.parse(explicit.text).direction, "attacker");

    const fromEnvironment = await captureMain(["profile"]);
    assert.equal(JSON.parse(fromEnvironment.text).direction, "defender");
  });

  await withEnvironment({ RENKAI_CONFIG: undefined, XDG_CONFIG_HOME: join(directory, "xdg") }, async () => {
    const fromDefault = await captureMain(["profile"]);
    assert.equal(JSON.parse(fromDefault.text).direction, "blacksmith");
  });
});

test("keeps version-three config complete private and mode-600", async () => {
  const directory = await temporaryDirectory();
  const configPath = join(directory, "agent.json");
  const original = configFixture();
  await writeFixture(configPath, original, 0o644);

  const migratedOutput = await captureMain(["profile", "--config", configPath]);
  await assertPrettyDocument(migratedOutput.text);
  const migrated = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.walletAddress, original.walletAddress);
  assert.equal(migrated.privateKeyPkcs8, original.privateKeyPkcs8);
  assert.equal(migrated.agentKey, original.agentKey);
  assert.deepEqual(migrated.profile, original.profile);
  assert.deepEqual(migrated.battle, original.battle);
  assert.deepEqual(migrated.automation, original.automation);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal(migratedOutput.text.includes(original.privateKeyPkcs8), false);
  assert.equal(migratedOutput.text.includes(original.agentKey), false);
  await assertNoTempResidue(directory);

  const firstUpdate = await captureMain([
    "setup", "--config", configPath, "--direction", "miner", "--resources", "iron,coal",
    "--goal", "resources", "--referral", "https://app.renkai.xyz/?ref=player_ref_123", "--offline",
  ]);
  await assertPrettyDocument(firstUpdate.text);
  const afterFirstUpdate = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(afterFirstUpdate.version, 3);
  assert.equal(afterFirstUpdate.walletAddress, original.walletAddress);
  assert.equal(afterFirstUpdate.privateKeyPkcs8, original.privateKeyPkcs8);
  assert.equal(afterFirstUpdate.agentKey, original.agentKey);
  assert.deepEqual(afterFirstUpdate.battle, original.battle);
  assert.deepEqual(afterFirstUpdate.automation, original.automation);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await assertNoTempResidue(directory);

  const secondUpdate = await captureMain([
    "setup", "--config", configPath, "--direction", "miner", "--resources", "iron,coal",
    "--goal", "resources", "--referral", "https://app.renkai.xyz/?ref=player_ref_123", "--offline",
  ]);
  await assertPrettyDocument(secondUpdate.text);
  const afterSecondUpdate = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(afterSecondUpdate.version, 3);
  assert.equal(afterSecondUpdate.walletAddress, original.walletAddress);
  assert.equal(afterSecondUpdate.privateKeyPkcs8, original.privateKeyPkcs8);
  assert.equal(afterSecondUpdate.agentKey, original.agentKey);
  assert.deepEqual(afterSecondUpdate.profile, afterFirstUpdate.profile);
  assert.deepEqual(afterSecondUpdate.battle, original.battle);
  assert.deepEqual(afterSecondUpdate.automation, original.automation);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await assertNoTempResidue(directory);
});

test("repairs permissions on an already-current version-three config", async () => {
  const directory = await temporaryDirectory("renkai-config-current-mode-");
  const configPath = join(directory, "agent.json");
  const current = configFixture({ version: 3 });
  await writeFixture(configPath, current, 0o644);
  const profile = await captureMain(["profile", "--config", configPath]);
  assert.equal(JSON.parse(profile.text).walletAddress, current.walletAddress);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
});

test("migrates a v1 config to version 3 with optional battle and complete automation", async () => {
  const directory = await temporaryDirectory("renkai-config-v1-");
  const configPath = join(directory, "agent.json");
  const original = configFixture({ version: 1, battle: undefined, automation: undefined });
  delete original.battle;
  delete original.automation;
  await writeFixture(configPath, original);

  const { text } = await captureMain(["profile", "--config", configPath]);
  await assertPrettyDocument(text);
  const migrated = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal(migrated.walletAddress, original.walletAddress);
  assert.equal(migrated.privateKeyPkcs8, original.privateKeyPkcs8);
  assert.equal(migrated.agentKey, original.agentKey);
  assert.deepEqual(migrated.profile, original.profile);
  assert.equal(migrated.battle, null);
  assert.deepEqual(migrated.automation, {
    runtime: null,
    jobId: null,
    scriptPath: null,
    lastRunAt: null,
    lastPledgedWindowId: null,
    lastAlertedWindowId: null,
    notification: null,
  });
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  await assertNoTempResidue(directory);
});

test("does not replace malformed config while reporting a safe error", async () => {
  const directory = await temporaryDirectory("renkai-config-error-");
  const configPath = join(directory, "agent.json");
  const malformed = '{"version":3,"walletAddress":"not-complete"';
  await writeFile(configPath, malformed, { mode: 0o600 });

  await assert.rejects(main(["profile", "--config", configPath]), (error) => {
    const output = cliErrorOutput(error);
    const serialized = JSON.stringify(output);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "CLIENT_ERROR");
    assert.equal(serialized.includes("privateKeyPkcs8"), false);
    assert.equal(serialized.includes("agentKey"), false);
    return true;
  });
  assert.equal(await readFile(configPath, "utf8"), malformed);
  await assertNoTempResidue(directory);
});

test("keeps private and API keys out of stdout and serialized CLI errors", async () => {
  const directory = await temporaryDirectory("renkai-config-secrets-");
  const configPath = join(directory, "agent.json");
  const config = configFixture();
  await writeFixture(configPath, config);

  const profile = await captureMain(["profile", "--config", configPath]);
  assert.equal(profile.text.includes(config.privateKeyPkcs8), false);
  assert.equal(profile.text.includes(config.agentKey), false);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { code: "FORBIDDEN", message: "This wallet has not been granted game access." },
  }), { status: 403, headers: { "Content-Type": "application/json" } });
  try {
    await assert.rejects(main(["register", "--config", configPath]), (error) => {
      const serialized = JSON.stringify(cliErrorOutput(error));
      assert.equal(serialized.includes(config.privateKeyPkcs8), false);
      assert.equal(serialized.includes(config.agentKey), false);
      assert.equal(serialized.includes("privateKeyPkcs8"), false);
      assert.equal(serialized.includes("agentKey"), false);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
