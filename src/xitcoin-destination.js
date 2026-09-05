import { createHash } from "node:crypto";
import { bech32Encode } from "./address.js";
import { attestationId, DIRECTION_INBOUND } from "./protocol.js";
import { destinationSnapshot, exactFields, decimal, decimalOrSafeInteger, validateSourceEvidence, verifiedDestinationQuorum } from "./destination-validation.js";

export const XITCOIN_MESSAGE_TYPE = "/cosmos.evm.bridge.v1.MsgSubmitAttestation";
const ROUTE = "cronos-testnet-xitcoin-testnet";

function address(value) {
  const alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  if (typeof value !== "string" || !/^xtc1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(value)) throw new Error();
  let bits = "";
  for (const c of value.slice(4, 36)) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(Array.from({ length: 20 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  if (bech32Encode("xtc", bytes) !== value || bytes.every((b) => b === 0)
      || bytes.toString("hex") === "000000000000000000000000000000000000dead") throw new Error();
  return value;
}

function varint(value) {
  const bytes = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
}
function field(number, value) {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([varint(BigInt(number * 8 + 2)), varint(BigInt(bytes.length)), bytes]);
}

// Exact message bytes only, from docs/evidence/xitcoin-tx.proto. NOT TxRaw or sign bytes.
export function prepareXitcoinAttestation(input) {
  try {
    const value = destinationSnapshot(input);
    exactFields(value, ["chainId", "request", "approvals", "authorizedSigners", "submitter", "nowUnix"]);
    const { request, approvals, authorizedSigners, submitter, nowUnix } = value;
    if (value.chainId !== "xitcoin-testnet-v2-1" || request.direction !== DIRECTION_INBOUND) throw new Error();
    const p = request.payload;
    exactFields(p, ["routeId", "sourceChainId", "sourceRef", "nonce", "destination", "amount", "deadlineUnix", ...(Object.hasOwn(p, "sourceEvidence") ? ["sourceEvidence"] : [])]);
    if (Object.hasOwn(p, "sourceEvidence")) validateSourceEvidence(p.sourceEvidence);
    if (p.routeId !== ROUTE || p.sourceChainId !== "338" || !/^0x[0-9a-f]{64}$/.test(p.sourceRef)) throw new Error();
    const nonce = decimal(p.nonce, 64);
    decimal(p.amount, 256);
    const deadline = decimalOrSafeInteger(p.deadlineUnix, 63);
    // Current approval protocol uses safe-integer Unix seconds; never silently round.
    if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    address(submitter); address(p.destination);
    const quorum = verifiedDestinationQuorum(request, approvals, authorizedSigners, nowUnix);
    const bytes = Buffer.concat([
      field(1, submitter), field(2, p.routeId), field(3, request.direction),
      field(4, p.sourceChainId), field(5, p.sourceRef), Buffer.from([0x30]), varint(nonce),
      field(7, p.destination), field(8, p.amount), Buffer.from([0x48]), varint(deadline),
      ...quorum.map((a) => field(10, Buffer.from(a.signature.slice(2), "hex"))),
    ]);
    return Object.freeze({ chainId: value.chainId, typeUrl: XITCOIN_MESSAGE_TYPE,
      messageHex: `0x${bytes.toString("hex")}`,
      messageDigest: `0x${createHash("sha256").update(bytes).digest("hex")}`,
      approvalDigest: request.digest, attestationId: attestationId({ ...p, direction: request.direction }),
      mayBroadcast: false, blocker: "signed_envelope_account_fee_and_finality_evidence_required" });
  } catch { throw new Error("invalid Xitcoin destination message"); }
}
