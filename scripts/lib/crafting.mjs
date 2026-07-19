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

function validateRecipes(value) {
  const result = requireObject(value, "recipes");
  if (!Array.isArray(result.recipes)) throw invalidResponse("recipes");
  return result;
}

function validateJobs(value) {
  const result = requireObject(value, "jobs");
  if (!Array.isArray(result.jobs)) throw invalidResponse("jobs");
  return result;
}

function validateStart(value) {
  const result = requireObject(value, "start");
  if (typeof result.craftingJobId !== "string" || typeof result.readyAt !== "string") throw invalidResponse("start");
  return result;
}

function validateCancel(value, craftingJobId) {
  const result = requireObject(value, "cancel");
  if (result.craftingJobId !== craftingJobId || result.status !== "cancelled") throw invalidResponse("cancel");
  return result;
}

function validateClaim(value, command) {
  const result = requireObject(value, command);
  if (!result.craft || typeof result.craft !== "object" || typeof result.craft.gearItemId !== "string"
    || !["complete", "failed_recoverable"].includes(result.craft.mintStatus)) throw invalidResponse(command);
  return result;
}

function mutationOperation(method, path, body) {
  return JSON.stringify({ method, path, body });
}

async function mutate(config, method, path, body, settings, validate) {
  const request = requestFor(settings);
  return runDurableMutation(settings.configPath, mutationOperation(method, path, body), async (idempotencyKey) => {
    const result = await request(config, method, path, body, { idempotent: true, idempotencyKey });
    return validate(result);
  });
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
  const result = await mutate(config, "POST", "/api/crafting/request", { recipeId }, settings, validateStart);
  return {
    ...result,
    nextRecommendedPollAt: result?.readyAt ?? null,
  };
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
