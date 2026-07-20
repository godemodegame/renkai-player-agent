import { execFileSync } from "node:child_process";

const LEGACY_JOB_NAMES = ["renkai-all-battles", "renkai-mandatory-battles", "renkai-quests-step"];

export function runRuntimeCommand(binary, args) {
  return { stdout: execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
}

function stripAnsi(value) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "");
}

function jobsFromJson(value, jobs = []) {
  if (Array.isArray(value)) {
    for (const item of value) jobsFromJson(item, jobs);
    return jobs;
  }
  if (!value || typeof value !== "object") return jobs;
  const id = value.id ?? value.jobId ?? value.job_id;
  const name = value.name ?? value.jobName ?? value.job_name;
  if (id && name) jobs.push({ id: String(id), name: String(name) });
  for (const nested of Object.values(value)) jobsFromJson(nested, jobs);
  return jobs;
}

export function namedJobIds(output, expectedName) {
  const plain = stripAnsi(output);
  try {
    const parsed = jobsFromJson(JSON.parse(plain));
    return [...new Set(parsed.filter((job) => job.name === expectedName).map((job) => job.id))];
  } catch {
    return plain.split(/\n\s*\n/).flatMap((block) => {
      const name = block.match(/^\s*Name:\s*(.+?)\s*$/mi)?.[1];
      if (name !== expectedName) return [];
      const id = block.match(/^\s*([A-Za-z0-9_-]{6,})\b/m)?.[1];
      return id ? [id] : [];
    });
  }
}

function runtimeList(runtime, runner) {
  const binary = runtime === "hermes" ? "hermes" : "openclaw";
  return runner(binary, ["cron", "list", ...(runtime === "openclaw" ? ["--json"] : [])]).stdout;
}

export function cleanupLegacyAutomation(runtime, options = {}) {
  if (runtime !== "hermes" && runtime !== "openclaw") throw new Error("--runtime must be hermes or openclaw.");
  const runner = options.runner ?? runRuntimeCommand;
  const binary = runtime === "hermes" ? "hermes" : "openclaw";
  const listed = runtimeList(runtime, runner);
  const removedJobIds = LEGACY_JOB_NAMES.flatMap((name) => {
    const ids = namedJobIds(listed, name);
    ids.forEach((id) => runner(binary, ["cron", "remove", id]));
    return ids;
  });
  return { runtime, removedJobIds, migrationOnly: true };
}
