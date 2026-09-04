import { evmAddressToBech32 } from "./address.js";
import { attestationDigest, attestationId, depositId, releaseDigest } from "./protocol.js";
import { TESTNET_ROUTE_ID } from "./preflight.js";

const route = "cronos-testnet-xitcoin-testnet";
const cronosChainId = 338;
const cronosVault = "0x1c94273C0b199b139D82da3786C9eCbE189D5919";
const vector = {
  routeId: route,
  cronosRouteId: TESTNET_ROUTE_ID,
  cronosChainId: String(cronosChainId),
  cronosVault,
  recipient: evmAddressToBech32("0x1111111111111111111111111111111111111111"),
};

const attestation = {
  routeId: route,
  direction: "cronos_to_xitcoin",
  sourceChainId: String(cronosChainId),
  sourceRef: `0x${"aa".repeat(32)}`,
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
    chainId: cronosChainId,
    vault: cronosVault,
    routeId: TESTNET_ROUTE_ID,
    depositor: "0x3333333333333333333333333333333333333333",
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    nonce: 7,
  }),
  releaseDigest: releaseDigest({
    chainId: cronosChainId,
    vault: cronosVault,
    sourceBurnId: `0x${"bb".repeat(32)}`,
    recipient: "0x1111111111111111111111111111111111111111",
    amount: 1000000000000000000n,
    signerSetVersion: 1,
    deadline: 1800000000,
  }),
});

process.stdout.write(`${JSON.stringify(vector, null, 2)}\n`);
