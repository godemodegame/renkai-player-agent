#!/usr/bin/env node

import { configPathFrom, readConfig } from "./lib/config.mjs";
import { getCraftingJobStatus, listCraftingJobs, listCraftingRecipes } from "./lib/crafting.mjs";
import { readInventory } from "./lib/inventory.mjs";

const DEPLOYED_API_ORIGIN = "https://api.renkai.xyz";

function flagsFrom(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--config") throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Missing value for --config");
    flags.config = value;
    index += 1;
  }
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const config = await readConfig(configPathFrom(flagsFrom(argv)));
  if (config.baseUrl !== DEPLOYED_API_ORIGIN) {
    const error = new Error(`Deployed smoke requires ${DEPLOYED_API_ORIGIN}.`);
    error.code = "SMOKE_ORIGIN_INVALID";
    throw error;
  }
  if (!config.agentKey) {
    const error = new Error("Deployed smoke requires a registered agent config.");
    error.code = "SMOKE_AUTH_REQUIRED";
    throw error;
  }

  const [inventory, recipes, jobs] = await Promise.all([
    readInventory(config, { limit: 1 }),
    listCraftingRecipes(config),
    listCraftingJobs(config),
  ]);
  const firstJob = jobs.jobs[0] ?? null;
  const status = firstJob
    ? await getCraftingJobStatus(config, { job: firstJob.craftingJobId })
    : null;
  return {
    ok: true,
    baseUrl: config.baseUrl,
    authenticated: true,
    inventory: {
      observedAt: inventory.observedAt,
      resourceCount: inventory.resources.totalCount,
      gearPageCount: inventory.gear.items.length,
    },
    crafting: {
      recipeCount: recipes.recipes.length,
      jobCount: jobs.jobs.length,
      statusCheckedJobId: status?.job.craftingJobId ?? null,
      nextRecommendedPollAt: status?.nextRecommendedPollAt ?? jobs.nextRecommendedPollAt,
    },
  };
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error.code ?? "CLIENT_ERROR",
      message: error.message,
      status: error.status,
      retryAt: error.retryAt,
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});
