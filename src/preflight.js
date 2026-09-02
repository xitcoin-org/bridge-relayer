import { createHash } from "node:crypto";

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
  });
  const cronosChainId = text(manifest.cronosChainId, "Cronos chain id");
  if (cronosChainId !== "338") throw new Error("Cronos Testnet chain id must be 338");
  const xitcoinChainId = text(manifest.xitcoinChainId, "Xitcoin chain id");
  if (xitcoinChainId !== "xitcoin-testnet-v2-1") {
    throw new Error("Xitcoin Testnet chain id must be xitcoin-testnet-v2-1");
  }
  return Object.freeze({ releaseCommit, roles: Object.freeze(roles), topology, cronosChainId, xitcoinChainId });
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
