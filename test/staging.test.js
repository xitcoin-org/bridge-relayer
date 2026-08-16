import test from "node:test";
import assert from "node:assert/strict";
import { SigningKey, computeAddress } from "ethers";

import { buildApprovalRequest } from "../src/approvals.js";
import { approveFinalizedTransfer, scanFinalizedBatch } from "../src/coordinator.js";
import { DIRECTION_INBOUND } from "../src/protocol.js";
import { FaultPlan, StagingFault, StagingHarness } from "../src/staging.js";
import { RelayStore } from "../src/store.js";
import { submitApprovedTransfer } from "../src/submission.js";
import { FinalityViolation } from "../src/watchers.js";

const SOURCE_REF = `0x${"aa".repeat(32)}`;
const BLOCK_HASH = `0x${"11".repeat(32)}`;
const TX_HASH = `0x${"bb".repeat(32)}`;
const KEYS = ["01", "02", "03"].map((value) => new SigningKey(`0x${value.padStart(64, "0")}`));
const ADDRESSES = KEYS.map((key) => computeAddress(key.publicKey));
const REQUEST = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
  routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: SOURCE_REF, nonce: "7",
  destination: "xitcoin1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3rsflhv", amount: "10", deadlineUnix: 2_000_000_000,
} });

function record() {
  return { sourceChain: "cronos", sourceRef: SOURCE_REF, routeId: "cronos-xitcoin-xtc-v1", blockHeight: 10, blockHash: BLOCK_HASH, payload: REQUEST.payload };
}

function approvedStore() {
  const store = new RelayStore();
  store.observe(record());
  store.transition("cronos", SOURCE_REF, "finalized");
  for (const key of KEYS.slice(0, 2)) store.recordApproval("cronos", SOURCE_REF, { signer: computeAddress(key.publicKey), digest: REQUEST.digest, signature: key.sign(REQUEST.digest).serialized });
  store.transition("cronos", SOURCE_REF, "approved");
  return store;
}

test("runs a deterministic end-to-end rehearsal with one signer offline", async () => {
  const store = new RelayStore();
  let broadcasts = 0;
  const harness = new StagingHarness({ scenarios: [
    { name: "finalized_source", async run() { store.observe(record()); store.transition("cronos", SOURCE_REF, "finalized"); } },
    { name: "two_of_three_quorum", async run() {
      const clients = KEYS.map((key, index) => ({ identity: `signer-${index + 1}`, async approve(request) {
        if (index === 2) throw new Error("offline");
        return { signer: ADDRESSES[index], digest: request.digest, signature: key.sign(request.digest).serialized };
      } }));
      const result = await approveFinalizedTransfer({ store, sourceChain: "cronos", sourceRef: SOURCE_REF, request: REQUEST, clients, authorizedSigners: ADDRESSES, nowUnix: 1_900_000_000 });
      assert.equal(result.approvals.length, 2);
    } },
    { name: "destination_finality", async run() {
      const adapter = { async status() { return { processed: false }; }, async submit() { broadcasts += 1; return TX_HASH; }, async confirm() { return { finalized: true, canonical: true }; } };
      assert.equal((await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: SOURCE_REF, request: REQUEST, adapter })).transfer.state, "completed");
      assert.equal((await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: SOURCE_REF, request: REQUEST, adapter })).idempotent, true);
    } },
  ], now: () => 1000 });
  const report = await harness.run();
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 3);
  assert.equal(broadcasts, 1);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/);
  store.close();
});

test("RPC disagreement stops before a canonical checkpoint", async () => {
  const store = new RelayStore();
  const watcher = { async latestFinalizedHeight() { return 10; }, async events() { return [record()]; }, async verifyCanonicalEvent() { throw new FinalityViolation("RPC disagreement"); }, async canonicalBlock() { return { number: 10, hash: BLOCK_HASH }; } };
  await assert.rejects(() => scanFinalizedBatch({ watcher, store, sourceChain: "cronos", startHeight: 10 }), FinalityViolation);
  assert.equal(store.checkpoint("cronos"), undefined);
  store.close();
});

test("recovers after a crash without a second destination broadcast", async () => {
  const store = approvedStore();
  let broadcasts = 0;
  const adapter = { async status() { return { processed: true, canonical: true, destinationRef: TX_HASH }; }, async submit() { broadcasts += 1; return TX_HASH; }, async confirm() { return { finalized: true, canonical: true }; } };
  const result = await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: SOURCE_REF, request: REQUEST, adapter });
  assert.equal(result.transfer.state, "completed");
  assert.equal(broadcasts, 0);
  store.close();
});

test("fault plan injects a named failure exactly once", () => {
  const faults = new FaultPlan([{ point: "after_submission", code: "crash_after_submission" }]);
  assert.throws(() => faults.hit("after_submission"), (error) => error instanceof StagingFault && error.code === "crash_after_submission");
  assert.equal(faults.hit("after_submission"), false);
});

test("staging report never includes raw failure details", async () => {
  const harness = new StagingHarness({ scenarios: [
    { name: "private_failure", async run() { throw new Error("secret endpoint and signature"); } },
    { name: "must_not_run", async run() { throw new Error("unexpected"); } },
  ], now: () => 1000 });
  const report = await harness.run();
  assert.equal(report.passed, false);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].code, "scenario_failed");
  assert.equal(JSON.stringify(report).includes("secret endpoint"), false);
});
