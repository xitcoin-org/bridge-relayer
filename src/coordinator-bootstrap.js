import { constants as fsConstants } from "node:fs";
import { open as openDefault } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { getAddress } from "ethers";

import { runApprovalOnlyCycle } from "./coordinator.js";
import { createCredentialedSignerClients } from "./coordinator-transport.js";
import { connectCronosProviders, connectXitcoinClients, decodeXitcoinOutboundBlock, decodeXitcoinOutboundTransaction } from "./network.js";
import { TESTNET_ROUTE_ID } from "./preflight.js";
import { normalizeBytes32, validateRouteId } from "./protocol.js";
import { RelayStore } from "./store.js";
import { CronosFinalizedWatcher, XitcoinFinalizedWatcher } from "./watchers.js";

const MAXIMUM_CONFIG_BYTES = 65_536;
const RELEASE = /^[0-9a-f]{40}$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function keys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} contains unsupported fields`);
  return value;
}

function text(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function integer(value, label, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw new Error(`${label} is invalid`);
  return result;
}

function absolute(value, label) {
  const result = text(value, label);
  if (!isAbsolute(result) || result.includes("/../") || result.endsWith("/..")) throw new Error(`${label} must be absolute and normalized`);
  return result;
}

function urls(value, label) {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${label} require two independent origins`);
  return value.map((item) => text(item, `${label} URL`));
}

export function validateCoordinatorConfig(input) {
  const config = keys(object(input, "coordinator config"), ["version", "mode", "releaseCommit", "statePath", "cycleIntervalMs", "approvalWindowSeconds", "maximumApprovals", "startHeights", "policy", "authorizedSigners", "signers", "cronos", "xitcoin"], "coordinator config");
  if (config.version !== 1 || config.mode !== "approval_only") throw new Error("coordinator mode is not approval-only");
  const releaseCommit = text(config.releaseCommit, "release commit");
  if (!RELEASE.test(releaseCommit)) throw new Error("release commit is invalid");
  const policy = keys(object(config.policy, "policy"), ["routeId", "cronosRouteId", "cronosChainId", "cronosVault", "signerSetVersion"], "policy");
  const routeId = validateRouteId(policy.routeId);
  if (routeId !== "cronos-testnet-xitcoin-testnet") throw new Error("testnet route is not canonical");
  const cronosRouteId = normalizeBytes32(policy.cronosRouteId);
  if (cronosRouteId !== TESTNET_ROUTE_ID.toLowerCase()) throw new Error("Cronos route is not canonical");
  const cronosChainId = integer(policy.cronosChainId, "Cronos chain ID");
  if (cronosChainId !== 338) throw new Error("Cronos chain ID is not testnet");
  const xitcoin = keys(object(config.xitcoin, "Xitcoin config"), ["rpcUrls", "chainId", "safetyLag", "maxBatch", "allowLoopbackHttp"], "Xitcoin config");
  if (xitcoin.chainId !== "xitcoin-testnet-v2-1") throw new Error("Xitcoin chain ID is not testnet");
  const signers = Array.isArray(config.signers) ? config.signers.map((signer) => ({ identity: text(signer?.identity, "signer identity"), url: text(signer?.url, "signer URL") })) : [];
  if (signers.length !== 3) throw new Error("exactly three signer transports are required");
  const authorizedSigners = Array.isArray(config.authorizedSigners) ? config.authorizedSigners.map(getAddress) : [];
  if (authorizedSigners.length !== 3 || new Set(authorizedSigners.map((item) => item.toLowerCase())).size !== 3) throw new Error("exactly three distinct authorized signers are required");
  const cronos = keys(object(config.cronos, "Cronos config"), ["rpcUrls", "confirmations", "maxBatch"], "Cronos config");
  const startHeights = keys(object(config.startHeights, "start heights"), ["cronos", "xitcoin"], "start heights");
  return Object.freeze({
    version: 1, mode: "approval_only", releaseCommit,
    statePath: absolute(config.statePath, "state path"),
    cycleIntervalMs: integer(config.cycleIntervalMs, "cycle interval", 1_000, 60_000),
    approvalWindowSeconds: integer(config.approvalWindowSeconds, "approval window", 1, 900),
    maximumApprovals: integer(config.maximumApprovals, "maximum approvals", 1, 100),
    startHeights: { cronos: integer(startHeights.cronos, "Cronos start height", 0), xitcoin: integer(startHeights.xitcoin, "Xitcoin start height", 0) },
    policy: { routeId, cronosRouteId, cronosChainId, cronosVault: getAddress(policy.cronosVault), signerSetVersion: integer(policy.signerSetVersion, "signer set version") },
    authorizedSigners: Object.freeze(authorizedSigners), signers: Object.freeze(signers),
    cronos: { rpcUrls: urls(cronos.rpcUrls, "Cronos RPCs"), confirmations: integer(cronos.confirmations, "Cronos confirmations"), maxBatch: integer(cronos.maxBatch, "Cronos max batch", 1, 500) },
    xitcoin: { rpcUrls: urls(xitcoin.rpcUrls, "Xitcoin RPCs"), chainId: xitcoin.chainId, safetyLag: integer(xitcoin.safetyLag, "Xitcoin safety lag", 0), maxBatch: integer(xitcoin.maxBatch, "Xitcoin max batch", 1, 100), allowLoopbackHttp: xitcoin.allowLoopbackHttp === true },
  });
}

