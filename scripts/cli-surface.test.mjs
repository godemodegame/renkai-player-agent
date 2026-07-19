import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as cli from "./renkai.mjs";
import { readMutationState } from "./lib/mutations.mjs";

const LEGACY_EXPORTS = [
  "automationStatus",
  "base58Encode",
  "battleTick",
  "battleWindowContext",
  "buildSignatureMessage",
  "chooseQuestArchetype",
  "cliErrorOutput",
  "createWallet",
  "cycleTarget",
  "installAutomation",
  "main",
  "namedJobIds",
  "parseReferralInput",
  "registrationRequestBody",
  "repairAutomation",
  "resolveHermesScriptsDir",
  "runRuntimeCommand",
  "signRequest",
  "uninstallAutomation",
];

function testConfig() {
  return {
    version: 3,
    ...cli.createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "test-agent-key",
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
}

async function withCapturedStdout(action) {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, callback) => {
    writes.push(String(chunk));
    if (typeof callback === "function") callback();
    return true;
  };
  try {
    return { result: await action(), output: writes.join("") };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("exports the complete legacy surface", () => {
  assert.deepEqual(Object.keys(cli).sort(), [...LEGACY_EXPORTS].sort());
});

test("prints stable help before config access", async () => {
  const { output } = await withCapturedStdout(() => cli.main(["help", "--config", "/missing/renkai-agent.json"]));
  const help = JSON.parse(output);
  assert.equal(help.usage, "renkai.mjs <doctor|setup|register|profile|state|status|quests|step|inventory|crafting|battle-history|battle-next|battle-policy|battle-tick|automation> [subcommand] [options]");
  assert.equal(Array.isArray(help.examples), true);
  assert.equal(help.examples.length, 7);
  assert.match(help.examples.join("\n"), /inventory --limit 100/);
  assert.match(help.examples.join("\n"), /crafting start/);
  assert.match(help.referral, /--referral/);
  assert.match(help.crafting, /do not refund/);
});

test("routes legacy read commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-surface-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify(testConfig()), { mode: 0o600 });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ method: options.method ?? "GET", path });
    const data = path === "/api/war/state"
      ? { nextWarAt: "2099-01-01T00:00:00.000Z", policy: null, pledge: null }
      : path === "/api/player/state"
        ? { player: { level: 1, branch: null, class: null, gold: 0, status: "idle", currentStamina: 10, castleId: "ashkeep" } }
        : path === "/api/notifications"
          ? { items: [], nextCursor: null }
        : path === "/api/quests"
          ? { quests: [{ id: "quest-1", name: "Iron Trail", archetype: "gathering" }] }
          : { questAction: { lockedUntil: "2099-01-01T00:15:00.000Z" } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await withCapturedStdout(async () => {
      await cli.main(["state", "--config", configPath]);
      await cli.main(["quests", "--config", configPath]);
      await cli.main(["step", "--config", configPath]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [
    "GET /api/player/state",
    "GET /api/quests",
    "GET /api/war/state",
    "GET /api/player/state",
    "GET /api/quests",
    "POST /api/quest/start",
    "GET /api/notifications",
  ]);
});

test("routes inventory and crafting through the executable surface", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-game-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify(testConfig()), { mode: 0o600 });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = `${new URL(url).pathname}${new URL(url).search}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method: options.method ?? "GET", path, body });
    const data = path.startsWith("/api/inventory")
      ? { observedAt: "2026-07-19T00:00:00.000Z", resources: { items: [], totalCount: 0 }, gear: { items: [], nextCursor: null }, weight: { system: "castle_population", activeWeight: 1, capacityWeight: null } }
      : { craftingJobId: "job_1", readyAt: "2026-07-19T00:05:00.000Z" };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await withCapturedStdout(async () => {
      await cli.main(["inventory", "--limit", "25", "--cursor", "cursor_1", "--config", configPath]);
      await cli.main(["crafting", "start", "--recipe", "nightglass_dagger_t1", "--confirm", "nightglass_dagger_t1", "--config", configPath]);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    { method: "GET", path: "/api/inventory?limit=25&cursor=cursor_1", body: undefined },
    { method: "POST", path: "/api/crafting/request", body: { recipeId: "nightglass_dagger_t1" } },
  ]);
});

test("keeps a crafting receipt pending until stdout confirms delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-output-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify(testConfig()), { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: { craftingJobId: "job_output", readyAt: "2099-01-01T00:01:00.000Z" },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  process.stdout.write = (_chunk, callback) => {
    callback(new Error("stdout closed before flush"));
    return false;
  };
  try {
    await assert.rejects(
      cli.main(["crafting", "start", "--recipe", "recipe_output", "--confirm", "recipe_output", "--config", configPath]),
      /stdout closed before flush/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
  assert.equal((await readMutationState(configPath)).pending.operation.includes("recipe_output"), true);
});

test("status writes unreceived notifications before acknowledgement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-notifications-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify(testConfig()), { mode: 0o600 });
  const events = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    events.push(`${options.method ?? "GET"} ${path}`);
    const data = path === "/api/player/state"
      ? { player: { level: 7, status: "idle" } }
      : path === "/api/notifications"
        ? { items: [{ id: "notification_2", type: "craft_ready", readAt: null, createdAt: "2026-07-19T00:00:00.000Z", payload: { craftingJobId: "job_1" } }], nextCursor: null }
        : { results: [{ id: "notification_2", status: "acknowledged" }] };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  process.stdout.write = (chunk) => {
    events.push("stdout");
    const parsed = JSON.parse(String(chunk));
    assert.equal(parsed.player.level, 7);
    assert.equal(parsed.notifications.count, 1);
    assert.equal(parsed.notifications.items[0].id, "notification_2");
    return true;
  };
  try {
    await cli.main(["status", "--config", configPath]);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  }
  assert.deepEqual(events, [
    "GET /api/player/state",
    "GET /api/notifications",
    "stdout",
    "POST /api/notifications/ack",
  ]);
});

test("rejects an unknown command without import side effects", async () => {
  const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import('./renkai.mjs')",
  ], { cwd: scriptsDirectory, encoding: "utf8" });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, "");
  assert.equal(imported.stderr, "");

  const directory = await mkdtemp(join(tmpdir(), "renkai-cli-error-"));
  const configPath = join(directory, "agent.json");
  await writeFile(configPath, JSON.stringify(testConfig()), { mode: 0o600 });
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("unexpected network request");
  };
  try {
    await assert.rejects(
      cli.main(["unknown-command", "--config", configPath]),
      (error) => error instanceof Error && error.message === "Unknown command: unknown-command",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});
