#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api.renkai.xyz";
const WAITLIST_ACCESS = {
  x: "https://x.com/renkaigame",
  discord: "https://discord.gg/fGVDhhk9t",
};
const AUTOMATION_NAME = "renkai-mandatory-battles";
const WAR_SLOT_MS = 8 * 60 * 60 * 1000;
const WAR_RESERVE_MS = 20 * 60 * 1000;
const WAR_LOCK_MS = 5 * 60 * 1000;
const CASTLE_IDS = ["ashkeep", "thornmere", "gravehold", "nightglass_spire", "frostwound_bastion"];
const DIRECTIONS = new Set(["attacker", "defender", "blacksmith", "miner"]);
const BATTLE_MODES = new Set(["defend", "attack_fixed", "attack_cycle"]);
const BRANCH_BY_DIRECTION = { attacker: "fighter", defender: "fighter", blacksmith: "laborer", miner: "laborer" };
const COMMON_RESOURCES = new Set(["iron", "wood", "herbs", "stone", "bone", "fur", "coal"]);
const CASTLE_RESOURCES = new Set(["ash_coal", "venom_sac", "grave_salt", "rune_dust", "frost_ore", "void_glass"]);
const RARE_RESOURCES = new Set(["relic_fragment", "shadow_thread", "old_blood", "royal_seal", "ancient_oath"]);
const RESOURCE_CASTLE = {
  ash_coal: "ashkeep",
  venom_sac: "thornmere",
  grave_salt: "gravehold",
  rune_dust: "nightglass_spire",
  void_glass: "nightglass_spire",
  frost_ore: "frostwound_bastion",
  relic_fragment: "gravehold",
  shadow_thread: "nightglass_spire",
};
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length === 0) return "";
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(leadingZeroes) + encoded;
}

export function createWallet() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    walletAddress: base58Encode(publicDer.subarray(publicDer.length - 32)),
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function buildSignatureMessage(method, path, body, timestamp, nonce) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
}

export function signRequest(config, method, path, body = "") {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const privateKey = createPrivateKey({
    key: Buffer.from(config.privateKeyPkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = base58Encode(sign(null, Buffer.from(buildSignatureMessage(method, path, body, timestamp, nonce)), privateKey));
  return {
    "X-Agent-Wallet": config.walletAddress,
    "X-Agent-Timestamp": timestamp,
    "X-Agent-Nonce": nonce,
    "X-Agent-Signature": signature,
  };
}

export function chooseQuestArchetype(profile) {
  const focus = profile.resources ?? [];
  if (focus.some((value) => value === "rare" || RARE_RESOURCES.has(value))) return "scouting";
  if (focus.some((value) => value === "castle" || CASTLE_RESOURCES.has(value))) return "forbidden_expedition";
  if (focus.some((value) => value === "common" || COMMON_RESOURCES.has(value))) return "gathering";
  if (profile.goal === "xp" || profile.goal === "gold") return "forbidden_expedition";
  if (profile.goal === "resources") return "gathering";
  return "scouting";
}

export function battleWindowContext(nowMs = Date.now()) {
  const scheduledAtMs = Math.floor(nowMs / WAR_SLOT_MS + 1) * WAR_SLOT_MS;
  return {
    windowId: `war_${new Date(scheduledAtMs).toISOString().slice(0, 13).replace(/[-T:]/g, "_")}00`,
    scheduledAt: new Date(scheduledAtMs).toISOString(),
    reserveAt: new Date(scheduledAtMs - WAR_RESERVE_MS).toISOString(),
    pledgeLockedAt: new Date(scheduledAtMs - WAR_LOCK_MS).toISOString(),
    inReserve: nowMs >= scheduledAtMs - WAR_RESERVE_MS && nowMs < scheduledAtMs,
    locked: nowMs >= scheduledAtMs - WAR_LOCK_MS,
  };
}

export function cycleTarget(ownCastleId, scheduledAt) {
  const candidates = CASTLE_IDS.filter((castleId) => castleId !== ownCastleId);
  if (!candidates.length) throw new Error("No foreign castle is available for attack_cycle.");
  const slot = Math.floor(Date.parse(scheduledAt) / WAR_SLOT_MS);
  return candidates[((slot % candidates.length) + candidates.length) % candidates.length];
}

function defaultConfigPath() {
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Renkai", "agent.json");
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "renkai", "agent.json");
  return join(homedir(), ".config", "renkai", "agent.json");
}

function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  let subcommand;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      if (subcommand) throw new Error(`Unexpected argument: ${token}`);
      subcommand = token;
      continue;
    }
    const key = token.slice(2);
    if (key === "offline" || key === "quiet") {
      flags[key] = true;
      continue;
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
    index += 1;
  }
  return { command, subcommand, flags };
}

