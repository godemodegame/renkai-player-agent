#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  agentRequest,
  base58Encode,
  buildSignatureMessage,
  createWallet,
  signRequest,
  unsignedGet,
} from "./lib/api.mjs";
import { configPathFrom, readConfig, safeProfile } from "./lib/config.mjs";
import { runCraftingCommand } from "./lib/crafting.mjs";
import { readInventory } from "./lib/inventory.mjs";
import { drainNotifications } from "./lib/notifications.mjs";
import { allocateStats } from "./lib/stats.mjs";
import {
  clearWarPledge,
  listQuests,
  pledgeWar,
  playerState,
  selectBranch,
  selectClass,
  startQuest,
  warState,
} from "./lib/primitives.mjs";
import { cleanupLegacyAutomation } from "./lib/automation.mjs";
import {
  DEFAULT_BASE_URL,
  parseReferralInput,
  register,
  registrationRequestBody,
  setup,
} from "./lib/onboarding.mjs";

const ROOT_ENTRY_PATH = fileURLToPath(import.meta.url);

export { base58Encode, buildSignatureMessage, createWallet, parseReferralInput, registrationRequestBody, signRequest };

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  let subcommand;
  let subsubcommand;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      if (!subcommand) subcommand = token;
      else if (!subsubcommand) subsubcommand = token;
      else throw new Error("Unexpected argument: " + token);
      continue;
    }
    const key = token.slice(2);
    if (key === "offline" || key === "quiet") {
      flags[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --" + key);
    flags[key] = value;
    index += 1;
  }
  return { command, subcommand, subsubcommand, flags };
}

async function doctor(configPath, flags) {
  let config;
  try { config = await readConfig(configPath); } catch { config = null; }
  const baseUrl = new URL(flags["base-url"] ?? config?.baseUrl ?? DEFAULT_BASE_URL).origin;
  const health = await unsignedGet(baseUrl, "/api/health");
  let war = null;
  if (config?.agentKey) {
    try {
      war = await agentRequest(config, "GET", "/api/war/state");
    } catch (error) {
      war = { error: error.code ?? error.message };
    }
  }
  return {
    baseUrl,
    health,
    configVersion: config?.version ?? null,
    agentApi: config?.agentKey ? "registered" : config ? "wallet_only" : "not_configured",
    nextWarAt: war?.nextWarAt ?? null,
    setupStatus: config?.agentKey ? "ready" : config ? "wallet_only" : "not_configured",
  };
}

function print(value, quiet = false) {
  if (!quiet) process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function printDurably(value) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function help() {
  return {
    usage: "renkai.mjs <doctor|setup|register|profile|state|status|quests|quest|player|war|inventory|craft|crafting|stats|battle-history> [subcommand] [options]",
    examples: [
      "renkai.mjs setup --referral https://app.renkai.xyz/?ref=player_123",
      "renkai.mjs inventory --limit 100",
      "renkai.mjs crafting start --recipe nightglass_dagger_t1 --confirm nightglass_dagger_t1",
      "renkai.mjs crafting list",
      "renkai.mjs stats allocate --stat strength --points 1 --confirm strength:1",
      "renkai.mjs quest start --quest-id ashkeep_patrol_01 --confirm ashkeep_patrol_01",
      "renkai.mjs war pledge --role attack --target thornmere --confirm attack:thornmere",
    ],
    referral: "Pass --referral <https://app.renkai.xyz/...?...ref=player_...>; use --referral none only when there is no referrer.",
    crafting: "Every mutation requires an exact target-matching --confirm. Cancelled jobs do not refund spent Gold or resources; wait for readyAt/nextRecommendedPollAt instead of busy-looping.",
    stats: "Stat allocation spends pooled points and Gold. It requires --confirm <stat>:<points> and is retried with one idempotency key when the result is ambiguous.",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, subcommand, subsubcommand, flags } = parseArgs(argv);
  const configPath = configPathFrom(flags);
  if (command === "help" || command === "--help") return print(help());
  if (command === "doctor") return print(await doctor(configPath, flags));
  if (command === "legacy-cleanup") return print(await cleanupLegacyAutomation(flags.runtime));
  if (command === "setup") return print(await setup(configPath, flags));
  const config = await readConfig(configPath);
  if (command === "register") return print(await register(configPath, config));
  if (command === "profile") return print(safeProfile(config));
  if (command === "state" || (command === "player" && subcommand === "state")) return print(await playerState(config));
  if (command === "quests" || (command === "quests" && subcommand === "list")) return print(await listQuests(config));
  if (command === "quest" && subcommand === "list") return print(await listQuests(config));
  if (command === "quest" && subcommand === "start") return print(await startQuest(config, flags));
  if (command === "player" && subcommand === "branch" && subsubcommand === "set") return print(await selectBranch(config, flags));
  if (command === "player" && subcommand === "class" && subsubcommand === "set") return print(await selectClass(config, flags));
  if (command === "battle-history") return print(await agentRequest(config, "GET", "/api/war/history"));
  if (command === "war" && subcommand === "state") return print(await warState(config));
  if (command === "war" && subcommand === "pledge") return print(await pledgeWar(config, flags));
  if (command === "war" && subcommand === "pledge-clear") return print(await clearWarPledge(config, flags));
  if (command === "inventory") return print(await readInventory(config, flags));
  if (command === "status") {
    return drainNotifications(configPath, config, () => agentRequest(config, "GET", "/api/player/state"));
  }
  if (command === "crafting" || command === "craft") {
    const isMutation = ["start", "cancel", "claim", "retry-mint"].includes(subcommand);
    const result = await runCraftingCommand(config, subcommand, flags, {
      configPath,
      ...(isMutation ? { onResult: printDurably } : {}),
    });
    return isMutation ? result : print(result);
  }
  if (command === "stats" && subcommand === "allocate") return print(await allocateStats(config, flags, { configPath }));
  throw new Error("Unknown command: " + command + (subcommand ? " " + subcommand : ""));
}

export function cliErrorOutput(error) {
  return {
    ok: false,
    error: { code: error.code ?? "CLIENT_ERROR", message: error.message, status: error.status, retryAt: error.retryAt, details: error.details },
    ...(error.waitlist ? { waitlist: error.waitlist } : {}),
    ...(error.publicContext ? { publicContext: error.publicContext } : {}),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify(cliErrorOutput(error), null, 2) + "\n");
    process.exitCode = 1;
  });
}
