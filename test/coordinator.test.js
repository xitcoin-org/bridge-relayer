import test from "node:test";
import assert from "node:assert/strict";

import { scanFinalizedBatch } from "../src/coordinator.js";
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
