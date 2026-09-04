import test from "node:test";
import assert from "node:assert/strict";

import { approveFinalizedTransfer, buildTransferApprovalRequest, scanFinalizedBatch } from "../src/coordinator.js";
import { buildApprovalRequest } from "../src/approvals.js";
import { DIRECTION_INBOUND } from "../src/protocol.js";
import { SigningKey, computeAddress } from "ethers";
import { randomBytes } from "node:crypto";
import { RelayStore } from "../src/store.js";
import { FinalityViolation } from "../src/watchers.js";

const blockHash = `0x${"11".repeat(32)}`;
const txHash = `0x${"22".repeat(32)}`;
const routeBytes = `0x${"33".repeat(32)}`;
const vault = "0x1111111111111111111111111111111111111111";

function watcher(overrides = {}) {
  return {
    async latestFinalizedHeight() { return 12; },
    async events(from, to) {
      return [{
        sourceChain: "cronos", sourceRef: "deposit-1", routeId: "route",
        blockHeight: from, blockHash, payload: { amount: "10" },
      }];
    },
    async verifyCanonicalEvent() { return true; },
    async canonicalBlock(height) { return { number: height, hash: blockHash }; },
    ...overrides,
  };
}

test("scan loop finalizes observations and advances a canonical checkpoint", async () => {
  const store = new RelayStore();
  const result = await scanFinalizedBatch({ watcher: watcher(), store, sourceChain: "cronos", startHeight: 10, maxBatch: 2 });
  assert.deepEqual(result, { from: 10, to: 11, observed: 1, idle: false });
  assert.equal(store.get("cronos", "deposit-1").state, "finalized");
  assert.equal(store.checkpoint("cronos").block_height, 11);
  const resumed = await scanFinalizedBatch({ watcher: watcher(), store, sourceChain: "cronos", startHeight: 1, maxBatch: 2 });
  assert.equal(resumed.from, 12);
  assert.equal(resumed.to, 12);
  store.close();
});

test("maps an exact Cronos event to one canonical inbound approval request", () => {
  const store = new RelayStore();
  const depositId = `0x${"44".repeat(32)}`;
  store.observe({ sourceChain: "cronos", sourceRef: depositId.slice(2), routeId: routeBytes,
    blockHeight: 10, blockHash, transactionHash: txHash, logIndex: 2,
    payload: { depositId, nonce: "7", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "10" } });
  const transfer = store.transition("cronos", depositId.slice(2), "finalized");
  const request = buildTransferApprovalRequest({ transfer, routeId: "cronos-testnet-xitcoin-testnet",
    cronosRouteId: routeBytes, cronosChainId: 338, cronosVault: vault, deadlineUnix: 2_000_000_000 });
  assert.equal(request.direction, "cronos_to_xitcoin");
  assert.equal(request.payload.routeId, "cronos-testnet-xitcoin-testnet");
  assert.equal(request.payload.sourceRef, depositId);
  assert.deepEqual(request.payload.sourceEvidence, { blockHeight: 10, blockHash, transactionHash: txHash, eventIndex: 2 });
  store.close();
});

test("maps an exact Xitcoin event to one canonical outbound approval request", () => {
  const store = new RelayStore();
  const requestId = `0x${"55".repeat(32)}`;
  store.observe({ sourceChain: "xitcoin", sourceRef: requestId, routeId: "cronos-testnet-xitcoin-testnet",
    blockHeight: 11, blockHash, transactionHash: txHash, messageIndex: 3,
    payload: { requestId, destination: "0x2222222222222222222222222222222222222222", amount: "20", nonce: "8" } });
  const transfer = store.transition("xitcoin", requestId, "finalized");
  const request = buildTransferApprovalRequest({ transfer, routeId: "cronos-testnet-xitcoin-testnet",
    cronosRouteId: routeBytes, cronosChainId: 338, cronosVault: vault, signerSetVersion: 1, deadlineUnix: 2_000_000_000 });
  assert.equal(request.direction, "xitcoin_to_cronos");
  assert.equal(request.payload.sourceBurnId, requestId);
  assert.equal(request.payload.chainId, 338);
  assert.deepEqual(request.payload.sourceEvidence, { blockHeight: 11, blockHash, transactionHash: txHash, eventIndex: 3 });
  store.close();
});

