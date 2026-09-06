import { inbound, keys } from "./destination.js";
export function envelopeInput() {
  const attestation = inbound();
  return { attestation, account: { chainId: attestation.chainId, address: attestation.submitter,
    publicKeyHex: keys[2].compressedPublicKey, accountNumber: "0", sequence: "0", blockHash: `0x${"ab".repeat(32)}` },
    fee: { denom: "axtc", amount: "100", gasLimit: "200000" }, limits: { maxFee: "200", maxGas: "300000" },
    signMode: "SIGN_MODE_DIRECT", timeoutHeight: "0" };
}