function configPathFrom(flags) {
  const candidate = flags.config ?? process.env.RENKAI_CONFIG ?? defaultConfigPath();
  return isAbsolute(candidate) ? candidate : resolve(candidate);
}

function emptyAutomation() {
  return {
    runtime: null,
    jobId: null,
    lastRunAt: null,
    lastPledgedWindowId: null,
    lastAlertedWindowId: null,
    notification: null,
  };
}

function migrateConfig(config) {
  if (!config.walletAddress || !config.privateKeyPkcs8) throw new Error("Renkai config is missing wallet credentials.");
  if (config.version !== 2) {
    config.version = 2;
    config.battle ??= null;
    config.automation ??= emptyAutomation();
  }
  config.automation = { ...emptyAutomation(), ...(config.automation ?? {}) };
  config.referral ??= null;
  return config;
}

async function readConfig(configPath) {
  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8"));
    const needsMigration = parsed.version !== 2;
    const config = migrateConfig(parsed);
    if (needsMigration) await writeConfig(configPath, config);
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`No Renkai agent config at ${configPath}. Run setup first.`);
    throw error;
  }
}

async function writeConfig(configPath, config) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, configPath);
  await chmod(configPath, 0o600);
}

function safeProfile(config) {
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
    setupStatus: config.battle && config.automation.jobId && config.automation.lastRunAt ? "ready" : "battle_setup_required",
  };
}

async function parseResponse(response) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const code = payload?.error?.code ?? (response.status === 404 ? "API_NOT_DEPLOYED" : `HTTP_${response.status}`);
    const message = payload?.error?.message ?? (response.status === 404
      ? "This Renkai deployment does not expose the requested Agent API route yet."
      : text.slice(0, 200) || response.statusText);
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.retryAt = payload?.error?.retryAt;
    error.details = payload?.error?.details;
    throw error;
  }
  return payload?.data ?? payload;
}

async function unsignedGet(baseUrl, path) {
  return parseResponse(await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10_000) }));
}

async function agentRequest(config, method, path, bodyValue, options = {}) {
  if (options.requireKey !== false && !config.agentKey) throw new Error("The wallet is not registered. Run register first.");
  const body = bodyValue === undefined ? "" : JSON.stringify(bodyValue);
  const headers = signRequest(config, method, path, body);
  if (config.agentKey) headers["X-Agent-Key"] = config.agentKey;
  if (bodyValue !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotent) headers["X-Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  return parseResponse(await fetch(new URL(path, config.baseUrl), {
    method,
    headers,
    body: bodyValue === undefined ? undefined : body,
    signal: AbortSignal.timeout(15_000),
  }));
}

function normalizeBattleMode(mode) {
  return mode?.replaceAll("-", "_");
}

function battleBody(mode, targetCastleId) {
  const normalized = normalizeBattleMode(mode);
  if (!BATTLE_MODES.has(normalized)) throw new Error("--battle-mode/--mode must be defend, attack-fixed, or attack-cycle.");
  if (normalized === "attack_fixed" && !targetCastleId) throw new Error("attack-fixed requires --battle-target/--target <castle>.");
  if (normalized !== "attack_fixed" && targetCastleId) throw new Error("A battle target is valid only for attack-fixed.");
  return { mode: normalized, ...(targetCastleId ? { targetCastleId } : {}) };
}

