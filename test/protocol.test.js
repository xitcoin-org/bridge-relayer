import test from "node:test";
import assert from "node:assert/strict";
import { evmAddressToBech32 } from "../src/address.js";
import { attestationDigest, attestationId, cronosRouteId, depositId, releaseDigest } from "../src/protocol.js";

test("converts EVM account bytes to deterministic Xitcoin Bech32", () => {
  assert.equal(
    evmAddressToBech32("0x1111111111111111111111111111111111111111"),
    "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9",
  );
});

test("rejects zero and dead recipient addresses", () => {
  assert.throws(() => evmAddressToBech32("0x0000000000000000000000000000000000000000"));
  assert.throws(() => evmAddressToBech32("0x000000000000000000000000000000000000dEaD"));
});

test("builds stable route, deposit and attestation identifiers", () => {
  const route = "cronos-xitcoin-xtc-v1";
  const routeHash = cronosRouteId(route);
  assert.equal(routeHash.length, 66);
  const reference = depositId({
    chainId: 25,
    vault: "0x2222222222222222222222222222222222222222",
    routeId: routeHash,
    depositor: "0x3333333333333333333333333333333333333333",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    nonce: 7,
  });
  const attestation = {
    routeId: route,
    direction: "cronos_to_xitcoin",
    sourceChainId: "25",
    sourceRef: reference,
    nonce: "7",
    destination: evmAddressToBech32("0x1111111111111111111111111111111111111111"),
    amount: "1000000000000000000",
    deadlineUnix: "1800000000",
  };
  assert.match(attestationId(attestation), /^0x[0-9a-f]{64}$/);
  assert.match(attestationDigest(attestation), /^0x[0-9a-f]{64}$/);
});

test("binds release approval to chain and vault", () => {
  const common = {
    chainId: 25,
    vault: "0x2222222222222222222222222222222222222222",
    sourceBurnId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    signerSetVersion: 1,
    deadline: 1800000000,
  };
  assert.notEqual(releaseDigest(common), releaseDigest({ ...common, chainId: 338 }));
  assert.notEqual(
    releaseDigest(common),
    releaseDigest({ ...common, vault: "0x4444444444444444444444444444444444444444" }),
  );
});
