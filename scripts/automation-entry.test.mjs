import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  automationStatus,
  createWallet,
  installAutomation,
} from "./renkai.mjs";

const execFileAsync = promisify(execFile);
const rootCliPath = resolve(process.cwd(), "scripts", "renkai.mjs");

function testConfig() {
  return {
    version: 3,
    ...createWallet(),
    baseUrl: "https://example.invalid",
    agentKey: "agent-key",
    profile: { direction: "defender", resources: ["common"], goal: "balanced" },
    battle: { mode: "defend", targetCastleId: null },
    automation: {
      runtime: null,
      jobId: null,
      scriptPath: null,
      lastRunAt: null,
      lastPledgedWindowId: null,
      lastAlertedWindowId: null,
      notification: null,
    },
  };
}

test("targets the root CLI for Hermes and OpenClaw", async () => {
  for (const runtime of ["hermes", "openclaw"]) {
    const directory = await mkdtemp(join(tmpdir(), `renkai-entry-${runtime}-`));
    const configPath = join(directory, "agent.json");
    const scriptsDir = join(directory, "scripts");
    const config = testConfig();
    await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    const calls = [];
    const runner = (binary, args) => {
      calls.push({ binary, args });
      if (args[0] === "cron" && args[1] === "list") {
        return { stdout: runtime === "hermes" ? "" : JSON.stringify({ jobs: [] }) };
      }
      if (args[0] === "cron" && args[1] === "create") return { stdout: JSON.stringify({ id: `${runtime}-job` }) };
      return { stdout: "ok" };
    };

    await installAutomation(configPath, config, runtime, { "notify-channel": "origin" }, {
      runner,
      hermesScriptsDir: scriptsDir,
      request: async () => ({ policy: { mode: "defend", targetCastleId: null, updatedAt: "2026-07-19T00:00:00.000Z" } }),
    });

    if (runtime === "hermes") {
      const wrapperPath = join(scriptsDir, "renkai-all-battles.sh");
      const wrapper = await readFile(wrapperPath, "utf8");
      assert.ok(wrapper.includes(`'${process.execPath}' '${rootCliPath}' battle-tick --quiet --config '${configPath}'`));
    } else {
      const createCall = calls.find(({ args }) => args[0] === "cron" && args[1] === "create");
      assert.ok(createCall);
      const argv = JSON.parse(createCall.args[createCall.args.indexOf("--command-argv") + 1]);
      assert.equal(argv[0], process.execPath);
      assert.equal(argv[1], rootCliPath);
      assert.deepEqual(argv.slice(2), ["battle-tick", "--quiet", "--config", configPath]);
    }
  }
});

test("imports the CLI module without executing its main entrypoint", async () => {
  const script = `import ${JSON.stringify(rootCliPath)}; process.stdout.write("imported\\n");`;
  const result = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.stdout, "imported\n");
  assert.equal(result.stderr, "");
});

test("does not persist after a failed automation test run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-entry-failure-"));
  const configPath = join(directory, "agent.json");
  const scriptsDir = join(directory, "scripts");
  const config = testConfig();
  const initialBytes = `${JSON.stringify(config)}\n`;
  await writeFile(configPath, initialBytes, { mode: 0o600 });
  const calls = [];
  const runner = (binary, args) => {
    calls.push({ binary, args });
    if (binary === "/bin/bash") throw new Error("runtime test failed");
    return { stdout: "" };
  };

  await assert.rejects(
    installAutomation(configPath, config, "hermes", { "notify-channel": "origin" }, {
      runner,
      hermesScriptsDir: scriptsDir,
      request: async () => ({ policy: { mode: "defend", targetCastleId: null, updatedAt: "2026-07-19T00:00:00.000Z" } }),
    }),
    /runtime test failed/,
  );

  assert.deepEqual(config.automation, testConfig().automation);
  assert.equal(await readFile(configPath, "utf8"), initialBytes);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [join(scriptsDir, "renkai-all-battles.sh")]);
  assert.equal((await automationStatus(config, { runner })).installed, false);
});

test("replaces a wrapper symlink without overwriting its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-entry-symlink-"));
  const configPath = join(directory, "agent.json");
  const scriptsDir = join(directory, "scripts");
  const wrapperPath = join(scriptsDir, "renkai-all-battles.sh");
  const sentinelPath = join(directory, "sentinel.txt");
  const config = testConfig();
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await writeFile(sentinelPath, "untouched\n", { mode: 0o600 });
  await symlink(sentinelPath, wrapperPath);
  const runner = (_binary, args) => args[0] === "cron" && args[1] === "create"
    ? { stdout: JSON.stringify({ id: "safe-job" }) }
    : { stdout: "" };
  await installAutomation(configPath, config, "hermes", { "notify-channel": "origin" }, {
    runner,
    hermesScriptsDir: scriptsDir,
    request: async () => ({ policy: { mode: "defend", targetCastleId: null, updatedAt: "2026-07-19T00:00:00.000Z" } }),
  });
  assert.equal(await readFile(sentinelPath, "utf8"), "untouched\n");
  assert.equal((await lstat(wrapperPath)).isSymbolicLink(), false);
  assert.match(await readFile(wrapperPath, "utf8"), /battle-tick --quiet/);
});