export function parseReferralInput(input) {
  if (!input) throw new Error("--referral is required; paste an app.renkai.xyz referral link or use --referral none.");
  if (["none", "no", "нет"].includes(input.trim().toLowerCase())) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Referral must be an https://app.renkai.xyz link or none.");
  }
  if (url.origin !== "https://app.renkai.xyz") {
    throw new Error("Only referral links from https://app.renkai.xyz are accepted.");
  }
  const referrerPlayerId = url.searchParams.get("ref") ?? "";
  if (!referrerPlayerId) throw new Error("The referral link has no ref query parameter.");
  if (!referrerPlayerId || referrerPlayerId.length > 64 || !/^player_[A-Za-z0-9_-]+$/.test(referrerPlayerId)) {
    throw new Error("Referral link must contain ?ref=player_... or use none.");
  }
  return { referrerPlayerId, providedAs: "link" };
}

export function registrationRequestBody(config) {
  const creating = !config.agentKey;
  return {
    action: creating ? "create" : "rotate",
    label: "renkai-player",
    ...(creating && config.referral?.referrerPlayerId
      ? { referrerPlayerId: config.referral.referrerPlayerId }
      : {}),
  };
}

async function register(configPath, config) {
  let result;
  try {
    result = await agentRequest(
      config,
      "POST",
      "/api/agent/key",
      registrationRequestBody(config),
      { requireKey: false, idempotent: true },
    );
  } catch (error) {
    if (error.code !== "FORBIDDEN") throw error;
    error.code = "WAITLIST_REQUIRED";
    error.message = "This agent wallet is not approved yet. Renkai requires waitlist access; request it through Discord or X, then rerun register.";
    error.waitlist = {
      walletAddress: config.walletAddress,
      discord: WAITLIST_ACCESS.discord,
      x: WAITLIST_ACCESS.x,
    };
    throw error;
  }
  if (!result?.agentKey?.apiKey) throw new Error("The API did not return the one-time agent key. Run register again to rotate it.");
  config.agentKey = result.agentKey.apiKey;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  return { walletAddress: config.walletAddress, registered: true, keyStored: true };
}

async function setBattlePolicy(configPath, config, mode, targetCastleId) {
  const body = battleBody(mode, targetCastleId);
  const result = await agentRequest(config, "POST", "/api/war/policy", body, { idempotent: true });
  config.battle = { mode: body.mode, targetCastleId: body.targetCastleId ?? null, updatedAt: result.policy.updatedAt };
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  return result;
}

