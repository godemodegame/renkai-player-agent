import assert from "node:assert/strict";
import test from "node:test";
import { cleanupLegacyAutomation, namedJobIds } from "./lib/automation.mjs";

test("cleans only exact legacy jobs without calling the game API", () => {
  const calls = [];
  const result = cleanupLegacyAutomation("openclaw", {
    runner: (binary, args) => {
      calls.push({ binary, args });
      if (args[0] === "cron" && args[1] === "list") return { stdout: JSON.stringify({ jobs: [
        { id: "keep", name: "user-job" },
        { id: "old-battle", name: "renkai-all-battles" },
        { id: "old-quest", name: "renkai-quests-step" },
      ] }) };
      return { stdout: "" };
    },
  });
  assert.deepEqual(result, { runtime: "openclaw", removedJobIds: ["old-battle", "old-quest"], migrationOnly: true });
  assert.deepEqual(calls, [
    { binary: "openclaw", args: ["cron", "list", "--json"] },
    { binary: "openclaw", args: ["cron", "remove", "old-battle"] },
    { binary: "openclaw", args: ["cron", "remove", "old-quest"] },
  ]);
});

test("parses only jobs with the requested exact name", () => {
  assert.deepEqual(namedJobIds(JSON.stringify({ jobs: [
    { id: "a", name: "renkai-all-battles" },
    { id: "b", name: "renkai-all-battles-copy" },
  ] }), "renkai-all-battles"), ["a"]);
});
