import { randomUUID } from "node:crypto";
import {
  acquireNotificationLock,
  readPrivateJson,
  releaseNotificationLock,
  writeJsonAtomic,
} from "./config.mjs";

const MUTATION_REPLAY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function mutationStatePath(configPath) {
  return `${configPath}.mutations.json`;
}

function emptyMutationState() {
  return { version: 1, pending: null };
}

function isTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function normalizeMutationState(value) {
  if (!value || value.version !== 1 || !(value.pending === null
    || (typeof value.pending === "object" && typeof value.pending.operation === "string" && value.pending.operation.length > 0
      && typeof value.pending.idempotencyKey === "string" && value.pending.idempotencyKey.length > 0
      && isTimestamp(value.pending.createdAt)))) {
    const error = new Error("Renkai mutation state is malformed.");
    error.code = "MUTATION_STATE_INVALID";
    throw error;
  }
  return value.pending === null
    ? emptyMutationState()
    : { version: 1, pending: {
      operation: value.pending.operation,
      idempotencyKey: value.pending.idempotencyKey,
      createdAt: value.pending.createdAt,
    } };
}

export async function readMutationState(configPath) {
  try {
    return normalizeMutationState(await readPrivateJson(mutationStatePath(configPath)));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyMutationState();
    throw error;
  }
}

function definitelyNotCommitted(error) {
  const status = Number(error?.status);
  return status >= 400 && status < 500 && status !== 408 && status !== 409
    && error?.code !== "IDEMPOTENCY_IN_FLIGHT";
}

export async function runDurableMutation(configPath, operation, execute, onResult) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    throw new TypeError("A config path is required for retry-safe mutations.");
  }
  const lock = await acquireNotificationLock(configPath);
  const statePath = mutationStatePath(configPath);
  try {
    const state = await readMutationState(configPath);
    if (state.pending && state.pending.operation !== operation) {
      const error = new Error("A prior mutation has an ambiguous result. Retry that exact command before starting another mutation.");
      error.code = "MUTATION_RETRY_REQUIRED";
      throw error;
    }
    if (state.pending && Date.now() - Date.parse(state.pending.createdAt) >= MUTATION_REPLAY_WINDOW_MS) {
      const error = new Error("This ambiguous mutation is too old to replay safely. Reconcile its server state before removing the private mutation sidecar.");
      error.code = "MUTATION_RETRY_EXPIRED";
      throw error;
    }
    const pending = state.pending ?? { operation, idempotencyKey: randomUUID(), createdAt: new Date().toISOString() };
    if (!state.pending) await writeJsonAtomic(statePath, { version: 1, pending });
    let result;
    try {
      result = await execute(pending.idempotencyKey);
    } catch (error) {
      if (definitelyNotCommitted(error)) await writeJsonAtomic(statePath, emptyMutationState());
      throw error;
    }
    if (onResult) await onResult(result);
    await writeJsonAtomic(statePath, emptyMutationState());
    return result;
  } finally {
    await releaseNotificationLock(lock).catch(() => {});
  }
}
