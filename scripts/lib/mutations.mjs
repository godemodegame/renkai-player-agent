import { randomUUID } from "node:crypto";
import {
  acquireNotificationLock,
  readPrivateJson,
  releaseNotificationLock,
  writeJsonAtomic,
} from "./config.mjs";

export function mutationStatePath(configPath) {
  return `${configPath}.mutations.json`;
}

function emptyMutationState() {
  return { version: 1, pending: null };
}

function normalizeMutationState(value) {
  if (!value || value.version !== 1 || !(value.pending === null
    || (typeof value.pending === "object" && typeof value.pending.operation === "string"
      && typeof value.pending.idempotencyKey === "string"))) {
    const error = new Error("Renkai mutation state is malformed.");
    error.code = "MUTATION_STATE_INVALID";
    throw error;
  }
  return value.pending === null
    ? emptyMutationState()
    : { version: 1, pending: { operation: value.pending.operation, idempotencyKey: value.pending.idempotencyKey } };
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
  return status >= 400 && status < 500 && status !== 408 && error?.code !== "IDEMPOTENCY_IN_FLIGHT";
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
    const pending = state.pending ?? { operation, idempotencyKey: randomUUID() };
    if (!state.pending) await writeJsonAtomic(statePath, { version: 1, pending });
    try {
      const result = await execute(pending.idempotencyKey);
      if (onResult) await onResult(result);
      await writeJsonAtomic(statePath, emptyMutationState());
      return result;
    } catch (error) {
      if (definitelyNotCommitted(error)) await writeJsonAtomic(statePath, emptyMutationState());
      throw error;
    }
  } finally {
    await releaseNotificationLock(lock);
  }
}
