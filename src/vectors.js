import { evmAddressToBech32 } from "./address.js";
import { attestationDigest, attestationId, cronosRouteId, depositId, releaseDigest } from "./protocol.js";

const route = "cronos-xitcoin-xtc-v1";
const vector = {
  routeId: route,
  cronosRouteId: cronosRouteId(route),
  recipient: evmAddressToBech32("0x1111111111111111111111111111111111111111"),
};

const attestation = {
  routeId: route,
  direction: "cronos_to_xitcoin",
  sourceChainId: "25",
  sourceRef: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  nonce: "7",
  destination: vector.recipient,
  amount: "1000000000000000000",
  deadlineUnix: "1800000000",
};

Object.assign(vector, {
  attestation,
  attestationId: attestationId(attestation),
  attestationDigest: attestationDigest(attestation),
  depositId: depositId({
    chainId: 25,
    vault: "0x2222222222222222222222222222222222222222",
    routeId: cronosRouteId(route),
    depositor: "0x3333333333333333333333333333333333333333",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    nonce: 7,
  }),
  releaseDigest: releaseDigest({
    chainId: 25,
    vault: "0x2222222222222222222222222222222222222222",
    sourceBurnId: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    signerSetVersion: 1,
    deadline: 1800000000,
  }),
});

process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`);
