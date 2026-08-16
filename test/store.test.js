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
