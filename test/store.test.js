import test from "node:test";
import assert from "node:assert/strict";
import { RelayStore } from "../src/store.js";

function observed() {
  return {
    sourceChain: "cronos:25",
    sourceRef: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    routeId: "cronos-xitcoin-xtc-v1",
    blockHeight: 123,
    blockHash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    payload: { amount: "1000000000000000000" },
  };
}

test("persists an idempotent lifecycle", () => {
  const store = new RelayStore();
  assert.equal(store.observe(observed()).state, "observed");
  assert.equal(store.observe(observed()).state, "observed");
  assert.equal(store.transition("cronos:25", observed().sourceRef, "finalized").state, "finalized");
  assert.equal(store.transition("cronos:25", observed().sourceRef, "approved").state, "approved");
  assert.equal(store.pending().length, 1);
  store.transition("cronos:25", observed().sourceRef, "submitted", { destinationRef: "tx-1" });
  store.transition("cronos:25", observed().sourceRef, "completed");
  assert.equal(store.pending().length, 0);
  store.close();
});

test("rejects lifecycle regression", () => {
  const store = new RelayStore();
  store.observe(observed());
  store.transition("cronos:25", observed().sourceRef, "finalized");
  assert.throws(() => store.transition("cronos:25", observed().sourceRef, "observed"));
  store.close();
});

test("persists monotonic canonical checkpoints", () => {
  const store = new RelayStore();
  const hashOne = `0x${"11".repeat(32)}`;
  const hashTwo = `0x${"22".repeat(32)}`;
  assert.equal(store.advanceCheckpoint("cronos", 100, hashOne).block_height, 100);
  assert.equal(store.advanceCheckpoint("cronos", 101, hashTwo).block_hash, hashTwo);
  assert.throws(() => store.advanceCheckpoint("cronos", 100, hashOne), /regression/);
  assert.throws(() => store.advanceCheckpoint("cronos", 101, hashOne), /finality violation/);
  store.close();
});
