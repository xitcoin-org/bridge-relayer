import test from "node:test";
import assert from "node:assert/strict";

import { scanFinalizedBatch } from "../src/coordinator.js";
import { approveFinalizedTransfer } from "../src/coordinator.js";
import { buildApprovalRequest } from "../src/approvals.js";
import { DIRECTION_INBOUND } from "../src/protocol.js";
import { SigningKey, computeAddress } from "ethers";
import { randomBytes } from "node:crypto";
import { RelayStore } from "../src/store.js";
import { FinalityViolation } from "../src/watchers.js";

const blockHash = `0x${"11".repeat(32)}`;

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
    nonce: "7", destination: "xitcoin1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3rsflhv", amount: "10", deadlineUnix: 2_000_000_000,
  } });
  const clients = keys.slice(0, 2).map((key, index) => ({ identity: `signer-${index}`, async approve(value) {
    return { digest: value.digest, signer: addresses[index], signature: key.sign(value.digest).serialized };
  } }));
  const result = await approveFinalizedTransfer({ store, sourceChain: "cronos", sourceRef: record.sourceRef, request, clients, authorizedSigners: addresses, nowUnix: 1_900_000_000 });
  assert.equal(result.transfer.state, "approved");
  assert.equal(result.approvals.length, 2);
  const restarted = await approveFinalizedTransfer({ store, sourceChain: "cronos", sourceRef: record.sourceRef, request, clients, authorizedSigners: addresses, nowUnix: 1_900_000_000 });
  assert.equal(restarted.idempotent, true);
  store.close();
});
