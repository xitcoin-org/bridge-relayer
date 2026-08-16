import { createHash } from "node:crypto";
import {
  AbiCoder,
  TypedDataEncoder,
  concat,
  getAddress,
  getBytes,
  hexlify,
  id,
  isHexString,
  keccak256,
  toUtf8Bytes,
} from "ethers";

export const SIGNING_DOMAIN = "xitcoin-bridge-testnet-attestation-v1";
export const DIRECTION_INBOUND = "cronos_to_xitcoin";
export const DIRECTION_OUTBOUND = "xitcoin_to_cronos";

function positiveDecimal(value, label) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text)) throw new Error(`${label} must be a positive decimal integer`);
  return text;
}

function sourceReference(value) {
  const normalized = String(value).trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("source reference must contain 32 bytes");
  return normalized;
}

export function validateRouteId(routeId) {
  if (!/^[a-z0-9_-]{1,96}$/.test(routeId)) throw new Error("invalid route ID");
  return routeId;
}

export function cronosRouteId(routeId) {
  return id(validateRouteId(routeId));
}

export function attestationId(attestation) {
  const fields = [
    validateRouteId(attestation.routeId),
    attestation.direction,
    String(attestation.sourceChainId).trim(),
    sourceReference(attestation.sourceRef),
    positiveDecimal(attestation.nonce, "nonce"),
    String(attestation.destination).trim(),
    positiveDecimal(attestation.amount, "amount"),
    positiveDecimal(attestation.deadlineUnix, "deadline"),
  ];
  if (![DIRECTION_INBOUND, DIRECTION_OUTBOUND].includes(fields[1])) throw new Error("invalid direction");
  if (!fields[2] || !fields[5]) throw new Error("missing attestation field");
  return `0x${createHash("sha256").update(fields.join("\0"), "utf8").digest("hex")}`;
}

export function attestationDigest(attestation) {
  return keccak256(concat([toUtf8Bytes(SIGNING_DOMAIN), getBytes(attestationId(attestation))]));
}

export function depositId({ chainId, vault, routeId, depositor, recipient, amount, nonce }) {
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "bytes32", "address", "address", "uint256", "uint256"],
    [BigInt(chainId), getAddress(vault), routeId, getAddress(depositor), getAddress(recipient), BigInt(amount), BigInt(nonce)],
  );
  return keccak256(encoded);
}

export function releaseDigest({ chainId, vault, sourceBurnId, recipient, amount, signerSetVersion, deadline }) {
  if (!isHexString(sourceBurnId, 32)) throw new Error("invalid source burn ID");
  return TypedDataEncoder.hash(
    {
      name: "Xitcoin Cronos Bridge Vault",
      version: "1",
      chainId: BigInt(chainId),
      verifyingContract: getAddress(vault),
    },
    {
      Release: [
        { name: "sourceBurnId", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "signerSetVersion", type: "uint64" },
        { name: "deadline", type: "uint256" },
      ],
    },
    {
      sourceBurnId,
      recipient: getAddress(recipient),
      amount: BigInt(amount),
      signerSetVersion: BigInt(signerSetVersion),
      deadline: BigInt(deadline),
    },
  );
}

export function normalizeBytes32(value) {
  if (!isHexString(value, 32)) throw new Error("expected bytes32");
  return hexlify(value).toLowerCase();
}
