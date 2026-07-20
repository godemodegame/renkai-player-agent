import { agentRequest } from "./api.mjs";

function required(flags, name, message) {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(message ?? `--${name} is required.`);
  return value;
}

function confirm(flags, value, action) {
  if (flags.confirm !== value) throw new Error(`${action} requires --confirm ${value} exactly matching the requested action.`);
}

export function playerState(config) {
  return agentRequest(config, "GET", "/api/player/state");
}

export function listQuests(config) {
  return agentRequest(config, "GET", "/api/quests");
}

export async function selectBranch(config, flags = {}) {
  const branch = required(flags, "branch", "player branch set requires --branch fighter or laborer.");
  if (!["fighter", "laborer"].includes(branch)) throw new Error("--branch must be fighter or laborer.");
  confirm(flags, branch, "player branch set");
  return agentRequest(config, "POST", "/api/player/branch", { branch }, { idempotent: true, idempotencyKey: flags["idempotency-key"] });
}

export async function selectClass(config, flags = {}) {
  const playerClass = required(flags, "class", "player class set requires --class attacker, defender, blacksmith, or miner.");
  if (!["attacker", "defender", "blacksmith", "miner"].includes(playerClass)) throw new Error("--class must be attacker, defender, blacksmith, or miner.");
  confirm(flags, playerClass, "player class set");
  return agentRequest(config, "POST", "/api/player/class", { class: playerClass }, { idempotent: true, idempotencyKey: flags["idempotency-key"] });
}

export async function startQuest(config, flags = {}) {
  const questId = required(flags, "quest-id", "quest start requires --quest-id <questId>.");
  confirm(flags, questId, "quest start");
  return agentRequest(config, "POST", "/api/quest/start", { questId }, { idempotent: true, idempotencyKey: flags["idempotency-key"] });
}

export function warState(config) {
  return agentRequest(config, "GET", "/api/war/state");
}

export async function pledgeWar(config, flags = {}) {
  const role = required(flags, "role", "war pledge requires --role defend or attack.");
  if (!["defend", "attack"].includes(role)) throw new Error("--role must be defend or attack.");
  const target = flags.target;
  if (role === "attack" && (typeof target !== "string" || target.length === 0)) throw new Error("war pledge attack requires --target <castle>.");
  if (role === "defend" && target) throw new Error("war pledge defend does not accept --target.");
  const confirmation = role === "attack" ? `${role}:${target}` : role;
  confirm(flags, confirmation, "war pledge");
  return agentRequest(config, "POST", "/api/war/pledge", { role, ...(target ? { targetCastleId: target } : {}) }, { idempotent: true, idempotencyKey: flags["idempotency-key"] });
}

export async function clearWarPledge(config, flags = {}) {
  confirm(flags, "clear", "war pledge-clear");
  return agentRequest(config, "DELETE", "/api/war/pledge", undefined, { idempotent: true, idempotencyKey: flags["idempotency-key"] });
}
