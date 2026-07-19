import { agentRequest } from "./api.mjs";

const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 128;

function validationError(message) {
  const error = new Error(message);
  error.code = "VALIDATION_ERROR";
  return error;
}

function parseLimit(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT) return value;
  } else if (typeof value === "string" && /^(?:[1-9]\d?|100)$/.test(value)) {
    return Number(value);
  }
  throw validationError("--limit must be an integer from 1 to 100.");
}

function parseCursor(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH) return value;
  throw validationError("--cursor must be a non-empty opaque value no longer than 128 characters.");
}

export function parseInventoryFlags(flags = {}) {
  if (!flags || typeof flags !== "object" || Array.isArray(flags)) {
    throw validationError("Inventory flags must be an object.");
  }
  const limit = parseLimit(flags.limit);
  const cursor = parseCursor(flags.cursor);
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function inventoryPath(flags = {}) {
  const parsed = parseInventoryFlags(flags);
  const query = [];
  if (parsed.limit !== undefined) query.push(`limit=${parsed.limit}`);
  if (parsed.cursor !== undefined) query.push(`cursor=${encodeURIComponent(parsed.cursor)}`);
  return query.length ? `/api/inventory?${query.join("&")}` : "/api/inventory";
}

function requestFrom(options) {
  if (typeof options === "function") return options;
  return options?.request ?? agentRequest;
}

function invalidResponse() {
  const error = new Error("Renkai returned an invalid inventory response.");
  error.code = "API_RESPONSE_INVALID";
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value) {
  return value === null || isString(value);
}

function isNumberRecord(value) {
  return isRecord(value) && Object.entries(value).every(([key, amount]) => key.length > 0 && Number.isFinite(amount));
}

function isResource(item) {
  return isRecord(item) && isString(item.resourceId) && isString(item.category)
    && Number.isFinite(item.amount) && item.amount >= 0;
}

const GEAR_STATES = new Set(["mint_pending", "mint_failed_recoverable", "equipped", "attuned", "owned"]);

function isGear(item) {
  return isRecord(item) && isString(item.id) && isString(item.recipeId)
    && (item.name === null || isString(item.name)) && isString(item.slot) && isString(item.tier)
    && isNullableString(item.requiredBranch) && isNumberRecord(item.bonuses)
    && Number.isFinite(item.durability) && typeof item.attuned === "boolean"
    && typeof item.isEquipped === "boolean" && Number.isFinite(item.power)
    && isNullableString(item.mintAddress) && GEAR_STATES.has(item.state);
}

function validateInventory(value) {
  if (!isRecord(value) || !isString(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))
    || !isRecord(value.resources) || !Array.isArray(value.resources.items) || !value.resources.items.every(isResource)
    || !Number.isInteger(value.resources.totalCount) || value.resources.totalCount < value.resources.items.length
    || !isRecord(value.gear) || !Array.isArray(value.gear.items) || !value.gear.items.every(isGear)
    || !isNullableString(value.gear.nextCursor) || !isRecord(value.weight)
    || value.weight.system !== "castle_population" || !Number.isFinite(value.weight.activeWeight)
    || !(value.weight.capacityWeight === null || Number.isFinite(value.weight.capacityWeight))) {
    throw invalidResponse();
  }
  return value;
}

export async function readInventory(config, flags = {}, options = {}) {
  const path = inventoryPath(flags);
  return validateInventory(await requestFrom(options)(config, "GET", path));
}

export async function handleInventory(config, flags = {}, options = {}) {
  const result = await readInventory(config, flags, options);
  const print = typeof options === "object" && options !== null
    ? options.print ?? options.output
    : undefined;
  if (typeof print === "function") await print(result);
  return result;
}

export const inventory = handleInventory;
export const inventoryCommand = handleInventory;
