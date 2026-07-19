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
import {
  automationStatus,
  installAutomation as installAutomationForEntry,
  namedJobIds,
  repairAutomation as repairAutomationForEntry,
  resolveHermesScriptsDir,
  runRuntimeCommand,
  uninstallAutomation,
} from "./lib/automation.mjs";
import {
  battleTick,
  clearBattlePolicy,
  clearNextBattle,
  setBattlePolicy,
  setNextBattle,
  takeStep,
} from "./lib/battle.mjs";
import { configPathFrom, readConfig, safeProfile } from "./lib/config.mjs";
import { runCraftingCommand } from "./lib/crafting.mjs";
import { readInventory } from "./lib/inventory.mjs";
import { drainNotifications } from "./lib/notifications.mjs";
import {
  DEFAULT_BASE_URL,
  parseReferralInput,
  register,
  registrationRequestBody,
  setup,
} from "./lib/onboarding.mjs";
import { battleWindowContext, chooseQuestArchetype, cycleTarget } from "./lib/strategy.mjs";

const ROOT_ENTRY_PATH = fileURLToPath(import.meta.url);

export {
  automationStatus,
  base58Encode,
  battleTick,
  battleWindowContext,
  buildSignatureMessage,
  chooseQuestArchetype,
  createWallet,
  cycleTarget,
  namedJobIds,
  parseReferralInput,
  registrationRequestBody,
  resolveHermesScriptsDir,
  runRuntimeCommand,
  signRequest,
  uninstallAutomation,
};

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  let subcommand;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      if (subcommand) throw new Error("Unexpected argument: " + token);
      subcommand = token;
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
  return { command, subcommand, flags };
}

export async function installAutomation(configPath, config, runtime, flags, options = {}) {
  return installAutomationForEntry(ROOT_ENTRY_PATH, configPath, config, runtime, flags, options);
}

export async function repairAutomation(configPath, config, runtime, flags, options = {}) {
  return repairAutomationForEntry(ROOT_ENTRY_PATH, configPath, config, runtime, flags, options);
}

async function doctor(configPath, flags) {
  let config;
  try { config = await readConfig(configPath); } catch { config = null; }
  const baseUrl = new URL(flags["base-url"] ?? config?.baseUrl ?? DEFAULT_BASE_URL).origin;
  const health = await unsignedGet(baseUrl, "/api/health");
  let policy = null;
  let war = null;
  if (config?.agentKey) {
    try {
      [policy, war] = await Promise.all([
        agentRequest(config, "GET", "/api/war/policy"),
        agentRequest(config, "GET", "/api/war/state"),
      ]);
    } catch (error) {
      policy = { error: error.code ?? error.message };
    }
  }
  const scheduler = config ? await automationStatus(config) : { installed: false, runtime: null, jobId: null };
  const allBattlesReady = Boolean(policy?.policy && scheduler.installed && config?.automation.lastRunAt);
  const battleParticipation = policy?.policy
    ? allBattlesReady ? "all_battles_ready" : "all_battles_needs_automation"
    : war?.pledge ? "next_battle_only" : "not_participating";
  return {
    baseUrl,
    health,
    configVersion: config?.version ?? null,
    agentApi: config?.agentKey ? "registered" : config ? "wallet_only" : "not_configured",
    policy: policy?.policy ?? null,
    scheduler,
    lastRunAt: config?.automation.lastRunAt ?? null,
    nextWarAt: war?.nextWarAt ?? battleWindowContext().scheduledAt,
    battleParticipation,
    allBattlesReady,
    setupStatus: config?.agentKey ? "ready" : config ? "wallet_only" : "not_configured",
  };
}

function print(value, quiet = false) {
  if (!quiet) process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function help() {
  return {
    usage: "renkai.mjs <doctor|setup|register|profile|state|status|quests|step|inventory|crafting|battle-history|battle-next|battle-policy|battle-tick|automation> [subcommand] [options]",
    examples: [
      "renkai.mjs setup --direction miner --resources iron,coal --referral https://app.renkai.xyz/?ref=player_123",
      "renkai.mjs inventory --limit 100",
      "renkai.mjs crafting start --recipe nightglass_dagger_t1 --confirm nightglass_dagger_t1",
      "renkai.mjs crafting list",
      "renkai.mjs battle-next set --mode defend",
      "renkai.mjs battle-policy set --mode attack-fixed --target thornmere",
      "renkai.mjs automation install --runtime hermes --notify-channel origin",
    ],
    referral: "Pass --referral <https://app.renkai.xyz/...?...ref=player_...>; use --referral none only when there is no referrer.",
    crafting: "Every mutation requires an exact target-matching --confirm. Cancelled jobs do not refund spent Gold or resources; wait for readyAt/nextRecommendedPollAt instead of busy-looping.",
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, subcommand, flags } = parseArgs(argv);
  const configPath = configPathFrom(flags);
  if (command === "help" || command === "--help") return print(help());
  if (command === "doctor") return print(await doctor(configPath, flags));
  if (command === "setup") return print(await setup(configPath, flags));
  const config = await readConfig(configPath);
  if (command === "register") return print(await register(configPath, config));
  if (command === "profile") return print(safeProfile(config));
  if (command === "state") return print(await agentRequest(config, "GET", "/api/player/state"));
  if (command === "quests") return print(await agentRequest(config, "GET", "/api/quests"));
  if (command === "battle-history") return print(await agentRequest(config, "GET", "/api/war/history"));
  if (command === "step") {
    return drainNotifications(configPath, config, () => takeStep(configPath, config), {
      projectItem: (item) => item.type === "war_resolved" ? { id: item.id, type: item.type } : item,
    });
  }
  if (command === "inventory") return print(await readInventory(config, flags));
  if (command === "battle-next" && subcommand === "show") return print(await agentRequest(config, "GET", "/api/war/state"));
  if (command === "battle-next" && subcommand === "set") return print(await setNextBattle(config, flags.mode, flags.target));
  if (command === "battle-next" && subcommand === "clear") return print(await clearNextBattle(config));
  if (command === "battle-policy" && subcommand === "show") return print(await agentRequest(config, "GET", "/api/war/policy"));
  if (command === "battle-policy" && subcommand === "set") {
    return print(await setBattlePolicy(configPath, config, flags.mode, flags.target));
  }
  if (command === "battle-policy" && subcommand === "clear") return print(await clearBattlePolicy(configPath, config));
  if (command === "battle-tick") return print(await battleTick(configPath, config), flags.quiet);
  if (command === "automation" && subcommand === "status") return print(await automationStatus(config));
  if (command === "automation" && subcommand === "install") {
    return print(await installAutomation(configPath, config, flags.runtime, flags));
  }
  if (command === "automation" && subcommand === "repair") {
    return print(await repairAutomation(configPath, config, flags.runtime, flags));
  }
  if (command === "automation" && subcommand === "uninstall") {
    return print(await uninstallAutomation(configPath, config, flags.runtime));
  }
  if (command === "status") {
    return drainNotifications(configPath, config, async () => ({
      action: "status",
      state: await agentRequest(config, "GET", "/api/player/state"),
    }));
  }
  if (command === "inventory") return print(await readInventory(config, flags));
  if (command === "crafting") {
    const isMutation = ["start", "cancel", "claim", "retry-mint"].includes(subcommand);
    const result = await runCraftingCommand(config, subcommand, flags, {
      configPath,
      ...(isMutation ? { onResult: (value) => print(value) } : {}),
    });
    return isMutation ? result : print(result);
  }
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