export function verifyCoordinatorRelease(config, modulePath) {
  const manifest = validateCoordinatorConfig(config);
  const directoryCommit = basename(dirname(dirname(absolute(modulePath, "coordinator module path"))));
  if (!RELEASE.test(directoryCommit) || directoryCommit !== manifest.releaseCommit) {
    throw new Error("coordinator release does not match its pinned manifest");
  }
  return manifest.releaseCommit;
}

export async function loadCoordinatorConfig(path, { open = openDefault, expectedOwnerUid = 0 } = {}) {
  let handle;
  try {
    handle = await open(absolute(path, "coordinator config path"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== expectedOwnerUid || (metadata.mode & 0o022) !== 0 || metadata.size < 1 || metadata.size > MAXIMUM_CONFIG_BYTES) throw new Error();
    const body = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(body) > MAXIMUM_CONFIG_BYTES) throw new Error();
    return validateCoordinatorConfig(JSON.parse(body));
  } catch {
    throw new Error("coordinator configuration could not be loaded");
  } finally {
    await handle?.close();
  }
}

export async function buildApprovalOnlyCoordinator(config, { credentialsDirectory,
  connectCronos = connectCronosProviders, connectXitcoin = connectXitcoinClients,
  makeCronosWatcher = (options) => new CronosFinalizedWatcher(options), makeXitcoinWatcher = (options) => new XitcoinFinalizedWatcher(options),
  makeSignerClients = createCredentialedSignerClients, makeStore = (path) => new RelayStore(path), runCycle = runApprovalOnlyCycle,
} = {}) {
  const manifest = validateCoordinatorConfig(config);
  const credentialRoot = absolute(credentialsDirectory, "credentials directory");
  const [providers, xitcoinClients, signerClients] = await Promise.all([
    connectCronos({ urls: manifest.cronos.rpcUrls, chainId: manifest.policy.cronosChainId }),
    connectXitcoin({ urls: manifest.xitcoin.rpcUrls, chainId: manifest.xitcoin.chainId, allowHttp: manifest.xitcoin.allowLoopbackHttp, decodeBlock: decodeXitcoinOutboundBlock, decodeTransaction: decodeXitcoinOutboundTransaction }),
    makeSignerClients({ signers: manifest.signers, credentialsDirectory: credentialRoot }),
  ]);
  const cronosWatcher = makeCronosWatcher({ providers, vault: manifest.policy.cronosVault, routeId: manifest.policy.cronosRouteId, confirmations: manifest.cronos.confirmations, maxBatch: manifest.cronos.maxBatch });
  const xitcoinWatcher = makeXitcoinWatcher({ clients: xitcoinClients, chainId: manifest.xitcoin.chainId, routeId: manifest.policy.routeId, safetyLag: manifest.xitcoin.safetyLag, maxBatch: manifest.xitcoin.maxBatch });
  const store = makeStore(manifest.statePath);
  return Object.freeze({ manifest, async runOnce() { return runCycle({ store, cronosWatcher, xitcoinWatcher, clients: signerClients, authorizedSigners: manifest.authorizedSigners, routeId: manifest.policy.routeId, cronosRouteId: manifest.policy.cronosRouteId, cronosChainId: manifest.policy.cronosChainId, cronosVault: manifest.policy.cronosVault, signerSetVersion: manifest.policy.signerSetVersion, approvalWindowSeconds: manifest.approvalWindowSeconds, startHeights: manifest.startHeights, maxBatch: Math.min(manifest.cronos.maxBatch, manifest.xitcoin.maxBatch), maximumApprovals: manifest.maximumApprovals }); }, close() { store.close(); } });
}
