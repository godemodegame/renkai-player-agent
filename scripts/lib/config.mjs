import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { BRANCH_BY_DIRECTION } from "./strategy.mjs";

function defaultConfigPath() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Renkai", "agent.json");
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "renkai", "agent.json");
  return join(homedir(), ".config", "renkai", "agent.json");
}

export function configPathFrom(flags) {
  const candidate = flags.config ?? process.env.RENKAI_CONFIG ?? defaultConfigPath();
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

export function emptyAutomation() {
  return {
    runtime: null,
    jobId: null,
    scriptPath: null,
    lastRunAt: null,
    lastPledgedWindowId: null,
    lastAlertedWindowId: null,
    notification: null,
  };
}

export function migrateConfig(config) {
  if (!config.walletAddress || !config.privateKeyPkcs8) throw new Error("Renkai config is missing wallet credentials.");
  if (config.version !== 3) {
    config.version = 3;
    config.battle ??= null;
    config.automation ??= emptyAutomation();
  }
  config.automation = { ...emptyAutomation(), ...(config.automation ?? {}) };
  config.referral ??= null;
  return config;
}

export async function readConfig(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    const needsMigration = parsed.version !== 3;
    const config = migrateConfig(parsed);
    if (needsMigration) await writeConfig(configPath, config);
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No Renkai agent config at ${configPath}. Run setup first.`);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}

export async function writeConfig(configPath, config) {
  return writeJsonAtomic(configPath, config);
}

export function safeProfile(config) {
  return {
    walletAddress: config.walletAddress,
    baseUrl: config.baseUrl,
    registered: Boolean(config.agentKey),
    direction: config.profile.direction,
    branch: BRANCH_BY_DIRECTION[config.profile.direction],
    class: config.profile.direction,
    resources: config.profile.resources,
    goal: config.profile.goal,
    battle: config.battle,
    referredBy: config.referral?.referrerPlayerId ?? null,
    setupStatus: config.agentKey ? "ready" : "wallet_only",
  };
}
