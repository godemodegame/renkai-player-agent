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

export async function parseResponse(response) {
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
  return payload?.data ?? payload;
}

export async function unsignedGet(baseUrl, path) {
  return parseResponse(await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(10_000) }));
}

export async function agentRequest(config, method, path, bodyValue, options = {}) {
  if (options.requireKey !== false && !config.agentKey) throw new Error("The wallet is not registered. Run register first.");
  const body = bodyValue === undefined ? "" : JSON.stringify(bodyValue);
  const headers = signRequest(config, method, path, body);
  if (config.agentKey) headers["X-Agent-Key"] = config.agentKey;
  if (bodyValue !== undefined) headers["Content-Type"] = "application/json";
  if (options.idempotent) headers["X-Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
  return parseResponse(await fetch(new URL(path, config.baseUrl), {
    method,
    headers,
    body: bodyValue === undefined ? undefined : body,
    signal: AbortSignal.timeout(15_000),
  }));
}
