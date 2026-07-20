import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { cliErrorOutput, createWallet, main } from "./renkai.mjs";

async function writeFixture(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(value), { mode });
}

function fixture(overrides = {}) {
  return { version: 4, ...createWallet(), baseUrl: "https://api.example.test", agentKey: "agent-key", referral: null, ...overrides };
}

async function captureMain(argv) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  try { return { result: await main(argv), text: chunks.join("") }; } finally { process.stdout.write = originalWrite; }
}

test("keeps setup neutral and secrets private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-config-neutral-"));
  const path = join(directory, "agent.json");
  const config = fixture({ version: 2, profile: { direction: "miner" }, battle: { mode: "defend" }, automation: { runtime: "hermes" } });
  await writeFixture(path, config, 0o644);
  const output = await captureMain(["profile", "--config", path]);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.version, 4);
  assert.equal(migrated.profile, undefined);
  assert.equal(migrated.battle, undefined);
  assert.equal(migrated.automation, undefined);
  assert.equal(migrated.legacyMigrationRequired, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(output.text.includes(config.privateKeyPkcs8), false);
  assert.equal(output.text.includes(config.agentKey), false);
});

test("setup requires only referral and base URL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-config-setup-"));
  const path = join(directory, "agent.json");
  const { text } = await captureMain(["setup", "--config", path, "--referral", "none", "--offline"]);
  const result = JSON.parse(text);
  assert.equal(result.setupStatus, "wallet_only");
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.equal(saved.version, 4);
  assert.equal(saved.referral, null);
  assert.equal(saved.profile, undefined);
  assert.equal(saved.battle, undefined);
  assert.equal(saved.automation, undefined);
});

test("does not replace malformed config and serializes errors without secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "renkai-config-error-"));
  const path = join(directory, "agent.json");
  const malformed = '{"version":4';
  await writeFile(path, malformed, { mode: 0o600 });
  await assert.rejects(main(["profile", "--config", path]), (error) => {
    const output = cliErrorOutput(error);
    assert.equal(output.ok, false);
    assert.equal(output.error.code, "CLIENT_ERROR");
    return true;
  });
  assert.equal(await readFile(path, "utf8"), malformed);
});
