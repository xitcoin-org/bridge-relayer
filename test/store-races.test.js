import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { RelayStore } from "../src/store.js";
const ref = `0x${"aa".repeat(32)}`, block = `0x${"bb".repeat(32)}`;
function fixture(run) {
  const dir = mkdtempSync("/tmp/relay-race-"), first = new RelayStore(`${dir}/relay.sqlite`), second = new RelayStore(`${dir}/relay.sqlite`);
  try {
    first.observe({ sourceChain: "cronos", sourceRef: ref, routeId: "test", blockHeight: 1, blockHash: block, payload: { amount: "1" } });
    first.transition("cronos", ref, "finalized");
    run(first, second);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
}
// Deterministic scheduler: a second SQLite connection commits after the first
// connection's read and before its write, exposing the actual SQL TOCTOU boundary.
function interleave(object, method, action) {
  const original = object[method].bind(object);
  let pending = true;
  object[method] = (...args) => { const stale = original(...args); if (pending) { pending = false; action(); } return stale; };
}
test("stale worker cannot regress completed lifecycle to approved", () => fixture((a, b) => {
  interleave(a, "get", () => {
    b.transition("cronos", ref, "approved"); b.transition("cronos", ref, "submitted", { destinationRef: "tx-1" });
    b.transition("cronos", ref, "completed");
  });
  assert.throws(() => a.transition("cronos", ref, "approved"), /concurrent/);
  assert.equal(b.get("cronos", ref).state, "completed"); assert.equal(b.get("cronos", ref).destination_ref, "tx-1");
}));
test("failed, reorged and completed rows cannot change terminal state", () => {
  for (const terminal of ["failed", "reorged", "completed"]) fixture((a) => {
    if (terminal === "completed") { a.transition("cronos", ref, "approved"); a.transition("cronos", ref, "submitted"); }
    a.transition("cronos", ref, terminal);
    for (const next of ["observed", "finalized", "approved", "submitted", "completed", "failed", "reorged"])
      assert.throws(() => a.transition("cronos", ref, next), /terminal/);
  });
});
test("competing submitted references cannot overwrite the winner", () => fixture((a, b) => {
  a.transition("cronos", ref, "approved");
  interleave(a, "get", () => b.transition("cronos", ref, "submitted", { destinationRef: "winner" }));
  assert.throws(() => a.transition("cronos", ref, "submitted", { destinationRef: "loser" }), /concurrent/);
  assert.equal(b.get("cronos", ref).destination_ref, "winner");
  assert.throws(() => b.transition("cronos", ref, "completed", { destinationRef: "replacement" }), /immutable/);
}));
test("stale checkpoint worker cannot lower height or replace canonical hash", () => {
  for (const sameHeight of [false, true]) fixture((a, b) => {
    a.advanceCheckpoint("cronos", 1, block);
    interleave(a, "checkpoint", () => b.advanceCheckpoint("cronos", sameHeight ? 2 : 3, `0x${"cc".repeat(32)}`));
    assert.throws(() => a.advanceCheckpoint("cronos", 2, block), /concurrent/);
    assert.equal(b.checkpoint("cronos").block_height, sameHeight ? 2 : 3);
    assert.equal(b.checkpoint("cronos").block_hash, `0x${"cc".repeat(32)}`);
  });
});
test("a racing request cannot silently adopt another worker's approval", () => fixture((a, b) => {
  const request = { version: 1, payload: { amount: "1" } }, other = { version: 1, payload: { amount: "2" } };
  interleave(a, "get", () => b.persistApprovalRequest("cronos", ref, other));
  assert.throws(() => a.persistApprovalRequest("cronos", ref, request), /conflicting/);
  assert.deepEqual(b.approvalRequest("cronos", ref), other);
}));
