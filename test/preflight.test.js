import test from "node:test";
import assert from "node:assert/strict";

import { TestnetPreflight, validatePreflightManifest } from "../src/preflight.js";

const IDENTITIES = ["bridge-coordinator", "bridge-signer-1", "bridge-signer-2", "bridge-signer-3", "bridge-submitter-xitcoin", "bridge-submitter-cronos"];
const NAMES = ["coordinator", "signer-1", "signer-2", "signer-3", "submitter-xitcoin", "submitter-cronos"];

function manifest(overrides = {}) {
  return {
    releaseCommit: "0f85cc341744d2f941949425c7472dcecf396af4",
    roles: NAMES.map((name, index) => ({ name, identity: IDENTITIES[index], stateDirectory: `/var/lib/xitcoin-bridge/${name}`, wrapper: `/opt/xitcoin-bridge-runtime/${name}.mjs` })),
    cronosRpcUrls: ["https://cronos-a.example/rpc", "https://cronos-b.example/rpc"],
    xitcoinRpcUrls: ["https://xitcoin-a.example/rpc", "https://xitcoin-b.example/rpc"],
    cronosChainId: "25",
    xitcoinChainId: "xitcoin-testnet-v2-1",
    ...overrides,
  };
}

function operations(overrides = {}) {
  return {
    async inspectIdentity() { return { exists: true, locked: true, interactive: false }; },
    async inspectPath(path) {
      const wrapper = path.endsWith(".mjs");
      const name = path.split("/").at(-1).replace(/\.mjs$/, "");
      const index = NAMES.indexOf(name);
      return { exists: true, type: wrapper ? "file" : "directory", owner: IDENTITIES[index], mode: wrapper ? 0o500 : 0o700 };
    },
    async inspectService() { return { active: false, enabled: false }; },
    async probeNetwork(network) { return { chainId: network === "cronos" ? "25" : "xitcoin-testnet-v2-1", independent: true, catchingUp: false }; },
    ...overrides,
  };
}

test("accepts a pinned, separated and inactive testnet topology", async () => {
  const report = await new TestnetPreflight({ manifest: manifest(), ...operations() }).run();
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 26);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(report).includes("https://"), false);
});

test("rejects a moving release, shared identities and embedded RPC credentials", () => {
  assert.throws(() => validatePreflightManifest(manifest({ releaseCommit: "main" })), /full lowercase/);
  const shared = manifest();
  shared.roles[1].identity = shared.roles[0].identity;
  assert.throws(() => validatePreflightManifest(shared), /distinct|separated/);
  assert.throws(() => validatePreflightManifest(manifest({ cronosRpcUrls: ["https://user:secret@a.example", "https://b.example"] })), /credentials/);
  assert.throws(() => validatePreflightManifest(manifest({ xitcoinChainId: "xitcoin-testnet-1" })), /must be xitcoin-testnet-v2-1/);
});

test("blocks activation when any service is active or enabled", async () => {
  const report = await new TestnetPreflight({ manifest: manifest(), ...operations({ async inspectService(name) { return { active: name === "signer-2", enabled: false }; } }) }).run();
  assert.equal(report.passed, false);
  assert.equal(report.failureCode, "service_must_remain_disabled");
  assert.equal(JSON.stringify(report).includes("signer-2"), true);
});

test("rejects broad permissions and a mismatched network without leaking probe details", async () => {
  const paths = await new TestnetPreflight({ manifest: manifest(), ...operations({ async inspectPath(path) {
    const result = await operations().inspectPath(path);
    return path.endsWith("coordinator.mjs") ? { ...result, mode: 0o755 } : result;
  } }) }).run();
  assert.equal(paths.passed, false);
  assert.equal(paths.failureCode, "runtime wrapper permissions are too broad");

  const network = await new TestnetPreflight({ manifest: manifest(), ...operations({ async probeNetwork() { return { chainId: "wrong-private-chain", independent: false, raw: "secret endpoint response" }; } }) }).run();
  assert.equal(network.passed, false);
  assert.equal(network.failureCode, "network_identity_invalid");
  assert.equal(JSON.stringify(network).includes("secret endpoint"), false);
});

test("requires locked non-interactive identities and owner-bound paths", async () => {
  const identity = await new TestnetPreflight({ manifest: manifest(), ...operations({ async inspectIdentity() { return { exists: true, locked: false, interactive: true }; } }) }).run();
  assert.equal(identity.failureCode, "identity_not_hardened");
  const state = await new TestnetPreflight({ manifest: manifest(), ...operations({ async inspectPath(path) {
    const result = await operations().inspectPath(path);
    return path.includes("signer-3") ? { ...result, owner: "root" } : result;
  } }) }).run();
  assert.equal(state.failureCode, "state_path_invalid");
});
