import { agentRequest, createWallet } from "./api.mjs";
import { emptyAutomation, readConfig, safeProfile, writeConfig } from "./config.mjs";
import { DIRECTIONS } from "./strategy.mjs";

export const DEFAULT_BASE_URL = "https://api.renkai.xyz";
const WAITLIST_ACCESS = {
  x: "https://x.com/renkaigame",
  discord: "https://discord.gg/fGVDhhk9t",
};

export function parseReferralInput(input) {
  if (!input) throw new Error("--referral is required; paste an app.renkai.xyz referral link or use --referral none.");
  if (["none", "no", "нет"].includes(input.trim().toLowerCase())) return null;
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Referral must be an https://app.renkai.xyz link or none.");
  }
  if (url.origin !== "https://app.renkai.xyz") {
    throw new Error("Only referral links from https://app.renkai.xyz are accepted.");
  }
  const referrerPlayerId = url.searchParams.get("ref") ?? "";
  if (!referrerPlayerId) throw new Error("The referral link has no ref query parameter.");
  if (!referrerPlayerId || referrerPlayerId.length > 64 || !/^player_[A-Za-z0-9_-]+$/.test(referrerPlayerId)) {
    throw new Error("Referral link must contain ?ref=player_... or use none.");
  }
  return { referrerPlayerId, providedAs: "link" };
}

export function registrationRequestBody(config) {
  const creating = !config.agentKey;
  return {
    action: creating ? "create" : "rotate",
    label: "renkai-player",
    ...(creating && config.referral?.referrerPlayerId
      ? { referrerPlayerId: config.referral.referrerPlayerId }
      : {}),
  };
}

export async function register(configPath, config) {
  let result;
  try {
    result = await agentRequest(
      config,
      "POST",
      "/api/agent/key",
      registrationRequestBody(config),
      { requireKey: false, idempotent: true },
    );
  } catch (error) {
    if (error.code !== "FORBIDDEN") throw error;
    error.code = "WAITLIST_REQUIRED";
    error.message = "This agent wallet is not approved yet. Renkai requires waitlist access; request it through Discord or X, then rerun register.";
    error.waitlist = {
      walletAddress: config.walletAddress,
      discord: WAITLIST_ACCESS.discord,
      x: WAITLIST_ACCESS.x,
    };
    throw error;
  }
  if (!result?.agentKey?.apiKey) throw new Error("The API did not return the one-time agent key. Run register again to rotate it.");
  config.agentKey = result.agentKey.apiKey;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  return { walletAddress: config.walletAddress, registered: true, keyStored: true };
}

export async function setup(configPath, flags) {
  const direction = flags.direction;
  if (!DIRECTIONS.has(direction)) throw new Error("--direction must be attacker, defender, blacksmith, or miner.");
  const resources = (flags.resources ?? "common").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  const goal = flags.goal ?? "balanced";
  const requestedBaseUrl = flags["base-url"] ? new URL(flags["base-url"]).origin : null;
  const desiredReferral = parseReferralInput(flags.referral);
  let config;
  let walletCreated = false;
  try {
    config = await readConfig(configPath);
  } catch (error) {
    if (!String(error.message).startsWith("No Renkai agent config")) throw error;
    config = {
      version: 3,
      ...createWallet(),
      baseUrl: requestedBaseUrl ?? DEFAULT_BASE_URL,
      profile: { direction, resources, goal },
      battle: null,
      referral: desiredReferral,
      automation: emptyAutomation(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    walletCreated = true;
  }
  config.version = 3;
  if (config.agentKey && config.referral?.referrerPlayerId !== desiredReferral?.referrerPlayerId) {
    throw new Error("Referral attribution is immutable after agent registration. Keep the original referral choice.");
  }
  config.baseUrl = requestedBaseUrl ?? config.baseUrl ?? DEFAULT_BASE_URL;
  config.profile = { direction, resources, goal };
  config.referral = desiredReferral;
  config.updatedAt = new Date().toISOString();
  await writeConfig(configPath, config);
  if (flags.offline) return { ...safeProfile(config), walletCreated, registration: "skipped" };
  try {
    const registration = config.agentKey ? { registered: true, keyStored: true } : await register(configPath, config);
    return { ...safeProfile(config), walletCreated, ...registration, battleParticipation: config.battle ? "all_battles" : "not_participating" };
  } catch (error) {
    error.publicContext = { ...safeProfile(config), walletCreated, configSaved: true };
    throw error;
  }
}