async function setup(configPath, flags) {
  const direction = flags.direction;
  if (!DIRECTIONS.has(direction)) throw new Error("--direction must be attacker, defender, blacksmith, or miner.");
  const resources = (flags.resources ?? "common").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const goal = flags.goal ?? "balanced";
  const requestedBaseUrl = flags["base-url"] ? new URL(flags["base-url"]).origin : null;
  const desiredBattle = battleBody(flags["battle-mode"], flags["battle-target"]);
  const desiredReferral = parseReferralInput(flags.referral);
  let config;
  let walletCreated = false;
  try {
    config = await readConfig(configPath);
  } catch (error) {
    if (!String(error.message).startsWith("No Renkai agent config")) throw error;
    config = {
      version: 2,
      ...createWallet(),
      baseUrl: requestedBaseUrl ?? DEFAULT_BASE_URL,
      profile: { direction, resources, goal },
      battle: { mode: desiredBattle.mode, targetCastleId: desiredBattle.targetCastleId ?? null },
      referral: desiredReferral,
      automation: emptyAutomation(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    walletCreated = true;
  }
  config.version = 2;
  if (config.agentKey && config.referral?.referrerPlayerId !== desiredReferral?.referrerPlayerId) {
    throw new Error("Referral attribution is immutable after agent registration. Keep the original referral choice.");
  }
  config.baseUrl = requestedBaseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL;
  config.profile = { direction, resources, goal };
  config.battle = { mode: desiredBattle.mode, targetCastleId: desiredBattle.targetCastleId ?? null };
  config.referral = desiredReferral;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  if (flags.offline) return { ...safeProfile(config), walletCreated, registration: "skipped" };
  try {
    const registration = config.agentKey ? { registered: true, keyStored: true } : await register(configPath, config);
    const policy = await setBattlePolicy(configPath, config, desiredBattle.mode, desiredBattle.targetCastleId);
    return { ...safeProfile(config), walletCreated, ...registration, policy, setupStatus: "battle_setup_required" };
  } catch (error) {
    error.publicContext = { ...safeProfile(config), walletCreated, configSaved: true };
    throw error;
  }
}

function desiredPledge(policy, playerCastleId, nextWarAt) {
  if (policy.mode === "defend") return { role: "defend", targetCastleId: playerCastleId };
  if (policy.mode === "attack_fixed") return { role: "attack", targetCastleId: policy.targetCastleId };
  return { role: "attack", targetCastleId: cycleTarget(playerCastleId, nextWarAt) };
}

async function ensureBattlePledge(configPath, config, warState, nowMs, request = agentRequest) {
  if (!warState.policy) {
    const error = new Error("A mandatory battle policy is not configured. Run battle-policy set.");
    error.code = "BATTLE_SETUP_REQUIRED";
    throw error;
  }
  const playerState = await request(config, "GET", "/api/player/state");
  const desired = desiredPledge(warState.policy, playerState.player.castleId, warState.nextWarAt);
  if (warState.pledge?.role === desired.role && warState.pledge?.targetCastleId === desired.targetCastleId) {
    config.automation.lastRunAt = new Date(nowMs).toISOString();
    config.automation.lastPledgedWindowId = warState.nextWindowId;
    await writeConfig(configPath, config);
    return { action: "pledge_ready", windowId: warState.nextWindowId, pledge: desired, nextWarAt: warState.nextWarAt };
  }
  if (nowMs >= Date.parse(warState.pledgeLockedAt)) {
    if (config.automation.lastAlertedWindowId === warState.nextWindowId) {
      return { action: "already_alerted", windowId: warState.nextWindowId };
    }
    config.automation.lastAlertedWindowId = warState.nextWindowId;
    config.automation.lastRunAt = new Date(nowMs).toISOString();
    await writeConfig(configPath, config);
    const error = new Error(`Mandatory Renkai pledge was not installed before lock for ${warState.nextWindowId}.`);
    error.code = "BATTLE_PLEDGE_MISSED";
    throw error;
  }
  try {
    await request(config, "POST", "/api/war/pledge", desired, { idempotent: true });
    config.automation.lastPledgedWindowId = warState.nextWindowId;
    config.automation.lastAlertedWindowId = null;
    config.automation.lastRunAt = new Date(nowMs).toISOString();
    await writeConfig(configPath, config);
    return { action: "pledged", windowId: warState.nextWindowId, pledge: desired, nextWarAt: warState.nextWarAt };
  } catch (error) {
    if (error.code === "PLAYER_LOCKED" || error.code === "WAR_PLEDGE_LOCKED" || error.status >= 500) {
      config.automation.lastRunAt = new Date(nowMs).toISOString();
      await writeConfig(configPath, config);
      return { action: "retry", windowId: warState.nextWindowId, retryAt: warState.pledgeLockedAt, reason: error.code };
    }
    throw error;
  }
}

export async function battleTick(configPath, config, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const localWindow = battleWindowContext(nowMs);
  if (!localWindow.inReserve && !options.force) return { action: "outside_reserve", nextReserveAt: localWindow.reserveAt };
  const request = options.request ?? agentRequest;
  let warState = options.warState;
  if (!warState) {
    try {
      warState = await request(config, "GET", "/api/war/state");
    } catch (error) {
      if (!localWindow.locked) return { action: "retry", windowId: localWindow.windowId, retryAt: localWindow.pledgeLockedAt, reason: error.code ?? "TEMPORARY_ERROR" };
      if (config.automation.lastAlertedWindowId === localWindow.windowId) return { action: "already_alerted", windowId: localWindow.windowId };
      config.automation.lastAlertedWindowId = localWindow.windowId;
      config.automation.lastRunAt = new Date(nowMs).toISOString();
      await writeConfig(configPath, config);
      const missed = new Error(`Mandatory Renkai pledge could not be verified before lock for ${localWindow.windowId}: ${error.message}`);
      missed.code = "BATTLE_PLEDGE_MISSED";
      throw missed;
    }
  }
  const reserveAt = Date.parse(warState.nextWarAt) - WAR_RESERVE_MS;
  if (nowMs < reserveAt || nowMs >= Date.parse(warState.nextWarAt)) {
    return { action: "outside_reserve", nextReserveAt: new Date(reserveAt).toISOString() };
  }
  try {
    return await ensureBattlePledge(configPath, config, warState, nowMs, request);
  } catch (error) {
    if (nowMs < Date.parse(warState.pledgeLockedAt)) {
      if (error.code === "BATTLE_SETUP_REQUIRED") {
        if (config.automation.lastAlertedWindowId === warState.nextWindowId) return { action: "already_alerted", windowId: warState.nextWindowId };
        config.automation.lastAlertedWindowId = warState.nextWindowId;
        config.automation.lastRunAt = new Date(nowMs).toISOString();
        await writeConfig(configPath, config);
        throw error;
      }
      config.automation.lastRunAt = new Date(nowMs).toISOString();
      await writeConfig(configPath, config);
      return { action: "retry", windowId: warState.nextWindowId, retryAt: warState.pledgeLockedAt, reason: error.code ?? "TEMPORARY_ERROR" };
    }
    if (error.code === "BATTLE_PLEDGE_MISSED") throw error;
    if (config.automation.lastAlertedWindowId === warState.nextWindowId) {
      return { action: "already_alerted", windowId: warState.nextWindowId };
    }
    config.automation.lastAlertedWindowId = warState.nextWindowId;
    config.automation.lastRunAt = new Date(nowMs).toISOString();
    await writeConfig(configPath, config);
    const missed = new Error(`Mandatory Renkai pledge could not be verified before lock for ${warState.nextWindowId}: ${error.message}`);
    missed.code = "BATTLE_PLEDGE_MISSED";
    throw missed;
  }
}

async function takeStep(configPath, config) {
  const nowMs = Date.now();
  const warState = await agentRequest(config, "GET", "/api/war/state");
  if (!warState.policy) return { action: "battle_setup_required", reason: "missing_policy" };
  if (nowMs >= Date.parse(warState.nextWarAt) - WAR_RESERVE_MS && nowMs < Date.parse(warState.nextWarAt)) {
    const battle = await ensureBattlePledge(configPath, config, warState, nowMs);
    return { ...battle, action: battle.action === "retry" ? "wait" : battle.action, reason: "mandatory_battle_reserve", retryAt: warState.nextWarAt };
  }
  const state = await agentRequest(config, "GET", "/api/player/state");
  const player = state.player;
  if (state.activeQuestAction) {
    return { action: "wait", reason: "quest_in_progress", quest: state.activeQuestAction.questName, retryAt: state.activeQuestAction.lockedUntil };
  }
  const desiredClass = config.profile.direction;
  const desiredBranch = BRANCH_BY_DIRECTION[desiredClass];
  if (player.level >= 5 && !player.branch && player.gold >= 50) {
    return { action: "selected_branch", branch: desiredBranch, result: await agentRequest(config, "POST", "/api/player/branch", { branch: desiredBranch }, { idempotent: true }) };
  }
  if (player.level >= 15 && player.branch && !player.class && player.gold >= 100) {
    return { action: "selected_class", class: desiredClass, result: await agentRequest(config, "POST", "/api/player/class", { class: desiredClass }, { idempotent: true }) };
  }
  const progressionPending = player.level >= 5 && !player.branch
    ? { selection: "branch", value: desiredBranch, requiredGold: 50, currentGold: player.gold }
    : player.level >= 15 && player.branch && !player.class
      ? { selection: "class", value: desiredClass, requiredGold: 100, currentGold: player.gold }
      : undefined;
  if (player.status !== "idle" && player.status !== "rest") {
    return { action: "wait", reason: "player_locked", status: player.status, retryAt: player.lockedUntil, progressionPending };
  }
  if (player.currentStamina < 1) return { action: "wait", reason: "no_stamina", retryAt: player.nextStaminaAt, progressionPending };
  const questData = await agentRequest(config, "GET", "/api/quests");
  const preferredArchetype = chooseQuestArchetype(config.profile);
  const quest = questData.quests.find((candidate) => candidate.archetype === preferredArchetype) ?? questData.quests[0];
  if (!quest) return { action: "wait", reason: "no_available_quests" };
  const started = await agentRequest(config, "POST", "/api/quest/start", { questId: quest.id }, { idempotent: true });
  const incompatibleResources = (config.profile.resources ?? []).filter((resource) => RESOURCE_CASTLE[resource] && RESOURCE_CASTLE[resource] !== player.castleId);
  return {
    action: "started_quest",
    quest: { id: quest.id, name: quest.name, archetype: quest.archetype },
    retryAt: started.questAction.lockedUntil,
    progressionPending,
    resourceFocusWarning: incompatibleResources.length
      ? `The assigned castle ${player.castleId} does not directly favor: ${incompatibleResources.join(", ")}.`
      : undefined,
  };
}

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

export async function automationStatus(config, options = {}) {
  const runner = options.runner ?? runRuntimeCommand;
  if (!config.automation.runtime) return { installed: false, runtime: null, jobId: null };
  try {
    const output = runtimeList(config.automation.runtime, runner);
    return {
      installed: output.includes(config.automation.jobId ?? AUTOMATION_NAME) || output.includes(AUTOMATION_NAME),
      runtime: config.automation.runtime,
      jobId: config.automation.jobId,
      lastRunAt: config.automation.lastRunAt,
    };
  } catch (error) {
    return { installed: false, runtime: config.automation.runtime, jobId: config.automation.jobId, error: error.message };
  }
}

export async function installAutomation(configPath, config, runtime, flags, options = {}) {
  if (runtime !== "hermes" && runtime !== "openclaw") throw new Error("--runtime must be hermes or openclaw.");
  if (!config.agentKey || !config.battle) throw new Error("Register the wallet and set battle policy before installing automation.");
  const runner = options.runner ?? runRuntimeCommand;
  const notification = notificationFrom(flags, config.automation.notification);
  const existingList = runtimeList(runtime, runner);
  if (existingList.includes(AUTOMATION_NAME)) {
    config.automation.runtime = runtime;
    config.automation.jobId ??= AUTOMATION_NAME;
    config.automation.notification = notification;
    await writeConfig(configPath, config);
    return { installed: true, duplicate: false, existing: true, runtime, jobId: config.automation.jobId };
  }

  let creation;
  if (runtime === "hermes") {
    const scriptsDir = options.hermesScriptsDir ?? join(homedir(), ".hermes", "scripts");
    const wrapperPath = join(scriptsDir, `${AUTOMATION_NAME}.sh`);
    await mkdir(scriptsDir, { recursive: true, mode: 0o700 });
    const cliPath = fileURLToPath(import.meta.url);
    const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
    await writeFile(wrapperPath, `#!/usr/bin/env bash\nexec ${quote(process.execPath)} ${quote(cliPath)} battle-tick --quiet --config ${quote(configPath)}\n`, { mode: 0o700 });
    await chmod(wrapperPath, 0o700);
    runner("/bin/bash", [wrapperPath]);
    creation = runner("hermes", [
      "cron", "create", "every 1m", "--no-agent", "--script", `${AUTOMATION_NAME}.sh`,
      "--deliver", hermesDelivery(notification), "--name", AUTOMATION_NAME,
    ]);
  } else {
    const argv = [process.execPath, fileURLToPath(import.meta.url), "battle-tick", "--quiet", "--config", configPath];
    creation = runner("openclaw", [
      "cron", "create", "* * * * *", "--name", AUTOMATION_NAME,
      "--command-argv", JSON.stringify(argv), "--tz", "UTC", "--exact",
      ...openClawDeliveryArgs(notification),
    ]);
  }
  const jobId = parseJobId(creation.stdout) ?? AUTOMATION_NAME;
  runner(runtime === "hermes" ? "hermes" : "openclaw", ["cron", "run", jobId, ...(runtime === "openclaw" ? ["--wait"] : [])]);
  config.automation = { ...config.automation, runtime, jobId, notification, lastRunAt: new Date().toISOString() };
  await writeConfig(configPath, config);
  return { installed: true, duplicate: false, existing: false, runtime, jobId, testRun: "passed" };
}

export async function repairAutomation(configPath, config, runtime, flags, options = {}) {
  const runner = options.runner ?? runRuntimeCommand;
  const selectedRuntime = runtime ?? config.automation.runtime;
  if (!selectedRuntime) throw new Error("--runtime must be hermes or openclaw.");
  try {
    runner(selectedRuntime, ["cron", "remove", config.automation.jobId ?? AUTOMATION_NAME]);
  } catch (error) {
    if (!/not found|unknown|no .*job/i.test(error.message)) throw error;
  }
  config.automation.jobId = null;
  return installAutomation(configPath, config, selectedRuntime, flags, options);
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
  const ready = Boolean(config?.agentKey && policy?.policy && scheduler.installed && config.automation.lastRunAt);
  return {
    baseUrl,
    health,
    configVersion: config?.version ?? null,
    agentApi: config?.agentKey ? "registered" : config ? "wallet_only" : "not_configured",
    policy: policy?.policy ?? null,
    scheduler,
    lastRunAt: config?.automation.lastRunAt ?? null,
    nextWarAt: war?.nextWarAt ?? battleWindowContext().scheduledAt,
    mandatoryBattleReady: ready,
    setupStatus: ready ? "ready" : "battle_setup_required",
  };
}

function print(value, quiet = false) {
  if (!quiet) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function help() {
  return {
    usage: "renkai.mjs <doctor|setup|register|profile|state|quests|step|battle-policy|battle-tick|automation> [subcommand] [options]",
    examples: [
      "renkai.mjs setup --direction miner --resources iron,coal --battle-mode defend --referral https://app.renkai.xyz/?ref=player_123",
      "renkai.mjs battle-policy set --mode attack-fixed --target thornmere",
      "renkai.mjs automation install --runtime hermes --notify-channel origin",
      "renkai.mjs automation repair --runtime openclaw --notify-channel telegram --notify-to 123456",
    ],
    referral: "Pass --referral <https://app.renkai.xyz/...?...ref=player_...>; use --referral none only when there is no referrer.",
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
  if (command === "step") return print(await takeStep(configPath, config));
  if (command === "battle-policy" && subcommand === "show") return print(await agentRequest(config, "GET", "/api/war/policy"));
  if (command === "battle-policy" && subcommand === "set") {
    return print(await setBattlePolicy(configPath, config, flags.mode, flags.target));
  }
  if (command === "battle-tick") return print(await battleTick(configPath, config), flags.quiet);
  if (command === "automation" && subcommand === "status") return print(await automationStatus(config));
  if (command === "automation" && subcommand === "install") {
    return print(await installAutomation(configPath, config, flags.runtime, flags));
  }
  if (command === "automation" && subcommand === "repair") {
    return print(await repairAutomation(configPath, config, flags.runtime, flags));
  }
  throw new Error(`Unknown command: ${command}${subcommand ? ` ${subcommand}` : ""}`);
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
    process.stderr.write(`${JSON.stringify(cliErrorOutput(error), null, 2)}\n`);
    process.exitCode = 1;
  });
}
