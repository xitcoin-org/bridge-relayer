import test from "node:test";
import assert from "node:assert/strict";
import { prepareXitcoinAttestation } from "../src/xitcoin-destination.js";
import { prepareCronosRelease } from "../src/cronos-destination.js";
import { inbound } from "./fixtures/destination.js";
import { outbound } from "./fixtures/cronos.js";

// Minimal independent protobuf reader for the two wire types in the pinned
// message. It does not share encoder helpers or convert uint64 fields to Number.
function fields(hex) {
  const bytes = Buffer.from(hex.slice(2), "hex"), result = new Map(); let offset = 0;
  function varint() {
    let value = 0n, shift = 0n;
    while (offset < bytes.length && shift < 70n) {
      const next = bytes[offset++]; value |= BigInt(next & 127) << shift;
      if (!(next & 128)) return value;
      shift += 7n;
    }
    throw new Error("invalid test protobuf");
  }
  while (offset < bytes.length) {
    const tag = varint(), kind = Number(tag & 7n), number = Number(tag >> 3n);
    let value;
    if (kind === 0) value = varint();
    else if (kind === 2) { const length = Number(varint()); value = bytes.subarray(offset, offset + length); offset += length; }
    else throw new Error("unsupported test wire type");
    if (!result.has(number)) result.set(number, []);
    result.get(number).push(value);
  }
  assert.equal(offset, bytes.length); return result;
}
test("uint64 varint boundaries and deterministic pseudo-random nonces round-trip exactly", () => {
  const values = new Set([1n, (1n << 64n) - 1n]);
  for (let bit = 7n; bit < 64n; bit += 7n) for (const delta of [-1n, 0n, 1n]) values.add((1n << bit) + delta);
  let seed = 1n;
  for (let i = 0; i < 32; i++) { seed = (seed * 6364136223846793005n + 1n) & ((1n << 64n) - 1n); values.add(seed || 1n); }
  for (const nonce of values) {
    const input = inbound({ nonce: nonce.toString() }), encoded = prepareXitcoinAttestation(input), decoded = fields(encoded.messageHex);
    assert.equal(decoded.get(6)[0], nonce);
    assert.equal(decoded.get(9)[0], 2000000000n);
    assert.equal(decoded.get(8)[0].toString(), "10");
    assert.deepEqual([...decoded.keys()], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(decoded.get(10).length, 2);
    assert.equal(encoded.mayBroadcast, false);
  }
});
test("bounded fee multiplication accepts exactly the local policy region", () => {
  for (const gas of [1n, 299999n, 300000n, 300001n]) for (const price of [1n, 1999999999n, 2000000000n, 2000000001n]) {
    const input = outbound(); input.transaction = { nonce: "0", gasLimit: gas.toString(), gasPrice: price.toString() };
    input.limits.maxFee = "300000000000000";
    if (gas <= 300000n && price <= 2000000000n && gas * price <= 300000000000000n)
      assert.equal(prepareCronosRelease(input).mayBroadcast, false);
    else assert.throws(() => prepareCronosRelease(input), { message: "invalid Cronos destination evidence" });
  }
});