test("refuses ambiguous or mismatched stored source evidence", () => {
  const store = new RelayStore();
  const depositId = `0x${"66".repeat(32)}`;
  store.observe({ sourceChain: "cronos", sourceRef: depositId, routeId: routeBytes,
    blockHeight: 10, blockHash, payload: { depositId, nonce: "1", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "1" } });
  const transfer = store.transition("cronos", depositId, "finalized");
  assert.throws(() => buildTransferApprovalRequest({ transfer, routeId: "cronos-testnet-xitcoin-testnet",
    cronosRouteId: routeBytes, cronosChainId: 338, cronosVault: vault, deadlineUnix: 2_000_000_000 }), /bytes32/);
  store.close();
});

test("scan loop remains idle at the finalized tip", async () => {
  const store = new RelayStore();
  store.advanceCheckpoint("cronos", 12, blockHash);
  const result = await scanFinalizedBatch({ watcher: watcher(), store, sourceChain: "cronos" });
  assert.equal(result.idle, true);
  assert.equal(result.observed, 0);
  store.close();
});

test("scan loop stops before checkpointing invalid source or block identity", async () => {
  const store = new RelayStore();
  await assert.rejects(() => scanFinalizedBatch({
    watcher: watcher({ async events() { return [{
      sourceChain: "xitcoin", sourceRef: "wrong", routeId: "route",
      blockHeight: 10, blockHash, payload: {},
    }]; } }),
    store, sourceChain: "cronos", startHeight: 10,
  }), FinalityViolation);
  assert.equal(store.checkpoint("cronos"), undefined);

  await assert.rejects(() => scanFinalizedBatch({
    watcher: watcher({ async events() { return []; }, async canonicalBlock() { return { number: 9, hash: blockHash }; } }),
    store, sourceChain: "cronos", startHeight: 10,
  }), FinalityViolation);
  assert.equal(store.checkpoint("cronos"), undefined);
  store.close();
});

test("approval coordinator advances only after a valid quorum and is restart-safe", async () => {
  const store = new RelayStore();
  const record = { sourceChain: "cronos", sourceRef: `0x${"aa".repeat(32)}`, routeId: "route", blockHeight: 10, blockHash, payload: { amount: "10" } };
  store.observe(record);
  store.transition("cronos", record.sourceRef, "finalized");
  const keys = Array.from({ length: 3 }, () => new SigningKey(randomBytes(32)));
  const addresses = keys.map((key) => computeAddress(key.publicKey));
  const request = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
    routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: record.sourceRef,
    nonce: "7", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "10", deadlineUnix: 2_000_000_000,
  } });
  const clients = keys.slice(0, 2).map((key, index) => ({ identity: `signer-${index}`, async approve(value) {
    return { digest: value.digest, signer: addresses[index], signature: key.sign(value.digest).serialized };
  } }));
  const result = await approveFinalizedTransfer({ store, sourceChain: "cronos", sourceRef: record.sourceRef, request, clients, authorizedSigners: addresses, nowUnix: 1_900_000_000 });
  assert.equal(result.transfer.state, "approved");
  assert.equal(result.approvals.length, 2);
  assert.equal(store.approvalRequest("cronos", record.sourceRef).digest, request.digest);
  const restarted = await approveFinalizedTransfer({ store, sourceChain: "cronos", sourceRef: record.sourceRef, request, clients, authorizedSigners: addresses, nowUnix: 1_900_000_000 });
  assert.equal(restarted.idempotent, true);
  store.close();
});

test("approval coordinator never changes a persisted request after a failed quorum", async () => {
  const store = new RelayStore();
  const record = { sourceChain: "cronos", sourceRef: `0x${"cc".repeat(32)}`, routeId: "route", blockHeight: 10, blockHash, payload: { amount: "10" } };
  store.observe(record);
  store.transition("cronos", record.sourceRef, "finalized");
  const keys = Array.from({ length: 3 }, () => new SigningKey(randomBytes(32)));
  const addresses = keys.map((key) => computeAddress(key.publicKey));
  const request = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
    routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: record.sourceRef,
    nonce: "7", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "10", deadlineUnix: 2_000_000_000,
  } });
  await assert.rejects(() => approveFinalizedTransfer({
    store, sourceChain: "cronos", sourceRef: record.sourceRef, request, clients: [], authorizedSigners: addresses, nowUnix: 1_900_000_000,
  }), /insufficient/);
  assert.equal(store.approvalRequest("cronos", record.sourceRef).digest, request.digest);
  await assert.rejects(() => approveFinalizedTransfer({
    store, sourceChain: "cronos", sourceRef: record.sourceRef,
    request: buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: { ...request.payload, deadlineUnix: 2_000_000_001 } }),
    clients: [], authorizedSigners: addresses, nowUnix: 1_900_000_000,
  }), /conflicting/);
  store.close();
});
