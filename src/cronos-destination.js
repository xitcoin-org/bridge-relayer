import { createHash } from "node:crypto";
import { Interface, Transaction, getAddress, keccak256 } from "ethers";
import { DIRECTION_OUTBOUND, cronosRouteId } from "./protocol.js";
import { destinationSnapshot, exactFields, decimal, decimalOrSafeInteger, validateSourceEvidence, verifiedDestinationQuorum } from "./destination-validation.js";

const vault = new Interface([
  "function release(bytes32 sourceBurnId,address recipient,uint256 amount,uint64 signerSetVersion,uint256 deadline,bytes[] signatures)",
  "event Released(bytes32 indexed sourceBurnId,address indexed recipient,uint256 amount,uint64 signerSetVersion)",
]);
const plans = new WeakSet();
const custody = new WeakSet();
const error = () => new Error("invalid Cronos destination evidence");
function hash(value) { if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw error(); }
function account(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw error();
  const normalized = getAddress(value);
  if (/^0x0{40}$/.test(normalized) || normalized.toLowerCase() === "0x000000000000000000000000000000000000dead") throw error();
  return normalized;
}

// Evidence is supplied offline, NOT independently authenticated deployment state.
// Policy bounds are local caps, NOT proof that a fee mode is supported by Cronos.
export function prepareCronosRelease(input) {
  try {
    const value = destinationSnapshot(input);
    exactFields(value, ["request", "approvals", "authorizedSigners", "nowUnix", "identity", "state", "transaction", "limits"]);
    const { request, identity, state, transaction: tx, limits } = value;
    exactFields(identity, ["chainId", "vault", "codeHash", "routeId", "submitter"]);
    exactFields(state, ["chainId", "vault", "codeHash", "routeId", "paused", "processed", "signerSetVersion", "blockHash"]);
    exactFields(tx, ["nonce", "gasLimit", "gasPrice"]);
    exactFields(limits, ["maxGas", "maxGasPrice", "maxFee"]);
    hash(identity.codeHash); hash(state.blockHash);
    if (identity.chainId !== 338 || state.chainId !== 338
        || identity.routeId !== cronosRouteId("cronos-testnet-xitcoin-testnet")
        || state.routeId !== identity.routeId || state.codeHash !== identity.codeHash
        || account(state.vault) !== account(identity.vault)
        || state.paused !== false || state.processed !== false) throw error();
    const p = request.payload;
    exactFields(p, ["chainId", "vault", "sourceBurnId", "recipient", "amount", "signerSetVersion", "deadline",
      ...(Object.hasOwn(p, "routeId") ? ["routeId"] : []), ...(Object.hasOwn(p, "sourceEvidence") ? ["sourceEvidence"] : [])]);
    if (Object.hasOwn(p, "routeId") && p.routeId !== "cronos-testnet-xitcoin-testnet") throw error();
    if (Object.hasOwn(p, "sourceEvidence")) validateSourceEvidence(p.sourceEvidence);
    if (request.direction !== DIRECTION_OUTBOUND || p.chainId !== 338 || account(p.vault) !== account(identity.vault)
        || decimalOrSafeInteger(p.signerSetVersion, 64) !== decimal(state.signerSetVersion, 64)) throw error();
    hash(p.sourceBurnId); account(p.recipient);
    decimal(p.amount, 256); decimalOrSafeInteger(p.signerSetVersion, 64); decimalOrSafeInteger(p.deadline, 256);
    const quorum = verifiedDestinationQuorum(request, value.approvals, value.authorizedSigners, value.nowUnix);
    // The reviewed vault uses OpenZeppelin ECDSA.recover(bytes): unlike the
    // Xitcoin verifier, its original recovery byte must be 27 or 28.
    if (quorum.some(({ signature }) => ![27, 28].includes(Number.parseInt(signature.slice(130, 132), 16)))) throw error();
    const nonce = decimal(tx.nonce, 64, false);
    if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw error(); // ethers nonce representation
    const gas = decimal(tx.gasLimit, 256), price = decimal(tx.gasPrice, 256);
    if (gas > decimal(limits.maxGas, 256) || price > decimal(limits.maxGasPrice, 256)
        || gas * price >= 1n << 256n || gas * price > decimal(limits.maxFee, 256)) throw error();
    const data = vault.encodeFunctionData("release", [p.sourceBurnId, p.recipient, p.amount,
      p.signerSetVersion, p.deadline, quorum.map((a) => a.signature)]);
    const result = Object.freeze({ chainId: 338, to: account(identity.vault), data,
      sourceBurnId: p.sourceBurnId, approvalDigest: request.digest, submitter: account(identity.submitter),
      nonce: tx.nonce, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice, codeHash: identity.codeHash,
      routeId: identity.routeId, evidenceBlockHash: state.blockHash,
      mayBroadcast: false, blocker: "deployment_fee_support_and_canonical_finality_unverified" });
    plans.add(result);
    return result;
  } catch { throw error(); }
}

