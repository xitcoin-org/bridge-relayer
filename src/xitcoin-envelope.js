import { createHash } from "node:crypto";
import { computeAddress, keccak256, recoverAddress } from "ethers";
import { evmAddressToBech32 } from "./address.js";
import { prepareXitcoinAttestation } from "./xitcoin-destination.js";
import { destinationSnapshot, exactFields, decimal } from "./destination-validation.js";

const plans = new WeakSet();
const failure = () => new Error("invalid offline Xitcoin envelope");
const PUBKEY = "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey";
const blockers = Object.freeze(["authenticated_account_and_fee_evidence_required",
  "exclusive_sequence_custody_required", "chain_generated_differential_vector_required",
  "canonical_inclusion_and_finality_required"]);
function varint(n) {
  const bytes = [];
  do { bytes.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Buffer.from(bytes);
}
function field(n, value) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([varint(BigInt(n * 8 + 2)), varint(BigInt(bytes.length)), bytes]);
}
const integer = (n, value) => value === 0n ? Buffer.alloc(0) : Buffer.concat([varint(BigInt(n * 8)), varint(value)]);
const hex = (bytes) => `0x${bytes.toString("hex")}`;
const unhex = (value) => Buffer.from(value.slice(2), "hex");
const sha256 = (bytes) => `0x${createHash("sha256").update(bytes).digest("hex")}`;

// Ordered single-signer SIGN_MODE_DIRECT only. Rebuild approvals before encoding.
// Inputs are supplied offline evidence, not authenticated chain observations.
export function prepareXitcoinEnvelope(input) {
  try {
    const value = destinationSnapshot(input);
    exactFields(value, ["attestation", "account", "fee", "limits", "signMode", "timeoutHeight"]);
    const { account, fee, limits } = value;
    exactFields(account, ["chainId", "address", "publicKeyHex", "accountNumber", "sequence", "blockHash"]);
    exactFields(fee, ["denom", "amount", "gasLimit"]);
    exactFields(limits, ["maxFee", "maxGas"]);
    if (value.signMode !== "SIGN_MODE_DIRECT" || account.chainId !== "xitcoin-testnet-v2-1"
        || value.attestation.chainId !== account.chainId || account.address !== value.attestation.submitter
        || typeof account.publicKeyHex !== "string" || !/^0x0[23][0-9a-f]{64}$/.test(account.publicKeyHex)
        || !/^0x[0-9a-f]{64}$/.test(account.blockHash) || /^0x0{64}$/.test(account.blockHash)
        || evmAddressToBech32(computeAddress(account.publicKeyHex)) !== account.address
        || fee.denom !== "axtc") throw failure();
    const number = decimal(account.accountNumber, 64, false), sequence = decimal(account.sequence, 64, false);
    const gas = decimal(fee.gasLimit, 64), amount = decimal(fee.amount, 256);
    const timeout = decimal(value.timeoutHeight, 64, false);
    if (gas > decimal(limits.maxGas, 64) || amount > decimal(limits.maxFee, 256)) throw failure();
    const message = prepareXitcoinAttestation(value.attestation);
    const any = Buffer.concat([field(1, message.typeUrl), field(2, unhex(message.messageHex))]);
    const body = Buffer.concat([field(1, any), integer(3, timeout)]);
    const publicKeyAny = Buffer.concat([field(1, PUBKEY), field(2, field(1, unhex(account.publicKeyHex)))]);
    const signer = Buffer.concat([field(1, publicKeyAny), field(2, field(1, integer(1, 1n))), integer(3, sequence)]);
    const coin = Buffer.concat([field(1, fee.denom), field(2, fee.amount)]);
    const auth = Buffer.concat([field(1, signer), field(2, Buffer.concat([field(1, coin), integer(2, gas)]))]);
    const signDoc = Buffer.concat([field(1, body), field(2, auth), field(3, account.chainId), integer(4, number)]);
    const plan = Object.freeze({ chainId: account.chainId, account: account.address,
      publicKeyHex: account.publicKeyHex, accountNumber: account.accountNumber, sequence: account.sequence,
      accountEvidenceBlockHash: account.blockHash, approvalDigest: message.approvalDigest,
      attestationId: message.attestationId, bodyHex: hex(body), authInfoHex: hex(auth), signDocHex: hex(signDoc),
      signingDigest: keccak256(signDoc), signDocDigest: sha256(signDoc),
      mayBroadcast: false, finalized: false, blockers });
    plans.add(plan);
    return plan;
  } catch { throw failure(); }
}

// No key loading or signing: validate a supplied synthetic/offline signature.
// The pinned ethsecp256k1 verifier hashes SignDoc with Keccak, not SHA-256.
export function inspectXitcoinEnvelopeSignature(plan, signatureHex) {
  try {
    if (!plans.has(plan) || typeof signatureHex !== "string" || !/^0x[0-9a-f]{128}0[01]$/.test(signatureHex)) throw failure();
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const r = BigInt(`0x${signatureHex.slice(2, 66)}`), s = BigInt(`0x${signatureHex.slice(66, 130)}`);
    if (r < 1n || r >= n || s < 1n || s > n / 2n
        || recoverAddress(plan.signingDigest, signatureHex) !== computeAddress(plan.publicKeyHex)) throw failure();
    const raw = Buffer.concat([field(1, unhex(plan.bodyHex)), field(2, unhex(plan.authInfoHex)), field(3, unhex(signatureHex))]);
    if (raw.length > 32768) throw failure();
    return Object.freeze({ chainId: plan.chainId, account: plan.account, accountNumber: plan.accountNumber,
      sequence: plan.sequence, approvalDigest: plan.approvalDigest, attestationId: plan.attestationId,
      signedHex: hex(raw), transactionHash: sha256(raw), transactionDigest: sha256(raw), mayBroadcast: false, finalized: false, blockers });
  } catch { throw failure(); }
}
