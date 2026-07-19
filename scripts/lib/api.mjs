import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length === 0) return "";
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  return "1".repeat(leadingZeroes) + encoded;
}

export function createWallet() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  return {
    walletAddress: base58Encode(publicDer.subarray(publicDer.length - 32)),
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function buildSignatureMessage(method, path, body, timestamp, nonce) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
}

export function signRequest(config, method, path, body = "") {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const privateKey = createPrivateKey({
    key: Buffer.from(config.privateKeyPkcs8, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = base58Encode(sign(null, Buffer.from(buildSignatureMessage(method, path, body, timestamp, nonce)), privateKey));
  return {
    "X-Agent-Wallet": config.walletAddress,
    "X-Agent-Timestamp": timestamp,
    "X-Agent-Nonce": nonce,
    "X-Agent-Signature": signature,
  };
}

function wantsMetadata(options = {}) {
  return options.metadata === true || options.withMetadata === true || options.includeMetadata === true;
}

function endpointUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.origin !== base.origin || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password) {
    const error = new Error("Renkai API requests require an HTTPS origin (HTTP is allowed only on loopback).");
    error.code = "INSECURE_API_ORIGIN";
    throw error;
  }
  return url;
}

function redactValue(value, secrets) {
  if (typeof value === "string") {
    return secrets.reduce((safe, secret) => safe.replaceAll(secret, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}

function redactAgentError(error, config) {
  const secrets = [config.agentKey, config.privateKeyPkcs8].filter((value) => typeof value === "string" && value.length > 0);
  if (!secrets.length || !error || typeof error !== "object") return error;
  if (typeof error.message === "string") error.message = redactValue(error.message, secrets);
  if (error.details !== undefined) error.details = redactValue(error.details, secrets);
  return error;
}

export async function parseResponse(response, options = {}) {
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const code = payload?.error?.code ?? (response.status === 404 ? "API_NOT_DEPLOYED" : `HTTP_${response.status}`);
    const message = payload?.error?.message ?? (response.status === 404
      ? "This Renkai deployment does not expose the requested Agent API route yet."
      : text.slice(0, 200) || response.statusText);
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    error.retryAt = payload?.error?.retryAt;
    error.details = payload?.error?.details;
    throw error;
  }
  const data = payload?.data ?? payload;
  if (wantsMetadata(options)) {
    return {
      data,
      nextRecommendedPollAt: payload?.nextRecommendedPollAt ?? null,
    };
  }
  return data;
}

export async function parseResponseWithMetadata(response) {
  return parseResponse(response, { metadata: true });
}

export async function unsignedGet(baseUrl, path, options = {}) {
  return parseResponse(await fetch(endpointUrl(baseUrl, path), {
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  }), options);
}

export async function agentRequest(config, method, path, bodyValue, options = {}) {
  if (options.requireKey !== false && !config.agentKey) throw new Error("The wallet is not registered. Run register first.");
  const body = bodyValue === undefined ? "" : JSON.stringify(bodyValue);
  const headers = signRequest(config, method, path, body);
  if (config.agentKey) headers["X-Agent-Key"] = config.agentKey;
  if (bodyValue !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotent) headers["X-Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  try {
    return await parseResponse(await fetch(endpointUrl(config.baseUrl, path), {
      method,
      headers,
      body: bodyValue === undefined ? undefined : body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }), options);
  } catch (error) {
    throw redactAgentError(error, config);
  }
}

export async function agentRequestWithMetadata(config, method, path, bodyValue, options = {}) {
  return agentRequest(config, method, path, bodyValue, { ...options, metadata: true });
}
