import assert from "node:assert/strict";
import test from "node:test";
import { id } from "ethers";

import { buildApprovalRequest } from "../src/approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND } from "../src/protocol.js";
import { createCanonicalSourceVerifier } from "../src/source-verification.js";

const blockHash = `0x${"11".repeat(32)}`;
const transactionHash = `0x${"22".repeat(32)}`;
const sourceRef = `0x${"33".repeat(32)}`;
const routeId = "cronos-xitcoin-xtc-v1";
const destination = "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9";
const recipient = "0x3333333333333333333333333333333333333333";

function watcher(record) {
  return {
    verified: 0,
    async events(from, to) {
      assert.equal(from, 100);
      assert.equal(to, 100);
      return [structuredClone(record)];
    },
    async verifyCanonicalEvent(value) {
      assert.deepEqual(value, record);
      this.verified += 1;
      return true;
    },
  };
}

function sourceEvidence(overrides = {}) {
  return { blockHeight: 100, blockHash, transactionHash, eventIndex: 2, ...overrides };
}

test("independently verifies an exact finalized Cronos deposit before signing", async () => {
  const record = {
    sourceChain: "cronos", sourceRef: sourceRef.slice(2), routeId: id(routeId), blockHeight: 100,
    blockHash, transactionHash, logIndex: 2,
    payload: { depositId: sourceRef, destination, amount: "500", nonce: "7" },
  };
  const cronosWatcher = watcher(record);
  const verify = createCanonicalSourceVerifier({ cronosWatcher, xitcoinWatcher: watcher({}) });
  const request = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
    routeId, sourceChainId: "338", sourceRef, nonce: "7", destination, amount: "500",
    deadlineUnix: 1_900_000_300, sourceEvidence: sourceEvidence(),
  } });
  const result = await verify(request);
  assert.deepEqual(result, { canonical: true, finalized: true, digest: request.digest });
  assert.equal(cronosWatcher.verified, 1);
});

test("rejects substituted Cronos evidence before invoking canonical verification", async () => {
  const record = {
    routeId: id(routeId), blockHeight: 100, blockHash, transactionHash, logIndex: 2,
    payload: { depositId: sourceRef, destination, amount: "500", nonce: "7" },
  };
  const cronosWatcher = watcher(record);
  const verify = createCanonicalSourceVerifier({ cronosWatcher, xitcoinWatcher: watcher({}) });
  const request = buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
    routeId, sourceChainId: "338", sourceRef, nonce: "7", destination, amount: "501",
    deadlineUnix: 1_900_000_300, sourceEvidence: sourceEvidence(),
  } });
  await assert.rejects(() => verify(request), /does not match/);
  assert.equal(cronosWatcher.verified, 0);
});

test("independently verifies an exact finalized Xitcoin burn before signing", async () => {
  const record = {
    sourceChain: "xitcoin", sourceRef, routeId, blockHeight: 100, blockHash,
    transactionHash, messageIndex: 2,
    payload: { requestId: sourceRef, destination: recipient, amount: "900", nonce: "4" },
  };
  const xitcoinWatcher = watcher(record);
  const verify = createCanonicalSourceVerifier({ cronosWatcher: watcher({}), xitcoinWatcher });
  const request = buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
    routeId, chainId: 338, vault: "0x1111111111111111111111111111111111111111",
    sourceBurnId: sourceRef, recipient, amount: "900", signerSetVersion: 1,
    deadline: 1_900_000_300, sourceEvidence: sourceEvidence(),
  } });
  const result = await verify(request);
  assert.deepEqual(result, { canonical: true, finalized: true, digest: request.digest });
  assert.equal(xitcoinWatcher.verified, 1);
});

test("rejects missing, moved and ambiguous source evidence", async () => {
  const record = {
    routeId, blockHeight: 100, blockHash, transactionHash, messageIndex: 2,
    payload: { requestId: sourceRef, destination: recipient, amount: "900" },
  };
  const verify = createCanonicalSourceVerifier({ cronosWatcher: watcher({}), xitcoinWatcher: watcher(record) });
  const payload = {
    routeId, chainId: 338, vault: "0x1111111111111111111111111111111111111111",
    sourceBurnId: sourceRef, recipient, amount: "900", signerSetVersion: 1, deadline: 1_900_000_300,
  };
  await assert.rejects(() => verify(buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload })), /evidence is required/);
  await assert.rejects(() => verify(buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
    ...payload, sourceEvidence: sourceEvidence({ transactionHash: `0x${"44".repeat(32)}` }),
  } })), /does not match/);
});
