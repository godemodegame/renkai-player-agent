import { agentRequest } from "./api.mjs";
import { writeConfig } from "./config.mjs";
import {
  BATTLE_MODES,
  BRANCH_BY_DIRECTION,
  RESOURCE_CASTLE,
  WAR_RESERVE_MS,
  battleWindowContext,
  chooseQuestArchetype,
  cycleTarget,
} from "./strategy.mjs";

function normalizeBattleMode(mode) {
  return mode?.replaceAll("-", "_");
}

function battleBody(mode, targetCastleId) {
  const normalized = normalizeBattleMode(mode);
  if (!BATTLE_MODES.has(normalized)) throw new Error("--mode must be defend, attack-fixed, or attack-cycle.");
  if (normalized === "attack_fixed" && !targetCastleId) throw new Error("attack-fixed requires --battle-target/--target <castle>.");
  if (normalized !== "attack_fixed" && targetCastleId) throw new Error("A battle target is valid only for attack-fixed.");
  return { mode: normalized, ...(targetCastleId ? { targetCastleId } : {}) };
}

export async function setBattlePolicy(configPath, config, mode, targetCastleId) {
  const body = battleBody(mode, targetCastleId);
  const result = await agentRequest(config, "POST", "/api/war/policy", body, { idempotent: true });
  config.battle = { mode: body.mode, targetCastleId: body.targetCastleId ?? null, updatedAt: result.policy.updatedAt };
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  return result;
}

export async function clearBattlePolicy(configPath, config) {
  const result = await agentRequest(config, "DELETE", "/api/war/policy", undefined, { idempotent: true });
  config.battle = null;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  return result;
}

export async function setNextBattle(config, mode, targetCastleId) {
  const instruction = battleBody(mode, targetCastleId);
  const [warState, playerState] = await Promise.all([
    agentRequest(config, "GET", "/api/war/state"),
    agentRequest(config, "GET", "/api/player/state"),
  ]);
  throwIfPlayerLocked(playerState);
  const pledge = desiredPledge(instruction, playerState.player.castleId, warState.nextWarAt);
  const state = await agentRequest(config, "POST", "/api/war/pledge", pledge, { idempotent: true });
  return { scope: "next_battle", instruction, pledge, state };
}

export async function clearNextBattle(config) {
  throwIfPlayerLocked(await agentRequest(config, "GET", "/api/player/state"));
  const state = await agentRequest(config, "DELETE", "/api/war/pledge", undefined, { idempotent: true });
  return { scope: "next_battle", instruction: null, state };
}

function desiredPledge(policy, playerCastleId, nextWarAt) {
  if (policy.mode === "defend") return { role: "defend", targetCastleId: playerCastleId };
  if (policy.mode === "attack_fixed") return { role: "attack", targetCastleId: policy.targetCastleId };
  return { role: "attack", targetCastleId: cycleTarget(playerCastleId, nextWarAt) };
}

function playerLock(playerState) {
  const status = playerState.player.status;
  if (!playerState.activeQuestAction && typeof status === "string" && (status === "idle" || status === "rest")) return null;
  return {
    status: typeof status === "string" ? status : "unknown",
    retryAt: playerState.activeQuestAction?.lockedUntil ?? playerState.player.lockedUntil,
  };
}

function throwIfPlayerLocked(playerState) {
  const lock = playerLock(playerState);
  if (!lock) return;
  const error = new Error("The player is currently locked by another action.");
  error.code = "PLAYER_LOCKED";
  error.retryAt = lock.retryAt;
  error.details = { status: lock.status };
  throw error;
}

async function ensureBattlePledge(configPath, config, warState, nowMs, request = agentRequest) {
  if (!warState.policy) {
    const error = new Error("No all-battles policy is configured.");
    error.code = "NO_BATTLE_INSTRUCTION";
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
    const error = new Error(`The opted-in all-battles pledge was not installed before lock for ${warState.nextWindowId}.`);
    error.code = "BATTLE_PLEDGE_MISSED";
    throw error;
  }
  const lock = playerLock(playerState);
  if (lock) {
    return {
      action: "retry",
      windowId: warState.nextWindowId,
      retryAt: lock.retryAt,
      reason: "PLAYER_LOCKED",
    };
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
      const missed = new Error(`The opted-in all-battles pledge could not be verified before lock for ${localWindow.windowId}: ${error.message}`);
      missed.code = "BATTLE_PLEDGE_MISSED";
      throw missed;
    }
  }
  const reserveAt = Date.parse(warState.nextWarAt) - WAR_RESERVE_MS;
  if (nowMs < reserveAt || nowMs >= Date.parse(warState.nextWarAt)) {
    return { action: "outside_reserve", nextReserveAt: new Date(reserveAt).toISOString() };
  }
  if (!warState.policy) {
    return {
      action: warState.pledge ? "next_battle_ready" : "no_battle_instruction",
      windowId: warState.nextWindowId,
      pledge: warState.pledge ?? null,
      nextWarAt: warState.nextWarAt,
    };
  }
  try {
    return await ensureBattlePledge(configPath, config, warState, nowMs, request);
  } catch (error) {
    if (nowMs < Date.parse(warState.pledgeLockedAt)) {
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
    const missed = new Error(`The opted-in all-battles pledge could not be verified before lock for ${warState.nextWindowId}: ${error.message}`);
    missed.code = "BATTLE_PLEDGE_MISSED";
    throw missed;
  }
}

export async function takeStep(configPath, config) {
  const nowMs = Date.now();
  const warState = await agentRequest(config, "GET", "/api/war/state");
  const state = await agentRequest(config, "GET", "/api/player/state");
  const player = state.player;
  const desiredClass = config.profile.direction;
  const desiredBranch = BRANCH_BY_DIRECTION[desiredClass];
  const progressionPending = player.level >= 5 && !player.branch
    ? { selection: "branch", value: desiredBranch, requiredGold: 50, currentGold: player.gold }
    : player.level >= 15 && player.branch && !player.class
      ? { selection: "class", value: desiredClass, requiredGold: 100, currentGold: player.gold }
      : undefined;
  const inReserve = nowMs >= Date.parse(warState.nextWarAt) - WAR_RESERVE_MS && nowMs < Date.parse(warState.nextWarAt);
  if (warState.policy && inReserve) {
    const battle = await ensureBattlePledge(configPath, config, warState, nowMs);
    return { ...battle, action: battle.action === "retry" ? "wait" : battle.action, reason: "all_battles_reserve", retryAt: warState.nextWarAt };
  }
  if (warState.pledge && inReserve) {
    return { action: "wait", reason: "next_battle_reserved", pledge: warState.pledge, retryAt: warState.nextWarAt };
  }
  if (state.activeQuestAction) {
    return { action: "wait", reason: "quest_in_progress", quest: state.activeQuestAction.questName, retryAt: state.activeQuestAction.lockedUntil };
  }
  if (player.status !== "idle" && player.status !== "rest") {
    return { action: "wait", reason: "player_locked", status: player.status, retryAt: player.lockedUntil, progressionPending };
  }
  if (player.level >= 5 && !player.branch && player.gold >= 50) {
    return { action: "selected_branch", branch: desiredBranch, result: await agentRequest(config, "POST", "/api/player/branch", { branch: desiredBranch }, { idempotent: true }) };
  }
  if (player.level >= 15 && player.branch && !player.class && player.gold >= 100) {
    return { action: "selected_class", class: desiredClass, result: await agentRequest(config, "POST", "/api/player/class", { class: desiredClass }, { idempotent: true }) };
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
