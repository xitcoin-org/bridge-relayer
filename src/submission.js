import { Interface, getAddress, isHexString } from "ethers";

import { buildApprovalRequest } from "./approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND, attestationId } from "./protocol.js";

export class DestinationViolation extends Error {}

function quorum(request, approvals) {
  const expected = buildApprovalRequest(request);
  if (!Array.isArray(approvals) || approvals.length < 2) throw new DestinationViolation("approval quorum is missing");
  const signers = new Set();
  return approvals.slice().sort((a, b) => a.signer.localeCompare(b.signer)).map((approval) => {
    const signer = String(approval.signer).toLowerCase();
    if (signers.has(signer)) throw new DestinationViolation("duplicate approval signer");
    signers.add(signer);
    if (String(approval.digest).toLowerCase() !== expected.digest) throw new DestinationViolation("approval digest mismatch");
    if (!isHexString(approval.signature, 65)) throw new DestinationViolation("invalid approval signature");
    return approval.signature;
  });
}

export function buildXitcoinSubmission({ request, approvals, submitter }) {
  if (request.direction !== DIRECTION_INBOUND) throw new DestinationViolation("Xitcoin submission requires an inbound request");
  const payload = request.payload;
  const signatures = quorum(request, approvals);
  return Object.freeze({
    submitter: String(submitter), routeId: payload.routeId, direction: DIRECTION_INBOUND,
    sourceChainId: String(payload.sourceChainId), sourceRef: payload.sourceRef,
    nonce: String(payload.nonce), destination: payload.destination, amount: String(payload.amount),
    deadlineUnix: String(payload.deadlineUnix), signatures,
    attestationId: attestationId({ ...payload, direction: DIRECTION_INBOUND }),
  });
}

const vaultInterface = new Interface([
  "function release(bytes32 sourceBurnId,address recipient,uint256 amount,uint64 signerSetVersion,uint256 deadline,bytes[] signatures)",
  "event Released(bytes32 indexed sourceBurnId,address indexed recipient,uint256 amount,uint64 signerSetVersion)",
]);

export function buildCronosSubmission({ request, approvals, vault }) {
  if (request.direction !== DIRECTION_OUTBOUND) throw new DestinationViolation("Cronos submission requires an outbound request");
  const payload = request.payload;
  const signatures = quorum(request, approvals);
  return Object.freeze({
    to: getAddress(vault),
    data: vaultInterface.encodeFunctionData("release", [payload.sourceBurnId, payload.recipient,
      BigInt(payload.amount), BigInt(payload.signerSetVersion), BigInt(payload.deadline), signatures]),
    idempotencyKey: String(payload.sourceBurnId).toLowerCase(),
  });
}

function transactionReference(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (!isHexString(normalized, 32)) throw new DestinationViolation("destination transaction reference is invalid");
  return normalized;
}

export async function submitApprovedTransfer({ store, sourceChain, sourceRef, request, adapter }) {
  if (!store || !adapter) throw new Error("store and destination adapter are required");
  let transfer = store.get(sourceChain, sourceRef);
  if (!transfer) throw new Error("transfer not found");
  if (transfer.state === "completed") return { transfer, idempotent: true };
  if (!["approved", "submitted"].includes(transfer.state)) throw new Error("transfer is not ready for destination submission");

  if (transfer.state === "approved") {
    const known = await adapter.status({ request });
    let destinationRef;
    if (known?.processed) {
      if (!known.canonical) throw new DestinationViolation("processed destination record is not canonical");
      destinationRef = transactionReference(known.destinationRef);
    } else {
      destinationRef = transactionReference(await adapter.submit({
        request, approvals: store.approvals(sourceChain, sourceRef),
      }));
    }
    transfer = store.transition(sourceChain, sourceRef, "submitted", { destinationRef });
  }

  const confirmation = await adapter.confirm({ request, destinationRef: transfer.destination_ref });
  if (!confirmation?.finalized) return { transfer, pending: true };
  if (!confirmation.canonical) throw new DestinationViolation("destination confirmation mismatch");
  return { transfer: store.transition(sourceChain, sourceRef, "completed"), pending: false };
}
