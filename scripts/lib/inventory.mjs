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

export async function readInventory(config, flags = {}, options = {}) {
  const path = inventoryPath(flags);
  return requestFrom(options)(config, "GET", path);
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
