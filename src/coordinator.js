import { FinalityViolation } from "./watchers.js";
import { collectApprovalQuorum } from "./approvals.js";
import { buildApprovalRequest } from "./approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND, normalizeBytes32, validateRouteId } from "./protocol.js";
export { submitApprovedTransfer } from "./submission.js";

function height(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} must be a positive safe integer`);
  return number;
}

function payloadOf(transfer) {
  try {
    const payload = typeof transfer.payload === "string" ? JSON.parse(transfer.payload) : transfer.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    throw new Error("stored transfer payload is invalid");
  }
}

function sourceEvidence(transfer) {
  const transactionHash = normalizeBytes32(transfer.transaction_hash);
  return Object.freeze({
    blockHeight: positiveInteger(transfer.block_height, "source block height"),
    blockHash: normalizeBytes32(transfer.block_hash),
    transactionHash,
    eventIndex: positiveInteger(Number(transfer.event_index) + 1, "source event index offset") - 1,
  });
}

function storedSourceRef(value) {
  const text = String(value);
  return normalizeBytes32(text.startsWith("0x") ? text : `0x${text}`);
}

export function buildTransferApprovalRequest({
  transfer,
  routeId,
  cronosRouteId,
  cronosChainId,
  cronosVault,
  signerSetVersion = 1,
  deadlineUnix,
}) {
  if (!transfer || transfer.state !== "finalized") throw new Error("a finalized transfer is required");
  const canonicalRouteId = validateRouteId(routeId);
  const chainId = positiveInteger(cronosChainId, "Cronos chain ID");
  const deadline = positiveInteger(deadlineUnix, "approval deadline");
  const payload = payloadOf(transfer);
  const evidence = sourceEvidence(transfer);

  if (transfer.source_chain === "cronos") {
    if (normalizeBytes32(transfer.route_id) !== normalizeBytes32(cronosRouteId)) throw new Error("Cronos route mapping mismatch");
    const sourceRef = normalizeBytes32(payload.depositId);
    if (sourceRef !== storedSourceRef(transfer.source_ref)) throw new Error("Cronos source reference mismatch");
    return buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
      routeId: canonicalRouteId,
      sourceChainId: String(chainId),
      sourceRef,
      nonce: String(payload.nonce),
      destination: String(payload.destination),
      amount: String(payload.amount),
      deadlineUnix: deadline,
      sourceEvidence: evidence,
    } });
  }

  if (transfer.source_chain === "xitcoin") {
    if (String(transfer.route_id) !== canonicalRouteId) throw new Error("Xitcoin route mapping mismatch");
    const sourceBurnId = normalizeBytes32(payload.requestId);
    if (sourceBurnId !== storedSourceRef(transfer.source_ref)) throw new Error("Xitcoin source reference mismatch");
    return buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
      routeId: canonicalRouteId,
      chainId,
      vault: cronosVault,
      sourceBurnId,
      recipient: String(payload.destination),
      amount: String(payload.amount),
      signerSetVersion: positiveInteger(signerSetVersion, "signer set version"),
      deadline,
      sourceEvidence: evidence,
    } });
  }

  throw new Error("unsupported source chain");
}

export async function approveFinalizedTransfer({
  store,
  sourceChain,
  sourceRef,
  request,
  clients,
  authorizedSigners,
  threshold = 2,
  nowUnix,
}) {
  if (!store || !sourceChain || !sourceRef) throw new Error("store and source transfer are required");
  const transfer = store.get(sourceChain, sourceRef);
  if (!transfer) throw new Error("transfer not found");
  if (transfer.state === "approved") {
    return { transfer, approvals: store.approvals(sourceChain, sourceRef), idempotent: true };
  }
  if (transfer.state !== "finalized") throw new Error("only finalized transfers may be approved");
  const canonicalRequest = buildApprovalRequest(request);
  const persistedRequest = store.persistApprovalRequest(sourceChain, sourceRef, canonicalRequest);
  const approvals = await collectApprovalQuorum({
    clients, request: persistedRequest, authorizedSigners, threshold, nowUnix,
  });
  for (const approval of approvals) store.recordApproval(sourceChain, sourceRef, approval);
  const approved = store.transition(sourceChain, sourceRef, "approved");
  return { transfer: approved, approvals: store.approvals(sourceChain, sourceRef), idempotent: false };
}

export async function scanFinalizedBatch({ watcher, store, sourceChain, startHeight = 1, maxBatch = 100 }) {
  if (!watcher || !store || !sourceChain) throw new Error("watcher, store and source chain are required");
  const first = height(startHeight, "start height");
  const batch = height(maxBatch, "maximum batch");
  if (batch < 1) throw new Error("maximum batch must be positive");
  const checkpoint = store.checkpoint(sourceChain);
  const from = checkpoint ? checkpoint.block_height + 1 : first;
  const finalized = height(await watcher.latestFinalizedHeight(), "finalized height");
  if (from > finalized) return { from, to: finalized, observed: 0, idle: true };
  const to = Math.min(finalized, from + batch - 1);
  const events = await watcher.events(from, to);
  for (const record of events) {
    if (record.sourceChain !== sourceChain) throw new FinalityViolation("watcher returned the wrong source chain");
    await watcher.verifyCanonicalEvent(record);
    const current = store.observe(record);
    if (current.state === "observed") store.transition(sourceChain, record.sourceRef, "finalized");
  }
  const canonical = await watcher.canonicalBlock(to);
  if (Number(canonical.height ?? canonical.number) !== to) {
    throw new FinalityViolation("checkpoint block height mismatch");
  }
  store.advanceCheckpoint(sourceChain, to, canonical.hash);
  return { from, to, observed: events.length, idle: false };
}
