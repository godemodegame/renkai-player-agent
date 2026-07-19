import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
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

export function notificationStatePath(configPath) {
  return `${configPath}.notifications.json`;
}

export function notificationLockPath(configPath) {
  return `${configPath}.notifications.json.lock`;
}

export function emptyNotificationState() {
  return { version: 1, lastAcknowledgedId: null, sweep: null };
}

function normalizeNotificationState(value) {
  if (!value || value.version !== 1 || (value.lastAcknowledgedId !== null && typeof value.lastAcknowledgedId !== "string")) {
    const error = new Error("Renkai notification state is malformed.");
    error.code = "NOTIFICATION_STATE_INVALID";
    throw error;
  }
  if (value.sweep !== null && (!value.sweep || typeof value.sweep !== "object"
    || typeof value.sweep.headId !== "string" || typeof value.sweep.nextCursor !== "string")) {
    const error = new Error("Renkai notification sweep state is malformed.");
    error.code = "NOTIFICATION_STATE_INVALID";
    throw error;
  }
  return {
    version: 1,
    lastAcknowledgedId: value.lastAcknowledgedId,
    sweep: value.sweep ? { headId: value.sweep.headId, nextCursor: value.sweep.nextCursor } : null,
  };
}

export async function readNotificationState(configPath) {
  const statePath = configPath.endsWith(".notifications.json") ? configPath : notificationStatePath(configPath);
  try {
    return normalizeNotificationState(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyNotificationState();
    throw error;
  }
}

export async function writeNotificationState(configPath, state) {
  const statePath = configPath.endsWith(".notifications.json") ? configPath : notificationStatePath(configPath);
  return writeJsonAtomic(statePath, normalizeNotificationState(state));
}

async function staleLock(lockPath, now) {
  try {
    const [metadata, file] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const record = JSON.parse(metadata);
    const rawTimestamp = record.timestamp ?? record.createdAt;
    const recordedAt = typeof rawTimestamp === "number" ? rawTimestamp : Date.parse(rawTimestamp);
    const cutoff = now() - 15 * 60 * 1000;
    return Number.isFinite(recordedAt) && recordedAt < cutoff && file.mtimeMs < cutoff;
  } catch {
    return false;
  }
}

export async function acquireNotificationLock(configPath, options = {}) {
  const lockPath = options.lockPath ?? notificationLockPath(configPath);
  const now = typeof options.now === "function" ? options.now : () => options.now ?? Date.now();
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, timestamp: now(), createdAt: new Date(now()).toISOString() })}\n`);
      await handle.close();
      await chmod(lockPath, 0o600);
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0 || !(await staleLock(lockPath, now))) {
        const busy = new Error("Another Renkai notification drain is already running.");
        busy.code = "NOTIFICATION_DRAIN_BUSY";
        busy.retryAt = new Date(now() + 5_000).toISOString();
        throw busy;
      }
      await unlink(lockPath).catch(() => {});
    }
  }
  throw new Error("Could not acquire notification lock.");
}

export async function releaseNotificationLock(lock, token) {
  const lockPath = typeof lock === "string" ? lock : lock?.lockPath ?? lock?.path;
  const ownerToken = token ?? lock?.token ?? lock?.ownerToken;
  if (!lockPath || !ownerToken) return false;
  try {
    const record = JSON.parse(await readFile(lockPath, "utf8"));
    if (record.token !== ownerToken) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
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