// Accept exact, already signed offline bytes. Does not load keys or sign.
export function inspectCronosSignedTransaction(plan, signedHex) {
  try {
    if (!plans.has(plan) || typeof signedHex !== "string" || signedHex.length > 32_768
        || !/^0x(?:[0-9a-f]{2})+$/.test(signedHex)) throw error();
    const tx = Transaction.from(signedHex);
    if (!tx.isSigned() || tx.type !== 0 || tx.chainId !== 338n || tx.serialized !== signedHex
        || tx.from !== plan.submitter || tx.to !== plan.to || tx.data !== plan.data || tx.value !== 0n
        || BigInt(tx.nonce) !== BigInt(plan.nonce) || tx.gasLimit !== BigInt(plan.gasLimit)
        || tx.gasPrice !== BigInt(plan.gasPrice)) throw error();
    const result = Object.freeze({ destination: "cronos", chainId: 338,
      transferId: plan.sourceBurnId, approvalDigest: plan.approvalDigest,
      vault: plan.to, codeHash: plan.codeHash, routeId: plan.routeId,
      account: plan.submitter, nonce: plan.nonce, signedHex,
      transactionDigest: `0x${createHash("sha256").update(Buffer.from(signedHex.slice(2), "hex")).digest("hex")}`,
      transactionHash: keccak256(signedHex), mayBroadcast: false });
    custody.add(result);
    return result;
  } catch { throw error(); }
}

export function requireCronosCustody(value) {
  if (!custody.has(value)) throw error();
  return value;
}

// Inspects a bounded normalized receipt + exact transaction, not a live RPC response.
// Matching inclusion is not consensus finality; no completion capability is returned.
export function inspectCronosInclusion(plan, signed, input) {
  try {
    if (!plans.has(plan)) throw error();
    requireCronosCustody(signed);
    const expected = inspectCronosSignedTransaction(plan, signed.signedHex);
    const value = destinationSnapshot(input);
    exactFields(value, ["chainId", "transactionHash", "blockHash", "canonicalBlockHash", "status", "logs"]);
    hash(value.blockHash); hash(value.canonicalBlockHash);
    if (value.chainId !== 338 || value.transactionHash !== expected.transactionHash
        || value.blockHash !== value.canonicalBlockHash || !["0x0", "0x1"].includes(value.status)
        || !Array.isArray(value.logs)) throw error();
    if (value.status === "0x0") return Object.freeze({ failed: true, included: true, finalized: false, mayBroadcast: false });
    const args = vault.decodeFunctionData("release", plan.data);
    const event = vault.encodeEventLog(vault.getEvent("Released"), args.slice(0, 4));
    let matches = 0;
    for (const log of value.logs) {
      exactFields(log, ["address", "topics", "data", "removed"]);
      account(log.address);
      if (!Array.isArray(log.topics) || log.topics.length > 4 || typeof log.data !== "string"
          || !/^0x(?:[0-9a-f]{2})*$/.test(log.data) || log.removed !== false) throw error();
      for (const topic of log.topics) hash(topic);
      if (getAddress(log.address) === plan.to && log.topics[0] === event.topics[0]) {
        if (JSON.stringify(log.topics) !== JSON.stringify(event.topics) || log.data !== event.data) throw error();
        matches++;
      }
    }
    if (matches !== 1) throw error();
    return Object.freeze({ failed: false, included: true, finalized: false, mayBroadcast: false,
      blocker: "independent_canonical_finality_required" });
  } catch { throw error(); }
}
