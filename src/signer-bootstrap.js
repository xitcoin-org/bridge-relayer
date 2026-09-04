import { constants as fsConstants } from "node:fs";
import { open as openDefault } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { cronosRouteId } from "./protocol.js";
import {
  connectCronosProviders,
  connectXitcoinClients,
  decodeXitcoinOutboundBlock,
  decodeXitcoinOutboundTransaction,
} from "./network.js";
import { createSignerPolicy } from "./signer-service.js";
import { createSecureSignerHandler, createSecureSignerService, startLoopbackSignerServer } from "./signer-runtime.js";
import { createCanonicalSourceVerifier } from "./source-verification.js";
import { CronosFinalizedWatcher, XitcoinFinalizedWatcher } from "./watchers.js";

const MAXIMUM_CONFIG_BYTES = 65_536;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function keys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new Error(`${label} contains unsupported fields`);
  return value;
}

function text(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function integer(value, label, minimum = 1) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) throw new Error(`${label} is invalid`);
  return result;
}

function list(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${label} are required`);
  return value;
}

function absolute(value, label) {
  const result = text(value, label);
  if (!isAbsolute(result)) throw new Error(`${label} must be absolute`);
  return result;
}

export function validateSignerConfig(input) {
  const config = keys(object(input, "signer config"), ["version", "identity", "expectedAddress", "keystorePath", "listen", "policy", "cronos", "xitcoin"], "signer config");
  if (config.version !== 1) throw new Error("signer config version is unsupported");
  const listen = keys(object(config.listen, "listener"), ["host", "port"], "listener");
  const policy = keys(object(config.policy, "policy"), ["routeId", "cronosChainId", "cronosVault", "maximumAmount", "maximumDeadlineSeconds"], "policy");
  const cronos = keys(object(config.cronos, "Cronos config"), ["rpcUrls", "confirmations", "maxBatch"], "Cronos config");
  const xitcoin = keys(object(config.xitcoin, "Xitcoin config"), ["rpcUrls", "chainId", "safetyLag", "maxBatch", "allowLoopbackHttp"], "Xitcoin config");
  const identity = text(config.identity, "signer identity");
  if (!/^signer-[123]$/.test(identity)) throw new Error("signer identity is not canonical");
  const routeId = text(policy.routeId, "route ID");
  const cronosChainId = integer(policy.cronosChainId, "Cronos chain ID");
  if (cronosChainId !== 338) throw new Error("Cronos Testnet chain ID must be 338");
  const normalized = {
    version: 1,
    identity,
    expectedAddress: text(config.expectedAddress, "expected signer address"),
    keystorePath: absolute(config.keystorePath, "keystore path"),
    listen: { host: text(listen.host, "listener host"), port: integer(listen.port, "listener port") },
    policy: {
      routeId,
      cronosChainId,
      cronosVault: text(policy.cronosVault, "Cronos vault"),
      maximumAmount: text(policy.maximumAmount, "maximum amount"),
      maximumDeadlineSeconds: integer(policy.maximumDeadlineSeconds, "maximum deadline window"),
    },
    cronos: {
      rpcUrls: list(cronos.rpcUrls, "Cronos RPC URLs", 2).map((url) => text(url, "Cronos RPC URL")),
      confirmations: integer(cronos.confirmations, "Cronos confirmations"),
      maxBatch: integer(cronos.maxBatch ?? 500, "Cronos maximum batch"),
    },
    xitcoin: {
      rpcUrls: list(xitcoin.rpcUrls, "Xitcoin RPC URLs", 2).map((url) => text(url, "Xitcoin RPC URL")),
      chainId: text(xitcoin.chainId, "Xitcoin chain ID"),
      safetyLag: integer(xitcoin.safetyLag, "Xitcoin safety lag", 0),
      maxBatch: integer(xitcoin.maxBatch ?? 100, "Xitcoin maximum batch"),
      allowLoopbackHttp: xitcoin.allowLoopbackHttp === true,
    },
  };
  if (normalized.xitcoin.chainId !== "xitcoin-testnet-v2-1") throw new Error("Xitcoin Testnet chain ID is not canonical");
  return Object.freeze(normalized);
}

export async function loadSignerConfig(path, { open = openDefault, expectedOwnerUid = 0 } = {}) {
  let handle;
  try {
    const target = absolute(path, "signer config path");
    handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== expectedOwnerUid || (metadata.mode & 0o022) !== 0) throw new Error("unsafe signer config metadata");
    if (metadata.size < 1 || metadata.size > MAXIMUM_CONFIG_BYTES) throw new Error("invalid signer config size");
    const body = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(body) > MAXIMUM_CONFIG_BYTES) throw new Error("invalid signer config size");
    return validateSignerConfig(JSON.parse(body));
  } catch {
    throw new Error("signer configuration could not be loaded");
  } finally {
    await handle?.close();
  }
}

export async function buildSignerRuntime(config, {
  credentialsDirectory,
  connectCronos = connectCronosProviders,
  connectXitcoin = connectXitcoinClients,
  makeCronosWatcher = (options) => new CronosFinalizedWatcher(options),
  makeXitcoinWatcher = (options) => new XitcoinFinalizedWatcher(options),
  makeVerifier = createCanonicalSourceVerifier,
  makeService = createSecureSignerService,
  makeHandler = createSecureSignerHandler,
  startServer = startLoopbackSignerServer,
} = {}) {
  const manifest = validateSignerConfig(config);
  const credentialRoot = absolute(credentialsDirectory, "credentials directory");
  const [providers, clients] = await Promise.all([
    connectCronos({ urls: manifest.cronos.rpcUrls, chainId: manifest.policy.cronosChainId }),
    connectXitcoin({
      urls: manifest.xitcoin.rpcUrls,
      chainId: manifest.xitcoin.chainId,
      allowHttp: manifest.xitcoin.allowLoopbackHttp,
      decodeBlock: decodeXitcoinOutboundBlock,
      decodeTransaction: decodeXitcoinOutboundTransaction,
    }),
  ]);
  const cronosWatcher = makeCronosWatcher({
    providers,
    vault: manifest.policy.cronosVault,
    routeId: cronosRouteId(manifest.policy.routeId),
    confirmations: manifest.cronos.confirmations,
    maxBatch: manifest.cronos.maxBatch,
  });
  const xitcoinWatcher = makeXitcoinWatcher({
    clients,
    chainId: manifest.xitcoin.chainId,
    routeId: manifest.policy.routeId,
    safetyLag: manifest.xitcoin.safetyLag,
    maxBatch: manifest.xitcoin.maxBatch,
  });
  const policy = createSignerPolicy({
    routeIds: [manifest.policy.routeId],
    cronosChainIds: [manifest.policy.cronosChainId],
    cronosVaults: [manifest.policy.cronosVault],
    maximumAmount: manifest.policy.maximumAmount,
    maximumDeadlineSeconds: manifest.policy.maximumDeadlineSeconds,
  });
  const service = await makeService({
    identity: manifest.identity,
    expectedAddress: manifest.expectedAddress,
    keystorePath: manifest.keystorePath,
    keystoreCredentialPath: join(credentialRoot, "keystore-password"),
    policy,
    verifySource: makeVerifier({ cronosWatcher, xitcoinWatcher }),
  });
  const handler = await makeHandler({ service, transportCredentialPath: join(credentialRoot, "transport-token") });
  const server = await startServer({ handler, host: manifest.listen.host, port: manifest.listen.port });
  return Object.freeze({ manifest, server });
}
