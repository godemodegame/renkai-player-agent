import { agentRequest } from "./api.mjs";
import { runDurableMutation } from "./mutations.mjs";

const STATS = new Set(["strength", "defence", "luck", "intelligence"]);

function validationError(message) {
  const error = new Error(message);
  error.code = "VALIDATION_ERROR";
  return error;
}

function parseStat(value) {
  if (typeof value !== "string" || !STATS.has(value)) {
    throw validationError("stats allocate requires --stat strength, defence, luck, or intelligence.");
  }
  return value;
}

function parsePoints(value) {
  if (value === undefined) return 1;
  if ((typeof value !== "string" && typeof value !== "number") || !/^\d+$/.test(String(value))) {
    throw validationError("--points must be a positive integer.");
  }
  const points = Number(value);
  if (!Number.isSafeInteger(points) || points < 1) throw validationError("--points must be a positive integer.");
  return points;
}

function requireConfirmation(flags, stat, points) {
  const target = `${stat}:${points}`;
  if (flags.confirm !== target) throw new Error(`stats allocate requires --confirm ${target} exactly matching the stat spend.`);
}

function validateResponse(value, stat, points) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.stat !== stat || value.points !== points
    || !Number.isFinite(value.costGold) || value.costGold < 0) {
    const error = new Error("Renkai returned an invalid stats allocation response.");
    error.code = "API_RESPONSE_INVALID";
    throw error;
  }
  return value;
}

export async function allocateStats(config, flags = {}, options = {}) {
  const stat = parseStat(flags.stat);
  const points = parsePoints(flags.points);
  requireConfirmation(flags, stat, points);
  const request = options.request ?? agentRequest;
  const operation = JSON.stringify({ method: "POST", path: "/api/player/stats/allocate", body: { stat, points } });
  return runDurableMutation(options.configPath, operation, async (idempotencyKey) => {
    const result = await request(config, "POST", "/api/player/stats/allocate", { stat, points }, { idempotent: true, idempotencyKey });
    return validateResponse(result, stat, points);
  }, options.onResult);
}

export const allocateStat = allocateStats;
