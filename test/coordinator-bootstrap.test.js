import assert from "node:assert/strict";
import test from "node:test";
import { TESTNET_ROUTE_ID } from "../src/preflight.js";
import { buildApprovalOnlyCoordinator, validateCoordinatorConfig, verifyCoordinatorRelease } from "../src/coordinator-bootstrap.js";

const addresses = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"];
function manifest(overrides = {}) { return { version: 1, mode: "approval_only", releaseCommit: "a".repeat(40), statePath: "/var/lib/xitcoin-bridge/coordinator/relay.sqlite", cycleIntervalMs: 5000, approvalWindowSeconds: 300, maximumApprovals: 10, startHeights: { cronos: 1, xitcoin: 1 }, policy: { routeId: "cronos-testnet-xitcoin-testnet", cronosRouteId: TESTNET_ROUTE_ID, cronosChainId: 338, cronosVault: "0x4444444444444444444444444444444444444444", signerSetVersion: 1 }, authorizedSigners: addresses, signers: [1,2,3].map((index) => ({ identity: `signer-${index}`, url: `http://127.0.0.1:${43100 + index}/v1/approve` })), cronos: { rpcUrls: ["https://one.example", "https://two.example"], confirmations: 64, maxBatch: 100 }, xitcoin: { rpcUrls: ["http://127.0.0.1:41657", "https://rpc.example"], chainId: "xitcoin-testnet-v2-1", safetyLag: 1, maxBatch: 100, allowLoopbackHttp: true }, ...overrides }; }

test("accepts only a pinned approval-only coordinator manifest", () => {
  const config = validateCoordinatorConfig(manifest());
  assert.equal(config.mode, "approval_only");
  assert.equal(config.policy.cronosChainId, 338);
  assert.throws(() => validateCoordinatorConfig(manifest({ mode: "submit" })), /approval-only/);
  assert.throws(() => validateCoordinatorConfig(manifest({ maximumApprovals: 101 })), /maximum approvals/);
  assert.throws(() => validateCoordinatorConfig(manifest({ policy: { ...manifest().policy, cronosRouteId: `0x${"11".repeat(32)}` } })), /route/);
});

test("binds the coordinator manifest to its immutable release directory", () => {
  assert.equal(verifyCoordinatorRelease(manifest(), `/opt/xitcoin-bridge-relayer/${"a".repeat(40)}/src/coordinator-cli.js`), "a".repeat(40));
  assert.throws(() => verifyCoordinatorRelease(manifest(), `/opt/xitcoin-bridge-relayer/${"b".repeat(40)}/src/coordinator-cli.js`), /does not match/);
  assert.throws(() => verifyCoordinatorRelease(manifest(), "/opt/xitcoin-bridge-relayer/current/src/coordinator-cli.js"), /does not match/);
});

test("composes watchers, authenticated signers and an approval-only cycle", async () => {
  const calls = [];
  const store = { close() { calls.push("close"); } };
  const runtime = await buildApprovalOnlyCoordinator(manifest(), { credentialsDirectory: "/run/credentials/coordinator",
    connectCronos: async () => ["provider-1", "provider-2"], connectXitcoin: async () => ["client-1", "client-2"],
    makeSignerClients: async (options) => { calls.push(["signers", options.credentialsDirectory]); return ["signer-1", "signer-2", "signer-3"]; },
    makeCronosWatcher: (options) => ({ type: "cronos", options }), makeXitcoinWatcher: (options) => ({ type: "xitcoin", options }),
    makeStore: (path) => { calls.push(["store", path]); return store; },
    runCycle: async (options) => { calls.push(["cycle", options.clients.length]); return { mode: "approval_only", approved: 0, submissions: 0 }; },
  });
  const report = await runtime.runOnce();
  assert.deepEqual(report, { mode: "approval_only", approved: 0, submissions: 0 });
  assert.ok(calls.some((item) => item[0] === "signers" && item[1] === "/run/credentials/coordinator"));
  assert.ok(calls.some((item) => item[0] === "cycle" && item[1] === 3));
  runtime.close();
  assert.equal(calls.at(-1), "close");
});
