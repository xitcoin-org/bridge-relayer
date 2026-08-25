import test from "node:test";
import assert from "node:assert/strict";
import { Interface, SigningKey, computeAddress } from "ethers";

import { buildApprovalRequest } from "../src/approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND } from "../src/protocol.js";
import { RelayStore } from "../src/store.js";
import { DestinationViolation, buildCronosSubmission, buildXitcoinSubmission, submitApprovedTransfer } from "../src/submission.js";

const ref = `0x${"aa".repeat(32)}`;
const tx = `0x${"bb".repeat(32)}`;
const blockHash = `0x${"11".repeat(32)}`;
const keys = ["01", "02"].map((x) => new SigningKey(`0x${x.padStart(64, "0")}`));

function approvals(request) {
  return keys.map((key) => ({ signer: computeAddress(key.publicKey).toLowerCase(), digest: request.digest,
    signature: key.sign(request.digest).serialized }));
}

function approvedStore(request) {
  const store = new RelayStore();
  store.observe({ sourceChain: "cronos", sourceRef: ref, routeId: "cronos-xitcoin-xtc-v1", blockHeight: 7, blockHash, payload: request.payload });
  store.transition("cronos", ref, "finalized");
  for (const approval of approvals(request)) store.recordApproval("cronos", ref, approval);
  store.transition("cronos", ref, "approved");
  return store;
}

const inbound = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
  routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: ref, nonce: "7",
  destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "10", deadlineUnix: 2_000_000_000,
} });

test("builds the exact Xitcoin attestation submission", () => {
  const message = buildXitcoinSubmission({ request: inbound, approvals: approvals(inbound), submitter: "xtc1xvenxvenxvenxvenxvenxvenxvenxvenhqlh4q" });
  assert.equal(message.direction, DIRECTION_INBOUND);
  assert.equal(message.nonce, "7");
  assert.equal(message.signatures.length, 2);
  assert.match(message.attestationId, /^0x[0-9a-f]{64}$/);
});

test("encodes the canonical Cronos vault release call", () => {
  const vault = "0x1000000000000000000000000000000000000001";
  const outbound = buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
    chainId: 25, vault, sourceBurnId: ref, recipient: "0x2000000000000000000000000000000000000002",
    amount: "10", signerSetVersion: "1", deadline: "2000000000",
  } });
  const call = buildCronosSubmission({ request: outbound, approvals: approvals(outbound), vault });
  const decoded = new Interface(["function release(bytes32,address,uint256,uint64,uint256,bytes[])"]).decodeFunctionData("release", call.data);
  assert.equal(decoded[0], ref);
  assert.equal(decoded[2], 10n);
  assert.equal(decoded[5].length, 2);
});

test("submits once, waits for finality and completes idempotently", async () => {
  const store = approvedStore(inbound);
  let submissions = 0;
  const adapter = {
    async status() { return { processed: false }; },
    async submit() { submissions += 1; return tx; },
    async confirm() { return { finalized: true, canonical: true }; },
  };
  const result = await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: ref, request: inbound, adapter });
  assert.equal(result.transfer.state, "completed");
  const again = await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: ref, request: inbound, adapter });
  assert.equal(again.idempotent, true);
  assert.equal(submissions, 1);
  store.close();
});

test("recovers a processed destination after a crash without rebroadcasting", async () => {
  const store = approvedStore(inbound);
  let submissions = 0;
  const result = await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: ref, request: inbound, adapter: {
    async status() { return { processed: true, canonical: true, destinationRef: tx }; },
    async submit() { submissions += 1; return tx; },
    async confirm() { return { finalized: true, canonical: true }; },
  } });
  assert.equal(result.transfer.state, "completed");
  assert.equal(submissions, 0);
  store.close();
});

test("keeps a submitted transfer pending and rejects a destination mismatch", async () => {
  const store = approvedStore(inbound);
  const adapter = { async status() { return { processed: false }; }, async submit() { return tx; }, async confirm() { return { finalized: false }; } };
  const pending = await submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: ref, request: inbound, adapter });
  assert.equal(pending.transfer.state, "submitted");
  adapter.confirm = async () => ({ finalized: true, canonical: false });
  await assert.rejects(() => submitApprovedTransfer({ store, sourceChain: "cronos", sourceRef: ref, request: inbound, adapter }), DestinationViolation);
  store.close();
});
