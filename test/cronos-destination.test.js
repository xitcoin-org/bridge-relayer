import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, Interface } from "ethers";
import { prepareCronosRelease, inspectCronosSignedTransaction, inspectCronosInclusion, requireCronosCustody } from "../src/cronos-destination.js";
import { outbound, signedBytes, inclusion } from "./fixtures/cronos.js";
import { keys, sign } from "./fixtures/destination.js";
const rejects = (fn) => assert.throws(fn, { message: "invalid Cronos destination evidence" });
test("exact reviewed release call, signed-byte hash and custody binding, permanently offline", () => {
  const input = outbound(), plan = prepareCronosRelease(input);
  const args = new Interface(["function release(bytes32,address,uint256,uint64,uint256,bytes[])"]).decodeFunctionData("release", plan.data);
  assert.equal(args[0], input.request.payload.sourceBurnId);
  assert.equal(args[2], 10n);
  const bytes = signedBytes(plan), signed = inspectCronosSignedTransaction(plan, bytes);
  assert.equal(signed.transactionHash, keccak256(bytes));
  assert.equal(signed.signedHex, bytes);
  assert.equal(signed.codeHash, input.identity.codeHash);
  assert.equal(signed.routeId, input.identity.routeId);
  assert.equal(signed.vault, input.identity.vault);
  assert.equal(signed.mayBroadcast, false);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(signed));
  rejects(() => requireCronosCustody({ ...signed }));
});
test("chain, identity, pause, replay, route, version and authorized quorum failures", () => {
  for (const state of [{ chainId: 25 }, { vault: outbound().request.payload.recipient }, { codeHash: `0x${"aa".repeat(32)}` },
    { routeId: `0x${"aa".repeat(32)}` }, { paused: true }, { processed: true }, { signerSetVersion: "2" }]) {
    const input = outbound(); rejects(() => prepareCronosRelease({ ...input, state: { ...input.state, ...state } }));
  }
  for (const indexes of [[0], [0, 0], [0, 3]]) {
    const input = outbound(); rejects(() => prepareCronosRelease({ ...input, approvals: sign(input.request, indexes) }));
  }
  const input = outbound();
  rejects(() => prepareCronosRelease({ ...input, request: { ...input.request, digest: `0x${"aa".repeat(32)}` } }));
});
test("fee, gas and nonce bounds never coerce or overflow", () => {
  for (const tx of [{ nonce: "9007199254740992" }, { nonce: "-1" }, { nonce: 0 }, { gasLimit: "300001" },
    { gasPrice: "2000000001" }, { gasLimit: (1n << 256n).toString() }, { gasPrice: "0" }]) {
    const input = outbound(); rejects(() => prepareCronosRelease({ ...input, transaction: { ...input.transaction, ...tx } }));
  }
  const input = outbound(), huge = ((1n << 256n) - 1n).toString();
  rejects(() => prepareCronosRelease({ ...input, transaction: { nonce: "0", gasLimit: huge, gasPrice: huge },
    limits: { maxGas: huge, maxGasPrice: huge, maxFee: huge } }));
});
test("signed transaction cannot change chain, call, value, sender, nonce, fees or type", () => {
  const plan = prepareCronosRelease(outbound());
  for (const patch of [{ chainId: 25 }, { data: "0x" }, { value: 1 }, { nonce: 1 }, { gasLimit: 1 },
    { gasPrice: 1 }, { to: outbound().request.payload.recipient }, { type: 1 }]) {
    rejects(() => inspectCronosSignedTransaction(plan, signedBytes(plan, patch)));
  }
  rejects(() => inspectCronosSignedTransaction(plan, signedBytes(plan, {}, keys[0])));
  rejects(() => inspectCronosSignedTransaction({ ...plan }, signedBytes(plan)));
  for (const bytes of ["0x", "0xzz", "0x" + "ff".repeat(20_000), signedBytes(plan) + "00"])
    rejects(() => inspectCronosSignedTransaction(plan, bytes));
});
test("successful simulated inclusion still needs finality; failed execution is explicit", () => {
  const plan = prepareCronosRelease(outbound()), signed = inspectCronosSignedTransaction(plan, signedBytes(plan));
  const evidence = inclusion(plan, signed);
  assert.deepEqual(inspectCronosInclusion(plan, signed, evidence), {
    failed: false, included: true, finalized: false, mayBroadcast: false, blocker: "independent_canonical_finality_required" });
  assert.equal(inspectCronosInclusion(plan, signed, { ...evidence, status: "0x0", logs: [] }).failed, true);
  for (const patch of [{ canonicalBlockHash: `0x${"ff".repeat(32)}` }, { transactionHash: `0x${"ff".repeat(32)}` },
    { status: "0x2" }, { chainId: 25 }, { logs: [] }, { logs: [...evidence.logs, ...evidence.logs] }])
    rejects(() => inspectCronosInclusion(plan, signed, { ...evidence, ...patch }));
  for (const patch of [{ removed: true }, { address: outbound().request.payload.recipient },
    { data: "0x" }, { topics: [evidence.logs[0].topics[0], `0x${"ff".repeat(32)}`, evidence.logs[0].topics[2]] }])
    rejects(() => inspectCronosInclusion(plan, signed, { ...evidence, logs: [{ ...evidence.logs[0], ...patch }] }));
});

// Regression: shared approval verification accepts Xitcoin 0/1 recovery bytes,
// but passing them unchanged to the reviewed EVM vault would revert.
test("Cronos requires original vault-compatible recovery bytes", () => {
  for (const index of [0, 1]) {
    const input = outbound();
    const signature = input.approvals[index].signature;
    input.approvals[index].signature = signature.slice(0, 130)
      + (Number.parseInt(signature.slice(130), 16) - 27).toString(16).padStart(2, "0");
    rejects(() => prepareCronosRelease(input));
  }
  const input = outbound();
  rejects(() => prepareCronosRelease({ ...input, approvals: [...input.approvals].reverse() }));
});
