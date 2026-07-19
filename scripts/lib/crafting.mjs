import { agentRequest, agentRequestWithMetadata } from "./api.mjs";
import { runDurableMutation } from "./mutations.mjs";

function normalizeOptions(options) {
  if (typeof options === "function") return { request: options };
  return options && typeof options === "object" ? options : {};
}

function requestFor(options = {}, metadata = false) {
  if (metadata) return options.requestWithMetadata ?? options.agentRequestWithMetadata ?? options.request ?? options.agentRequest ?? agentRequestWithMetadata;
  return options.request ?? options.agentRequest ?? agentRequest;
}

function unwrapMetadata(result) {
  if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "data")) {
    return {
      data: result.data,
      nextRecommendedPollAt: result.nextRecommendedPollAt ?? null,
    };
  }
  return { data: result, nextRecommendedPollAt: null };
}

function requireRecipeId(flags = {}) {
  const recipeId = flags.recipe;
  if (typeof recipeId !== "string" || recipeId.length === 0) {
    throw new Error("crafting start requires --recipe <recipeId>.");
  }
  return recipeId;
}

function requireJobId(flags = {}, command) {
  const craftingJobId = flags.job;
  if (typeof craftingJobId !== "string" || craftingJobId.length === 0) {
    throw new Error(`crafting ${command} requires --job <craftingJobId>.`);
  }
  return craftingJobId;
}

function requireConfirmation(flags, target, command, targetName) {
  if (flags.confirm !== target) {
    throw new Error(`crafting ${command} requires --confirm <${targetName}> exactly matching --${targetName === "recipeId" ? "recipe" : "job"}.`);
  }
}

function invalidResponse(command) {
  const error = new Error(`Renkai returned an invalid crafting ${command} response.`);
  error.code = "API_RESPONSE_INVALID";
  return error;
}

function requireObject(value, command) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(command);
  return value;
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function isNullableString(value) {
  return value === null || isString(value);
}

function isTimestamp(value) {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNumberRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.entries(value).every(([key, amount]) => key.length > 0 && Number.isFinite(amount));
}

function isNonnegativeNumberRecord(value) {
  return isNumberRecord(value) && Object.values(value).every((amount) => amount >= 0);
}

function isRecipe(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && isString(value.id)
    && isNullableString(value.name)
    && isString(value.tier)
    && isString(value.slot)
    && isString(value.requiredStation)
    && Number.isInteger(value.requiredPlayerLevel) && value.requiredPlayerLevel >= 0
    && isNullableString(value.requiredCastleId)
    && ["fighter", "laborer", null].includes(value.requiredBranch)
    && Number.isInteger(value.durationSeconds) && value.durationSeconds > 0
    && Number.isFinite(value.gearPower)
    && isNumberRecord(value.bonuses)
    && Number.isFinite(value.costGold) && value.costGold >= 0
    && isNonnegativeNumberRecord(value.costResources);
}

const CRAFTING_JOB_STATUSES = new Set([
  "pending",
  "in_progress",
  "ready_to_claim",
  "mint_pending",
  "complete",
  "failed_recoverable",
  "cancelled",
]);

function isCraftingJob(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && isString(value.craftingJobId)
    && isString(value.recipeId)
    && CRAFTING_JOB_STATUSES.has(value.status)
    && isTimestamp(value.startedAt)
    && isTimestamp(value.readyAt)
    && (value.claimedAt === null || isTimestamp(value.claimedAt))
    && isNullableString(value.mintStatus)
    && isNullableString(value.mintError);
}

function validateRecipes(value) {
  const result = requireObject(value, "recipes");
  if (!Array.isArray(result.recipes) || !result.recipes.every(isRecipe)) throw invalidResponse("recipes");
  return result;
}

function validateJobs(value) {
  const result = requireObject(value, "jobs");
  if (!Array.isArray(result.jobs) || !result.jobs.every(isCraftingJob)) throw invalidResponse("jobs");
  return result;
}

function validateStart(value) {
  const result = requireObject(value, "start");
  if (!isString(result.craftingJobId) || !isTimestamp(result.readyAt)) throw invalidResponse("start");
  return result;
}

function validateCancel(value, craftingJobId) {
  const result = requireObject(value, "cancel");
  if (result.craftingJobId !== craftingJobId || result.status !== "cancelled") throw invalidResponse("cancel");
  return result;
}

function validateClaim(value, command) {
  const result = requireObject(value, command);
  if (!result.craft || typeof result.craft !== "object" || !isString(result.craft.gearItemId)
    || !["complete", "failed_recoverable"].includes(result.craft.mintStatus)
    || (result.craft.mintStatus === "complete" && !isString(result.craft.mintAddress))) throw invalidResponse(command);
  return result;
}

function mutationOperation(method, path, body) {
  return JSON.stringify({ method, path, body });
}

async function mutate(config, method, path, body, settings, validate, transform = (value) => value) {
  const request = requestFor(settings);
  return runDurableMutation(settings.configPath, mutationOperation(method, path, body), async (idempotencyKey) => {
    const result = await request(config, method, path, body, { idempotent: true, idempotencyKey });
    return transform(validate(result));
  }, settings.onResult);
}

export async function listCraftingRecipes(config, options = {}) {
  return validateRecipes(await requestFor(normalizeOptions(options))(config, "GET", "/api/crafting/recipes"));
}

export async function listCraftingJobs(config, options = {}) {
  const response = await requestFor(normalizeOptions(options), true)(config, "GET", "/api/crafting/jobs");
  const { data, nextRecommendedPollAt } = unwrapMetadata(response);
  const result = validateJobs(data);
  return {
    jobs: result.jobs,
    nextRecommendedPollAt,
  };
}

export async function startCrafting(config, flags = {}, options = {}) {
  const recipeId = requireRecipeId(flags);
  requireConfirmation(flags, recipeId, "start", "recipeId");
  const settings = normalizeOptions(options);
  return mutate(config, "POST", "/api/crafting/request", { recipeId }, settings, validateStart, (result) => ({
    ...result,
    nextRecommendedPollAt: result.readyAt,
  }));
}

export async function cancelCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "cancel");
  requireConfirmation(flags, craftingJobId, "cancel", "craftingJobId");
  const settings = normalizeOptions(options);
  return mutate(config, "POST", "/api/crafting/cancel", { craftingJobId }, settings, (value) => validateCancel(value, craftingJobId));
}

export async function claimCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "claim");
  requireConfirmation(flags, craftingJobId, "claim", "craftingJobId");
  const settings = normalizeOptions(options);
  return mutate(config, "POST", "/api/crafting/claim", { craftingJobId }, settings, (value) => validateClaim(value, "claim"));
}

export async function retryMintCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "retry-mint");
  requireConfirmation(flags, craftingJobId, "retry-mint", "craftingJobId");
  const settings = normalizeOptions(options);
  return mutate(config, "POST", "/api/crafting/retry-mint", { craftingJobId }, settings, (value) => validateClaim(value, "retry-mint"));
}

export async function runCraftingCommand(config, subcommand, flags = {}, options = {}) {
  if (subcommand === "recipes") return listCraftingRecipes(config, options);
  if (subcommand === "list") return listCraftingJobs(config, options);
  if (subcommand === "start") return startCrafting(config, flags, options);
  if (subcommand === "cancel") return cancelCrafting(config, flags, options);
  if (subcommand === "claim") return claimCrafting(config, flags, options);
  if (subcommand === "retry-mint") return retryMintCrafting(config, flags, options);
  throw new Error("Unknown crafting subcommand: " + (subcommand ?? ""));
}
