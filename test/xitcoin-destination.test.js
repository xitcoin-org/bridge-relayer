import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareXitcoinAttestation } from "../src/xitcoin-destination.js";
import { inbound, sign } from "./fixtures/destination.js";

const rejected = (value) => assert.throws(() => prepareXitcoinAttestation(value), { message: "invalid Xitcoin destination message" });
test("exact pinned message vector; immutable output, deterministic signature order, never sendable", () => {
  const input = inbound();
  const result = prepareXitcoinAttestation(input);
  assert.equal(result.messageHex, JSON.parse(readFileSync(new URL("./fixtures/xitcoin-message.json", import.meta.url))).messageHex);
  assert.equal(result.mayBroadcast, false);
  input.approvals.reverse();
  assert.deepEqual(prepareXitcoinAttestation(input), result);
  assert(Object.isFrozen(result));
  assert.match(result.messageHex, /30ffffffffffffffffff01/); // uint64 max, no Number conversion
});
test("testnet, canonical field, unsigned integer and address restrictions", () => {
  for (const change of [{ sourceChainId: "25" }, { nonce: "18446744073709551616" }, { nonce: "01" },
    { nonce: 2 }, { amount: "0" }, { amount: (1n << 256n).toString() }, { destination: "xtc1invalid" },
    { routeId: "other" }, { deadlineUnix: "9007199254740992" }]) {
    const input = inbound();
    rejected({ ...input, request: { ...input.request, payload: { ...input.request.payload, ...change } } });
  }
  rejected({ ...inbound(), chainId: "xitcoin-mainnet-1" });
  rejected({ ...inbound(), submitter: "xtc1invalid" });
  rejected({ ...inbound(), nowUnix: 2_000_000_001 });
});
test("cryptographic authorized quorum and canonical request binding", () => {
  const input = inbound();
  for (const indexes of [[0], [0, 0], [0, 3], [0, 1, 2, 3]]) rejected({ ...input, approvals: sign(input.request, indexes) });
  rejected({ ...input, request: { ...input.request, digest: `0x${"00".repeat(32)}` } });
  rejected({ ...input, request: { ...input.request, payload: { ...input.request.payload, amount: "11" } } });
  rejected({ ...input, authorizedSigners: input.authorizedSigners.slice(0, 2) });
  rejected({ ...input, approvals: input.approvals.map((a) => ({ ...a, signer: input.authorizedSigners[2] })) });
});
test("untrusted object traps, excess data and raw errors never escape", () => {
  let calls = 0;
  rejected(new Proxy({}, { ownKeys() { calls++; throw new Error("secret"); } }));
  rejected({ ...inbound(), get chainId() { calls++; throw new Error("secret"); } });
  rejected({ ...inbound(), extra: "x".repeat(40_000) });
  rejected({ ...inbound(), approvals: new Array(3) });
  assert.equal(calls, 0);
});
