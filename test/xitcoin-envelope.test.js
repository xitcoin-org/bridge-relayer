import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, sha256 } from "ethers";
import { prepareXitcoinEnvelope, inspectXitcoinEnvelopeSignature } from "../src/xitcoin-envelope.js";
import { keys } from "./fixtures/destination.js";
import { envelopeInput } from "./fixtures/envelope.js";
const failure = { message: "invalid offline Xitcoin envelope" };
const signature = (plan, key = keys[2]) => { const sig = key.sign(plan.signingDigest); return sig.serialized.slice(0,130) + sig.yParity.toString(16).padStart(2,"0"); };
test("ordered direct envelope uses exact bytes, Keccak signing and immutable offline output", () => {
  const input = envelopeInput(), plan = prepareXitcoinEnvelope(input);
  assert.deepEqual(plan, prepareXitcoinEnvelope(input));
  assert.equal(plan.signingDigest, keccak256(plan.signDocHex));
  assert.equal(plan.signDocDigest, sha256(plan.signDocHex));
  const result = inspectXitcoinEnvelopeSignature(plan, signature(plan));
  assert.deepEqual(result, inspectXitcoinEnvelopeSignature(plan, signature(plan)));
  assert.equal(result.transactionDigest, sha256(result.signedHex));
  assert.equal(result.mayBroadcast, false); assert.equal(result.finalized, false);
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.blockers));
  assert.throws(() => inspectXitcoinEnvelopeSignature({ ...plan }, signature(plan)), failure);
});
test("chain, account, public key, sequence, fee, sign mode and timeout never coerce", () => {
  for (const patch of [{ sequence: "-1" }, { sequence: 0 }, { accountNumber: "01" },
    { sequence: (1n << 64n).toString() }, { accountNumber: (1n << 64n).toString() },
    { chainId: "xitcoin-mainnet" }, { publicKeyHex: keys[1].compressedPublicKey }, { blockHash: `0x${"00".repeat(32)}` }]) {
    const input = envelopeInput(); assert.throws(() => prepareXitcoinEnvelope({ ...input, account: { ...input.account, ...patch } }), failure);
  }
  for (const patch of [{ gasLimit: "300001" }, { amount: "201" }, { amount: "0" }, { denom: "xtc" }]) {
    const input = envelopeInput(); assert.throws(() => prepareXitcoinEnvelope({ ...input, fee: { ...input.fee, ...patch } }), failure);
  }
  for (const patch of [{ signMode: "SIGN_MODE_LEGACY_AMINO_JSON" }, { timeoutHeight: -1 }, { memo: "hidden" }])
    assert.throws(() => prepareXitcoinEnvelope({ ...envelopeInput(), ...patch }), failure);
});
test("mutated approvals and signatures cannot produce an accepted envelope", () => {
  const input = envelopeInput(); input.attestation.request.payload.amount = "11";
  assert.throws(() => prepareXitcoinEnvelope(input), failure);
  const plan = prepareXitcoinEnvelope(envelopeInput());
  for (const sig of [signature(plan, keys[1]), "0x", signature(plan) + "00", signature(plan).slice(0,130) + "1b", `0x${"ff".repeat(64)}00`])
    assert.throws(() => inspectXitcoinEnvelopeSignature(plan, sig), failure);
  let calls = 0;
  assert.throws(() => prepareXitcoinEnvelope({ get attestation() { calls++; throw Error("secret"); } }), failure);
  assert.equal(calls, 0);
});
test("uint64 maximum account and sequence remain exact in protobuf", () => {
  const input = envelopeInput(), max = ((1n<<64n)-1n).toString();
  input.account.accountNumber = max; input.account.sequence = max; input.timeoutHeight = max;
  const plan = prepareXitcoinEnvelope(input);
  assert.equal(plan.sequence, max); assert.equal(plan.accountNumber, max);
  assert(plan.signDocHex.endsWith('20ffffffffffffffffff01'));
  assert.equal(inspectXitcoinEnvelopeSignature(plan, signature(plan)).mayBroadcast, false);
});

test("synthetic vector remains byte-identical after independent protobuf validation", async () => {
  const { readFile } = await import("node:fs/promises");
  const vector = JSON.parse(await readFile(new URL("./fixtures/xitcoin-envelope-vector.json", import.meta.url)));
  const plan = prepareXitcoinEnvelope(vector.input);
  assert.deepEqual(plan, vector.plan);
  assert.deepEqual(inspectXitcoinEnvelopeSignature(plan, vector.signatureHex), vector.result);
});
