import { createHash } from "node:crypto";
import { getAddress, id, ZeroAddress } from "ethers";

import { validateRuntimeTopology } from "./runtime.js";

const RELEASE_RE = /^[0-9a-f]{40}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REQUIRED_ROLES = Object.freeze([
  "coordinator",
  "signer-1",
  "signer-2",
  "signer-3",
  "submitter-xitcoin",
  "submitter-cronos",
]);
export const TESTNET_ROUTE_LABEL = "XTC:CRONOS-TESTNET:338:XITCOIN-TESTNET-V2-1";
export const TESTNET_ROUTE_ID = id(TESTNET_ROUTE_LABEL);
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

function text(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function absolutePath(value, label) {
  const result = text(value, label);
  if (!result.startsWith("/") || result.includes("/../") || result.endsWith("/..")) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return result;
}

function evmAddress(value, label) {
  let result;
  try {
    result = getAddress(text(value, label));
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
  if (result === ZeroAddress || result.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
    throw new Error(`${label} must not be zero or dead`);
  }
  return result;
}

function positiveInteger(value, label) {
  const result = text(value, label);
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error(`${label} must be a positive integer`);
  return result;
}

function validateRole(role, expectedName) {
  const name = text(role?.name, "role name");
  if (name !== expectedName || !ROLE_RE.test(name)) throw new Error("runtime role set is not canonical");
  const identity = text(role?.identity, "role identity");
  const stateDirectory = absolutePath(role?.stateDirectory, "state directory");
  const wrapper = absolutePath(role?.wrapper, "runtime wrapper");
  return Object.freeze({ name, identity, stateDirectory, wrapper });
}

export function validatePreflightManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("preflight manifest is required");
  const releaseCommit = text(manifest.releaseCommit, "release commit");
  if (!RELEASE_RE.test(releaseCommit)) throw new Error("release commit must be a full lowercase Git object id");
  if (!Array.isArray(manifest.roles) || manifest.roles.length !== REQUIRED_ROLES.length) {
    throw new Error("exactly six runtime roles are required");
  }
  const roles = manifest.roles.map((role, index) => validateRole(role, REQUIRED_ROLES[index]));
  const identities = roles.map((role) => role.identity);
  const stateDirectories = roles.map((role) => role.stateDirectory);
  const wrappers = roles.map((role) => role.wrapper);
  for (const [values, label] of [[identities, "identities"], [stateDirectories, "state directories"], [wrappers, "runtime wrappers"]]) {
    if (new Set(values).size !== values.length) throw new Error(`${label} must be distinct`);
  }
  const topology = validateRuntimeTopology({
    coordinatorIdentity: identities[0],
    signerIdentities: identities.slice(1, 4),
    submitterIdentities: identities.slice(4),
    cronosRpcUrls: manifest.cronosRpcUrls,
    xitcoinRpcUrls: manifest.xitcoinRpcUrls,
    allowLoopbackHttp: manifest.allowLoopbackHttp === true,
  });
  const cronosChainId = text(manifest.cronosChainId, "Cronos chain id");
  if (cronosChainId !== "338") throw new Error("Cronos Testnet chain id must be 338");
  const xitcoinChainId = text(manifest.xitcoinChainId, "Xitcoin chain id");
  if (xitcoinChainId !== "xitcoin-testnet-v2-1") {
    throw new Error("Xitcoin Testnet chain id must be xitcoin-testnet-v2-1");
  }
  const cronosRouteLabel = text(manifest.cronosRouteLabel, "Cronos route label");
  if (cronosRouteLabel !== TESTNET_ROUTE_LABEL) throw new Error("Cronos testnet route label is not canonical");
  const cronosRouteId = text(manifest.cronosRouteId, "Cronos route id").toLowerCase();
  if (cronosRouteId !== TESTNET_ROUTE_ID.toLowerCase()) throw new Error("Cronos testnet route id is not canonical");
  const cronosAssetAddress = evmAddress(manifest.cronosAssetAddress, "Cronos test asset");
  const cronosVaultAddress = evmAddress(manifest.cronosVaultAddress, "Cronos vault");
  if (cronosAssetAddress === cronosVaultAddress) throw new Error("Cronos asset and vault must be distinct");
  if (!Array.isArray(manifest.cronosSignerAddresses) || manifest.cronosSignerAddresses.length !== 3) {
    throw new Error("exactly three Cronos signer addresses are required");
  }
  const cronosSignerAddresses = manifest.cronosSignerAddresses.map((value, index) =>
    evmAddress(value, `Cronos signer ${index + 1}`));
  if (new Set(cronosSignerAddresses.map((value) => value.toLowerCase())).size !== 3) {
    throw new Error("Cronos signer addresses must be distinct");
  }
  const cronosGuardianAddress = evmAddress(manifest.cronosGuardianAddress, "Cronos guardian");
  if (cronosSignerAddresses.some((value) => value.toLowerCase() === cronosGuardianAddress.toLowerCase())) {
    throw new Error("Cronos guardian must be separate from signers");
  }
  const cronosMaxReleaseAmount = positiveInteger(manifest.cronosMaxReleaseAmount, "Cronos maximum release amount");
  const cronosDailyReleaseLimit = positiveInteger(manifest.cronosDailyReleaseLimit, "Cronos daily release limit");
  if (BigInt(cronosMaxReleaseAmount) > BigInt(cronosDailyReleaseLimit)) {
    throw new Error("Cronos maximum release amount must not exceed daily limit");
  }
  return Object.freeze({ releaseCommit, roles: Object.freeze(roles), topology, cronosChainId, xitcoinChainId,
    cronosRouteLabel, cronosRouteId, cronosAssetAddress, cronosVaultAddress,
    cronosSignerAddresses: Object.freeze(cronosSignerAddresses), cronosGuardianAddress,
    cronosMaxReleaseAmount, cronosDailyReleaseLimit });
}

function safeMode(value, maximum, label) {
  const mode = Number(value);
  if (!Number.isInteger(mode) || mode < 0 || mode > maximum) throw new Error(`${label} permissions are too broad`);
}

export class TestnetPreflight {
  constructor({ manifest, inspectIdentity, inspectPath, inspectService, probeNetwork }) {
    this.manifest = validatePreflightManifest(manifest);
    for (const [operation, label] of [[inspectIdentity, "identity inspector"], [inspectPath, "path inspector"], [inspectService, "service inspector"], [probeNetwork, "network probe"]]) {
      if (typeof operation !== "function") throw new Error(`${label} is required`);
    }
    this.inspectIdentity = inspectIdentity;
    this.inspectPath = inspectPath;
    this.inspectService = inspectService;
    this.probeNetwork = probeNetwork;
  }

  async run() {
    const checks = [];
    try {
      for (const role of this.manifest.roles) {
        const identity = await this.inspectIdentity(role.identity);
        if (!identity?.exists || identity.locked !== true || identity.interactive === true) throw new Error("identity_not_hardened");
        checks.push(`${role.name}:identity`);

        const state = await this.inspectPath(role.stateDirectory);
        if (!state?.exists || state.type !== "directory" || state.owner !== role.identity) throw new Error("state_path_invalid");
        safeMode(state.mode, 0o700, "state directory");
        checks.push(`${role.name}:state`);

        const wrapper = await this.inspectPath(role.wrapper);
        if (!wrapper?.exists || wrapper.type !== "file" || wrapper.owner !== role.identity) throw new Error("wrapper_invalid");
        safeMode(wrapper.mode, 0o700, "runtime wrapper");
        checks.push(`${role.name}:wrapper`);

        const service = await this.inspectService(role.name);
        if (service?.active !== false || service?.enabled !== false) throw new Error("service_must_remain_disabled");
        checks.push(`${role.name}:service_off`);
      }

      for (const [network, expected] of [["cronos", this.manifest.cronosChainId], ["xitcoin", this.manifest.xitcoinChainId]]) {
        const probe = await this.probeNetwork(network);
        if (!probe?.independent || probe.chainId !== expected || probe.catchingUp === true) throw new Error("network_identity_invalid");
        checks.push(`${network}:identity`);
        if (network === "cronos") {
          const vault = probe.vault;
          const expectedSigners = this.manifest.cronosSignerAddresses.map((value) => value.toLowerCase());
          const actualSigners = Array.isArray(vault?.signers)
            ? vault.signers.map((value) => String(value).toLowerCase()) : [];
          if (!vault?.codePresent || vault.paused !== true || String(vault.signerSetVersion) !== "1" ||
              String(vault.address).toLowerCase() !== this.manifest.cronosVaultAddress.toLowerCase() ||
              String(vault.asset).toLowerCase() !== this.manifest.cronosAssetAddress.toLowerCase() ||
              String(vault.routeId).toLowerCase() !== this.manifest.cronosRouteId ||
              String(vault.guardian).toLowerCase() !== this.manifest.cronosGuardianAddress.toLowerCase() ||
              String(vault.maxReleaseAmount) !== this.manifest.cronosMaxReleaseAmount ||
              String(vault.dailyReleaseLimit) !== this.manifest.cronosDailyReleaseLimit ||
              actualSigners.length !== 3 || actualSigners.some((value, index) => value !== expectedSigners[index])) {
            throw new Error("cronos_vault_configuration_invalid");
          }
          checks.push("cronos:vault_paused");
        }
      }
    } catch (error) {
      return this.#report(false, checks, String(error?.message ?? "preflight_failed"));
    }
    return this.#report(true, checks, null);
  }

  #report(passed, checks, failureCode) {
    const body = JSON.stringify({ version: 1, releaseCommit: this.manifest.releaseCommit, passed, checks, failureCode });
    return Object.freeze({
      version: 1,
      releaseCommit: this.manifest.releaseCommit,
      passed,
      checks: Object.freeze([...checks]),
      failureCode,
      reportDigest: createHash("sha256").update(body).digest("hex"),
    });
  }
}
