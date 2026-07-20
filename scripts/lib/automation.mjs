import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentRequest } from "./api.mjs";
import { emptyAutomation, writeConfig, writeTextAtomic } from "./config.mjs";

const AUTOMATION_NAME = "renkai-all-battles";
const LEGACY_BATTLE_AUTOMATION_NAME = "renkai-mandatory-battles";
const LEGACY_QUEST_AUTOMATION_NAME = "renkai-quests-step";

export function runRuntimeCommand(binary, args) {
  return { stdout: execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
}

function parseJobId(output) {
  try {
    const parsed = JSON.parse(output);
    return parsed.id ?? parsed.jobId ?? parsed.job?.id ?? null;
  } catch {
    return output.match(/\b[0-9a-f]{8,64}\b/i)?.[0] ?? null;
  }
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function jobsFromJson(value, jobs = []) {
  if (Array.isArray(value)) {
    for (const item of value) jobsFromJson(item, jobs);
    return jobs;
  }
  if (!value || typeof value !== "object") return jobs;
  const id = value.id ?? value.jobId ?? value.job_id;
  const name = value.name ?? value.jobName ?? value.job_name;
  if (id && name) jobs.push({ id: String(id), name: String(name) });
  for (const nested of Object.values(value)) jobsFromJson(nested, jobs);
  return jobs;
}

export function namedJobIds(output, expectedName) {
  const plain = stripAnsi(output);
  try {
    const parsed = jobsFromJson(JSON.parse(plain));
    return [...new Set(parsed.filter((job) => job.name === expectedName).map((job) => job.id))];
  } catch {
    // Hermes renders each job as a blank-line-separated block with the ID first
    // and an indented `Name:` field. Keep the parser strict so unrelated jobs
    // are never removed.
  }
  const ids = [];
  for (const block of plain.split(/\n\s*\n/)) {
    const name = block.match(/^\s*Name:\s*(.+?)\s*$/mi)?.[1];
    if (name !== expectedName) continue;
    const id = block.match(/^\s*([A-Za-z0-9_-]{6,})\b/m)?.[1];
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
}

export function resolveHermesScriptsDir(options = {}) {
  const env = options.env ?? process.env;
  const pathExists = options.pathExists ?? existsSync;
  if (env.HERMES_HOME) return join(resolve(env.HERMES_HOME), "scripts");
  // Hermes Docker mounts its persistent data at /opt/data. Some Gateway
  // launch paths have historically omitted HERMES_HOME from child processes,
  // so detect the mounted directory before falling back to a host install.
  if (pathExists("/opt/data")) return "/opt/data/scripts";
  return join(options.homeDir ?? homedir(), ".hermes", "scripts");
}

function notificationFrom(flags, existing) {
  if (flags["notify-channel"]) return { channel: flags["notify-channel"], recipient: flags["notify-to"] ?? null };
  if (existing?.channel) return existing;
  throw new Error("Automation installation requires --notify-channel and, when applicable, --notify-to.");
}

function hermesDelivery(notification) {
  return notification.recipient ? `${notification.channel}:${notification.recipient}` : notification.channel;
}

function openClawDeliveryArgs(notification) {
  if (notification.channel === "origin") return ["--announce", "--session", "current"];
  if (!notification.recipient) throw new Error("OpenClaw requires --notify-to for a named notification channel.");
  return ["--announce", "--channel", notification.channel, "--to", notification.recipient];
}

function runtimeList(runtime, runner) {
  const binary = runtime === "hermes" ? "hermes" : "openclaw";
  return runner(binary, ["cron", "list", ...(runtime === "openclaw" ? ["--json"] : [])]).stdout;
}

function removeNamedJobs(runtime, name, runner, listedOutput) {
  const binary = runtime === "hermes" ? "hermes" : "openclaw";
  const output = listedOutput ?? runtimeList(runtime, runner);
  const ids = namedJobIds(output, name);
  for (const id of ids) runner(binary, ["cron", "remove", id]);
  return ids;
}

async function requireLiveBattlePolicy(config, options = {}) {
  const request = options.request ?? agentRequest;
  const livePolicy = options.livePolicy ?? await request(config, "GET", "/api/war/policy");
  if (!livePolicy?.policy) {
    const error = new Error("The server has no all-battles policy. Set one before installing battle automation.");
    error.code = "NO_BATTLE_INSTRUCTION";
    throw error;
  }
  return livePolicy;
}

export async function automationStatus(config, options = {}) {
  const runner = options.runner ?? runRuntimeCommand;
  if (!config.automation.runtime) return { installed: false, runtime: null, jobId: null };
  try {
    const output = runtimeList(config.automation.runtime, runner);
    const jobPresent = output.includes(config.automation.jobId ?? AUTOMATION_NAME) || namedJobIds(output, AUTOMATION_NAME).length > 0;
    const scriptPath = config.automation.scriptPath
      ?? (config.automation.runtime === "hermes" ? join(resolveHermesScriptsDir(options), `${AUTOMATION_NAME}.sh`) : null);
    const scriptPresent = config.automation.runtime !== "hermes" || existsSync(scriptPath);
    return {
      installed: jobPresent && scriptPresent,
      runtime: config.automation.runtime,
      jobId: config.automation.jobId,
      scriptPath,
      scriptPresent,
      lastRunAt: config.automation.lastRunAt,
    };
  } catch (error) {
    return { installed: false, runtime: config.automation.runtime, jobId: config.automation.jobId, error: error.message };
  }
}

export async function installAutomation(rootEntryPath, configPath, config, runtime, flags, options = {}) {
  if (runtime !== "hermes" && runtime !== "openclaw") throw new Error("--runtime must be hermes or openclaw.");
  if (!config.agentKey || !config.battle) throw new Error("Register the wallet and set battle policy before installing automation.");
  const runner = options.runner ?? runRuntimeCommand;
  const livePolicy = await requireLiveBattlePolicy(config, options);
  config.battle = {
    mode: livePolicy.policy.mode,
    targetCastleId: livePolicy.policy.targetCastleId ?? null,
    updatedAt: livePolicy.policy.updatedAt,
  };
  const notification = notificationFrom(flags, config.automation.notification);

  let creation;
  let wrapperPath = null;
  if (runtime === "hermes") {
    const scriptsDir = options.hermesScriptsDir ?? resolveHermesScriptsDir(options);
    wrapperPath = join(scriptsDir, `${AUTOMATION_NAME}.sh`);
    await mkdir(scriptsDir, { recursive: true, mode: 0o700 });
    const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
    await writeTextAtomic(wrapperPath, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(rootEntryPath)} battle-tick --quiet --config ${quote(configPath)}\n`, 0o700);
    runner("/bin/bash", [wrapperPath]);
  }

  const existingList = runtimeList(runtime, runner);
  const removedLegacyJobIds = [
    ...removeNamedJobs(runtime, LEGACY_BATTLE_AUTOMATION_NAME, runner, existingList),
    ...removeNamedJobs(runtime, LEGACY_QUEST_AUTOMATION_NAME, runner, existingList),
  ];
  const existingJobIds = namedJobIds(existingList, AUTOMATION_NAME);
  if (existingJobIds.length === 1) {
    const jobId = existingJobIds[0];
    runner(runtime === "hermes" ? "hermes" : "openclaw", ["cron", "run", jobId, ...(runtime === "openclaw" ? ["--wait"] : [])]);
    config.automation = {
      ...config.automation,
      runtime,
      jobId,
      scriptPath: wrapperPath,
      notification,
      lastRunAt: new Date().toISOString(),
    };
    await writeConfig(configPath, config);
    return {
      installed: true,
      duplicate: false,
      existing: true,
      runtime,
      jobId,
      scriptPath: wrapperPath,
      removedLegacyJobIds,
      testRun: "passed",
    };
  }
  const removedDuplicateJobIds = existingJobIds.length > 1
    ? removeNamedJobs(runtime, AUTOMATION_NAME, runner, existingList)
    : [];
  if (existingList.includes(AUTOMATION_NAME) && existingJobIds.length === 0) {
    throw new Error(`Could not safely identify the existing ${AUTOMATION_NAME} job by ID; run hermes cron list and remove its exact ID before retrying.`);
  }

  if (runtime === "hermes") {
    creation = runner("hermes", [
      "cron", "create", "every 1m", "--no-agent", "--script", `${AUTOMATION_NAME}.sh`,
      "--deliver", hermesDelivery(notification), "--name", AUTOMATION_NAME,
    ]);
  } else {
    const argv = [process.execPath, rootEntryPath, "battle-tick", "--quiet", "--config", configPath];
    creation = runner("openclaw", [
      "cron", "create", "* * * * *", "--name", AUTOMATION_NAME,
      "--command-argv", JSON.stringify(argv), "--tz", "UTC", "--exact",
      ...openClawDeliveryArgs(notification),
    ]);
  }
  const jobId = parseJobId(creation.stdout) ?? AUTOMATION_NAME;
  runner(runtime === "hermes" ? "hermes" : "openclaw", ["cron", "run", jobId, ...(runtime === "openclaw" ? ["--wait"] : [])]);
  config.automation = { ...config.automation, runtime, jobId, scriptPath: wrapperPath, notification, lastRunAt: new Date().toISOString() };
  await writeConfig(configPath, config);
  return {
    installed: true,
    duplicate: false,
    existing: false,
    runtime,
    jobId,
    scriptPath: wrapperPath,
    removedDuplicateJobIds,
    removedLegacyJobIds,
    testRun: "passed",
  };
}

export async function repairAutomation(rootEntryPath, configPath, config, runtime, flags, options = {}) {
  const runner = options.runner ?? runRuntimeCommand;
  const selectedRuntime = runtime ?? config.automation.runtime;
  if (!selectedRuntime) throw new Error("--runtime must be hermes or openclaw.");
  const livePolicy = await requireLiveBattlePolicy(config, options);
  const listed = runtimeList(selectedRuntime, runner);
  removeNamedJobs(selectedRuntime, AUTOMATION_NAME, runner, listed);
  removeNamedJobs(selectedRuntime, LEGACY_BATTLE_AUTOMATION_NAME, runner, listed);
  removeNamedJobs(selectedRuntime, LEGACY_QUEST_AUTOMATION_NAME, runner, listed);
  config.automation.jobId = null;
  config.automation.scriptPath = null;
  return installAutomation(rootEntryPath, configPath, config, selectedRuntime, flags, { ...options, livePolicy });
}

export async function uninstallAutomation(configPath, config, runtime, options = {}) {
  const runner = options.runner ?? runRuntimeCommand;
  const selectedRuntime = runtime ?? config.automation.runtime;
  const removedJobIds = [];
  if (selectedRuntime) {
    if (selectedRuntime !== "hermes" && selectedRuntime !== "openclaw") throw new Error("--runtime must be hermes or openclaw.");
    const listed = runtimeList(selectedRuntime, runner);
    removedJobIds.push(...removeNamedJobs(selectedRuntime, AUTOMATION_NAME, runner, listed));
    removedJobIds.push(...removeNamedJobs(selectedRuntime, LEGACY_BATTLE_AUTOMATION_NAME, runner, listed));
    removedJobIds.push(...removeNamedJobs(selectedRuntime, LEGACY_QUEST_AUTOMATION_NAME, runner, listed));
  }
  config.automation = emptyAutomation();
  await writeConfig(configPath, config);
  return { installed: false, runtime: selectedRuntime ?? null, removedJobIds };
}

/** Deprecated migration-only cleanup. It never contacts the game API. */
export async function cleanupLegacyAutomation(runtime, options = {}) {
  if (runtime !== "hermes" && runtime !== "openclaw") throw new Error("--runtime must be hermes or openclaw.");
  const runner = options.runner ?? runRuntimeCommand;
  const listed = runtimeList(runtime, runner);
  const removedJobIds = [
    ...removeNamedJobs(runtime, AUTOMATION_NAME, runner, listed),
    ...removeNamedJobs(runtime, LEGACY_BATTLE_AUTOMATION_NAME, runner, listed),
    ...removeNamedJobs(runtime, LEGACY_QUEST_AUTOMATION_NAME, runner, listed),
  ];
  return { runtime, removedJobIds, migrationOnly: true };
}
