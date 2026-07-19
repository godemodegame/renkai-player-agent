const WAR_SLOT_MS = 8 * 60 * 60 * 1000;
export const WAR_RESERVE_MS = 20 * 60 * 1000;
const WAR_LOCK_MS = 5 * 60 * 1000;
const CASTLE_IDS = ["ashkeep", "thornmere", "gravehold", "nightglass_spire", "frostwound_bastion"];
export const DIRECTIONS = new Set(["attacker", "defender", "blacksmith", "miner"]);
export const BATTLE_MODES = new Set(["defend", "attack_fixed", "attack_cycle"]);
export const BRANCH_BY_DIRECTION = { attacker: "fighter", defender: "fighter", blacksmith: "laborer", miner: "laborer" };
const COMMON_RESOURCES = new Set(["iron", "wood", "herbs", "stone", "bone", "fur", "coal"]);
const CASTLE_RESOURCES = new Set(["ash_coal", "venom_sac", "grave_salt", "rune_dust", "frost_ore", "void_glass"]);
const RARE_RESOURCES = new Set(["relic_fragment", "shadow_thread", "old_blood", "royal_seal", "ancient_oath"]);
export const RESOURCE_CASTLE = {
  ash_coal: "ashkeep",
  venom_sac: "thornmere",
  grave_salt: "gravehold",
  rune_dust: "nightglass_spire",
  void_glass: "nightglass_spire",
  frost_ore: "frostwound_bastion",
  relic_fragment: "gravehold",
  shadow_thread: "nightglass_spire",
};

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
