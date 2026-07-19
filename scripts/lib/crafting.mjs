import { agentRequest, agentRequestWithMetadata } from "./api.mjs";

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

export async function listCraftingRecipes(config, options = {}) {
  return requestFor(normalizeOptions(options))(config, "GET", "/api/crafting/recipes");
}

export async function listCraftingJobs(config, options = {}) {
  const response = await requestFor(normalizeOptions(options), true)(config, "GET", "/api/crafting/jobs");
  const { data, nextRecommendedPollAt } = unwrapMetadata(response);
  return {
    jobs: data?.jobs ?? [],
    nextRecommendedPollAt,
  };
}

export async function startCrafting(config, flags = {}, options = {}) {
  const recipeId = requireRecipeId(flags);
  requireConfirmation(flags, recipeId, "start", "recipeId");
  const result = await requestFor(normalizeOptions(options))(config, "POST", "/api/crafting/request", { recipeId }, { idempotent: true });
  return {
    ...result,
    nextRecommendedPollAt: result?.readyAt ?? null,
  };
}

export async function cancelCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "cancel");
  requireConfirmation(flags, craftingJobId, "cancel", "craftingJobId");
  return requestFor(normalizeOptions(options))(config, "POST", "/api/crafting/cancel", { craftingJobId }, { idempotent: true });
}

export async function claimCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "claim");
  requireConfirmation(flags, craftingJobId, "claim", "craftingJobId");
  return requestFor(normalizeOptions(options))(config, "POST", "/api/crafting/claim", { craftingJobId }, { idempotent: true });
}

export async function retryMintCrafting(config, flags = {}, options = {}) {
  const craftingJobId = requireJobId(flags, "retry-mint");
  requireConfirmation(flags, craftingJobId, "retry-mint", "craftingJobId");
  return requestFor(normalizeOptions(options))(config, "POST", "/api/crafting/retry-mint", { craftingJobId }, { idempotent: true });
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
