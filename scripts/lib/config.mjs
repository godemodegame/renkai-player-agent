import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
  return { version: 2, receivedIds: [], sweep: null };
}

async function readPrivateFile(filePath) {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  try {
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readPrivateJson(filePath) {
  return JSON.parse(await readPrivateFile(filePath));
}

function normalizeNotificationState(value) {
  if (value?.version === 1) return emptyNotificationState();
  if (!value || value.version !== 2 || !Array.isArray(value.receivedIds)
    || value.receivedIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.receivedIds).size !== value.receivedIds.length) {
    const error = new Error("Renkai notification state is malformed.");
    error.code = "NOTIFICATION_STATE_INVALID";
    throw error;
  }
  if (value.sweep !== null && (!value.sweep || typeof value.sweep !== "object"
    || typeof value.sweep.nextCursor !== "string" || !Array.isArray(value.sweep.encounteredIds)
    || value.sweep.encounteredIds.some((id) => typeof id !== "string" || id.length === 0)
    || new Set(value.sweep.encounteredIds).size !== value.sweep.encounteredIds.length)) {
    const error = new Error("Renkai notification sweep state is malformed.");
    error.code = "NOTIFICATION_STATE_INVALID";
    throw error;
  }
  return {
    version: 2,
    receivedIds: [...value.receivedIds],
    sweep: value.sweep ? { nextCursor: value.sweep.nextCursor, encounteredIds: [...value.sweep.encounteredIds] } : null,
  };
}

export async function readNotificationState(configPath) {
  const statePath = notificationStatePath(configPath);
  try {
    return normalizeNotificationState(await readPrivateJson(statePath));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyNotificationState();
    throw error;
  }
}

export async function writeNotificationState(configPath, state) {
  const statePath = notificationStatePath(configPath);
  return writeJsonAtomic(statePath, normalizeNotificationState(state));
}

async function staleLock(lockPath, now) {
  try {
    const [metadata, file] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const cutoff = now() - 15 * 60 * 1000;
    if (file.mtimeMs >= cutoff) return null;
    try {
      const record = JSON.parse(metadata);
      const rawTimestamp = record.timestamp ?? record.createdAt;
      const recordedAt = typeof rawTimestamp === "number" ? rawTimestamp : Date.parse(rawTimestamp);
      if (typeof record.token === "string" && record.token.length > 0 && Number.isFinite(recordedAt) && recordedAt < cutoff) {
        if (Number.isInteger(record.pid) && record.pid > 0) {
          try {
            process.kill(record.pid, 0);
            return null;
          } catch (error) {
            if (error?.code !== "ESRCH") return null;
          }
        }
        return { token: record.token, mtimeMs: file.mtimeMs, malformed: false, cutoff };
      }
      if (typeof record.token === "string" && record.token.length > 0 && Number.isFinite(recordedAt)) return null;
    } catch {
      // An interrupted exclusive create can leave an empty or partial lock.
    }
    return { token: null, mtimeMs: file.mtimeMs, malformed: true, cutoff };
  } catch {
    return null;
  }
}

async function claimNotificationLock(lockPath, candidate, now = () => Date.now(), beforeUnlink) {
  const expected = typeof candidate === "string"
    ? { token: candidate, malformed: false, mtimeMs: null, cutoff: null }
    : candidate;
  const claimPath = `${lockPath}.claim`;
  let handle;
  let claimCreated = false;
  try {
    handle = await open(claimPath, "wx", 0o600);
    claimCreated = true;
    await handle.writeFile(`${JSON.stringify({ token: randomUUID(), pid: process.pid, timestamp: now() })}\n`);
    await handle.close();
    handle = null;
    await chmod(claimPath, 0o600);
  } catch {
    await handle?.close().catch(() => {});
    if (claimCreated) await unlink(claimPath).catch(() => {});
    return false;
  }
  try {
    const [metadata, file] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    if (expected.mtimeMs !== null && file.mtimeMs !== expected.mtimeMs) return false;
    let matches = false;
    try {
      const record = JSON.parse(metadata);
      const rawTimestamp = record?.timestamp ?? record?.createdAt;
      const recordedAt = typeof rawTimestamp === "number" ? rawTimestamp : Date.parse(rawTimestamp);
      const validRecord = typeof record?.token === "string" && record.token.length > 0 && Number.isFinite(recordedAt);
      matches = expected.malformed ? !validRecord : record?.token === expected.token;
    } catch {
      matches = expected.malformed;
    }
    if (!matches || (expected.malformed && file.mtimeMs >= expected.cutoff)) return false;
    if (beforeUnlink) await beforeUnlink();
    try {
      await unlink(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(claimPath).catch(() => {});
  }
}

async function cleanupStaleLockClaims(lockPath, now) {
  const directory = dirname(lockPath);
  const claimName = `${basename(lockPath)}.claim`;
  const cutoff = now() - 15 * 60 * 1000;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter((entry) => entry.name === claimName || entry.name.startsWith(`${claimName}.`)).map(async (entry) => {
    const claimPath = join(directory, entry.name);
    const file = await lstat(claimPath).catch(() => null);
    if (!file) return;
    let recordedAt = file.mtimeMs;
    let ownerPid = null;
    try {
      const record = JSON.parse(await readFile(claimPath, "utf8"));
      if (Number.isInteger(record.pid) && record.pid > 0) ownerPid = record.pid;
      const rawTimestamp = record.timestamp ?? record.createdAt;
      const parsed = typeof rawTimestamp === "number" ? rawTimestamp : Date.parse(rawTimestamp);
      if (Number.isFinite(parsed)) recordedAt = parsed;
    } catch {
      // Legacy or interrupted claim files fall back to their own modification time.
    }
    if (ownerPid !== null) {
      try {
        process.kill(ownerPid, 0);
        return;
      } catch (error) {
        if (error?.code !== "ESRCH") return;
      }
    }
    if (recordedAt < cutoff) await unlink(claimPath).catch(() => {});
  }));
}

export async function acquireNotificationLock(configPath, options = {}) {
  const lockPath = options.lockPath ?? notificationLockPath(configPath);
  const now = typeof options.now === "function" ? options.now : () => options.now ?? Date.now();
  const token = randomUUID();
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  await cleanupStaleLockClaims(lockPath, now);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, timestamp: now(), createdAt: new Date(now()).toISOString() })}\n`);
      await handle.close();
      await chmod(lockPath, 0o600);
      return { lockPath, token };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) {
        const busy = new Error("Another Renkai notification drain is already running.");
        busy.code = "NOTIFICATION_DRAIN_BUSY";
        busy.retryAt = new Date(now() + 5_000).toISOString();
        throw busy;
      }
      const staleToken = await staleLock(lockPath, now);
      if (!staleToken || !(await claimNotificationLock(lockPath, staleToken, now, options.beforeLockUnlink))) {
        const busy = new Error("Another Renkai notification drain is already running.");
        busy.code = "NOTIFICATION_DRAIN_BUSY";
        busy.retryAt = new Date(now() + 5_000).toISOString();
        throw busy;
      }
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
    return claimNotificationLock(lockPath, ownerToken);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export function migrateConfig(config) {
  if (!config.walletAddress || !config.privateKeyPkcs8) throw new Error("Renkai config is missing wallet credentials.");
  const legacy = config.version < 4 || Boolean(config.profile || config.battle || config.automation);
  if (config.version !== 4) config.version = 4;
  config.referral ??= null;
  if (legacy) {
    config.legacyMigrationRequired = true;
    delete config.profile;
    delete config.battle;
    delete config.automation;
  }
  return config;
}

export async function readConfig(configPath) {
  try {
    const parsed = await readPrivateJson(configPath);
    const needsMigration = parsed.version !== 4;
    const config = migrateConfig(parsed);
    if (needsMigration) await writeConfig(configPath, config);
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No Renkai agent config at ${configPath}. Run setup first.`);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export async function writeTextAtomic(filePath, text, mode = 0o600) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode, flag: "wx" });
  await rename(temporary, filePath);
  await chmod(filePath, mode);
}

export async function writeConfig(configPath, config) {
  return writeJsonAtomic(configPath, config);
}

export function safeProfile(config) {
  return {
    walletAddress: config.walletAddress,
    baseUrl: config.baseUrl,
    registered: Boolean(config.agentKey),
    referredBy: config.referral?.referrerPlayerId ?? null,
    legacyMigrationRequired: Boolean(config.legacyMigrationRequired),
    setupStatus: config.agentKey ? "ready" : "wallet_only",
  };
}
