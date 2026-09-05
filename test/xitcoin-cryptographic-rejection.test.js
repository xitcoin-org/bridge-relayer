import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { recoverAddress } from "ethers";
import { verifyApproval } from "../src/approvals.js";
import { prepareXitcoinAttestation } from "../src/xitcoin-destination.js";
import { inbound, sign } from "./fixtures/destination.js";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const scalar = (n) => n.toString(16).padStart(64, "0");
const rejected = (input) => assert.throws(() => prepareXitcoinAttestation(input),
  { message: "invalid Xitcoin destination message" });
function changed(signature, index = 0) {
  const input = inbound();
  input.approvals[index].signature = signature;
  return input;
}

for (const v of [0, 1, 27, 28]) {
  test(`canonical recovery ${v}: original bytes preserved through verification and protobuf`, () => {
    const input = inbound();
    const index = input.approvals.findIndex((a) => Number.parseInt(a.signature.slice(-2), 16) % 27 === v % 27);
    assert.notEqual(index, -1);
    const response = input.approvals[index];
    response.signature = response.signature.slice(0, -2) + v.toString(16).padStart(2, "0");
    assert.equal(verifyApproval({ ...input, response }).signature, response.signature);
    const result = prepareXitcoinAttestation(input);
    assert(result.messageHex.includes(`5241${response.signature.slice(2)}`));
    assert.deepEqual(prepareXitcoinAttestation(input), result);
    assert.equal(result.messageDigest, `0x${createHash("sha256").update(Buffer.from(result.messageHex.slice(2), "hex")).digest("hex")}`);
  });
}

test("all 252 noncanonical recovery bytes rejected before ethers normalization", () => {
  const input = inbound();
  for (let v = 0; v < 256; v++) {
    if ([0, 1, 27, 28].includes(v)) continue;
    for (let i = 0; i < input.approvals.length; i++) {
      const signature = input.approvals[i].signature.slice(0, -2) + v.toString(16).padStart(2, "0");
      rejected(changed(signature, i));
      assert.throws(() => verifyApproval({ ...input, response: { ...input.approvals[i], signature } }),
        { message: "invalid signature recovery ID" });
    }
  }
  const response = input.approvals.find((a) => a.signature.endsWith("1c"));
  for (const byte of ["24", "26"]) {
    assert.equal(recoverAddress(input.request.digest, response.signature.slice(0, -2) + byte), response.signer);
  }
});

test("shortened, oversized, odd-length and nonhex signatures rejected", () => {
  const signature = inbound().approvals[0].signature;
  for (const length of [0, 1, 31, 32, 63, 64, 66, 96, 130]) {
    rejected(changed(`0x${signature.slice(2).padEnd(length * 2, "0").slice(0, length * 2)}`));
  }
  rejected(changed(signature.slice(0, -1)));
  rejected(changed(signature.slice(0, -2) + "gg"));
});

test("invalid r/s bounds and high-s equivalent signatures rejected", () => {
  const input = inbound();
  const signature = input.approvals[0].signature;
  for (const r of [0n, N, N + 1n, (1n << 256n) - 1n]) {
    rejected(changed(`0x${scalar(r)}${signature.slice(66)}`));
  }
  for (const s of [0n, N / 2n + 1n, N - 1n, N, N + 1n, (1n << 256n) - 1n]) {
    rejected(changed(`${signature.slice(0, 66)}${scalar(s)}${signature.slice(-2)}`));
  }
  const highS = N - BigInt(`0x${signature.slice(66, 130)}`);
  const flippedV = signature.endsWith("1b") ? "1c" : "1b";
  rejected(changed(`${signature.slice(0, 66)}${scalar(highS)}${flippedV}`));
});

function permutations(values) {
  return values.length === 0 ? [[]] : values.flatMap((v, i) =>
    permutations(values.filter((_, j) => i !== j)).map((tail) => [v, ...tail]));
}

test("only canonical 2-of-3 and 3-of-3 permutations accepted, irrespective of set enumeration", () => {
  const input = inbound();
  // Public key addresses ascend in key-index order 1, 2, 0.
  for (const canonical of [[1, 0], [1, 2], [2, 0], [1, 2, 0]]) {
    for (const order of permutations(canonical)) {
      const candidate = { ...input, approvals: sign(input.request, order) };
      if (order.join() !== canonical.join()) { rejected(candidate); continue; }
      const before = structuredClone(candidate);
      const result = prepareXitcoinAttestation(candidate);
      assert.deepEqual(candidate, before);
      assert.deepEqual(prepareXitcoinAttestation(candidate), result);
      for (const authorizedSigners of permutations(input.authorizedSigners)) {
        assert.deepEqual(prepareXitcoinAttestation({ ...candidate, authorizedSigners }), result);
      }
    }
  }
});

test("duplicate approvals, unauthorized signers and ambiguous signer sets rejected", () => {
  const input = inbound();
  for (const indexes of [[1, 1], [1, 1, 0], [1, 0, 0], [1, 3]]) {
    rejected({ ...input, approvals: sign(input.request, indexes) });
  }
  rejected({ ...input, authorizedSigners: [input.authorizedSigners[0], input.authorizedSigners[0].toLowerCase(), input.authorizedSigners[2]] });
});

test("valid fixture protobuf bytes and both digests remain unchanged", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/xitcoin-message.json", import.meta.url)));
  const result = prepareXitcoinAttestation(inbound());
  assert.equal(result.messageHex, fixture.messageHex);
  assert.equal(result.messageDigest, `0x${createHash("sha256").update(Buffer.from(fixture.messageHex.slice(2), "hex")).digest("hex")}`);
  assert.equal(result.approvalDigest, "0xffbaf624db3f891b89335f1e9e1ad4069b678be523a3bad959df8068d36b2f25");
});
