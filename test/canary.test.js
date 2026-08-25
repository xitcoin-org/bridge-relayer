import test from "node:test";
import assert from "node:assert/strict";

import { CanarySession, validateCanaryPlan } from "../src/canary.js";

const HASHES = ["11", "22", "33", "44"].map((byte) => byte.repeat(32));

function plan(overrides = {}) {
  return {
    releaseCommit: "4e72eda2b64b448bff07e90fc12cda51513d5064",
    decisionId: "aa".repeat(32),
    preflightDigest: "bb".repeat(32),
    routeId: "cronos-xitcoin-xtc-v1",
    cronosChainId: "25",
    xitcoinChainId: "xitcoin-testnet-1",
    startsAtUnix: 1000,
    expiresAtUnix: 1600,
    maximumTransfers: 2,
    maximumAmount: "1000000000000000000",
    directions: ["cronos_to_xitcoin", "xitcoin_to_cronos"],
    ...overrides,
  };
}

function transfer(index, overrides = {}) {
  return { direction: index === 0 ? "cronos_to_xitcoin" : "xitcoin_to_cronos", amount: "10", sourceTxHash: HASHES[index * 2], destinationTxHash: HASHES[index * 2 + 1], sourceFinalized: true, destinationFinalized: true, canonical: true, duplicateBroadcasts: 0, ...overrides };
}

test("completes exactly one bounded transfer in each canonical direction", () => {
  const session = new CanarySession({ plan: plan(), nowUnix: () => 1200 });
  session.authorize({ preflightPassed: true, preflightDigest: "bb".repeat(32) });
  assert.equal(session.recordFinalizedTransfer(transfer(0)), true);
  assert.equal(session.recordFinalizedTransfer(transfer(1)), true);
  const report = session.complete();
  assert.equal(report.passed, true);
  assert.equal(report.evidence.length, 2);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/);
});

test("rejects moving releases, excessive windows and noncanonical limits", () => {
  assert.throws(() => validateCanaryPlan(plan({ releaseCommit: "main" })), /immutable/);
  assert.throws(() => validateCanaryPlan(plan({ expiresAtUnix: 5000 })), /one hour/);
  assert.throws(() => validateCanaryPlan(plan({ maximumTransfers: 3 })), /exactly two/);
  assert.throws(() => validateCanaryPlan(plan({ xitcoinChainId: "xitcoin-testnet" })), /must be xitcoin-testnet-1/);
  assert.throws(() => validateCanaryPlan(plan({ directions: ["xitcoin_to_cronos", "cronos_to_xitcoin"] })), /canonical directions/);
});

test("requires a matching successful preflight inside the authorization window", () => {
  const mismatch = new CanarySession({ plan: plan(), nowUnix: () => 1200 });
  assert.throws(() => mismatch.authorize({ preflightPassed: true, preflightDigest: "cc".repeat(32) }), /matching successful/);
  const expired = new CanarySession({ plan: plan(), nowUnix: () => 2000 });
  assert.throws(() => expired.authorize({ preflightPassed: true, preflightDigest: "bb".repeat(32) }), /window is closed/);
  assert.throws(() => mismatch.recordFinalizedTransfer(transfer(0)), /not authorized/);
});

test("halts on finality failure, excessive amount or duplicate broadcast", () => {
  for (const [record, code] of [
    [transfer(0, { destinationFinalized: false }), "finality_failed"],
    [transfer(0, { amount: "1000000000000000001" }), "destination_mismatch"],
    [transfer(0, { duplicateBroadcasts: 1 }), "duplicate_broadcast"],
  ]) {
    const session = new CanarySession({ plan: plan(), nowUnix: () => 1200 });
    session.authorize({ preflightPassed: true, preflightDigest: "bb".repeat(32) });
    assert.equal(session.recordFinalizedTransfer(record), false);
    assert.equal(session.report().failureCode, code);
  }
});

test("publishes only bounded evidence and sanitized stop codes", () => {
  const session = new CanarySession({ plan: plan(), nowUnix: () => 1200 });
  session.authorize({ preflightPassed: true, preflightDigest: "bb".repeat(32) });
  session.halt("rpc_disagreement");
  const report = session.report();
  assert.equal(report.passed, false);
  assert.equal(report.failureCode, "rpc_disagreement");
  assert.equal(JSON.stringify(report).includes("endpoint"), false);
  assert.equal(JSON.stringify(report).includes("signature"), false);
});
