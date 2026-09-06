import { RelayStore } from "../../src/store.js";
import { buildTransferApprovalRequest } from "../../src/coordinator.js";
import { prepareCronosRelease, inspectCronosSignedTransaction } from "../../src/cronos-destination.js";
import { cronosRouteId } from "../../src/protocol.js";
import { outbound, signedBytes } from "./cronos.js";
import { sign } from "./destination.js";
export const manifest = { version: 1, mode: "disabled", destination: "cronos", releaseCommit: "a".repeat(40),
  routeId: "cronos-testnet-xitcoin-testnet", cronosChainId: 338, xitcoinChainId: "xitcoin-testnet-v2-1" };
export function storedCandidate(path = ":memory:", patch = {}) {
  const base = outbound();
  const { request: unused, approvals: ignored, ...evidence } = base;
  const ref = patch.sourceRef ?? base.request.payload.sourceBurnId;
  const store = new RelayStore(path);
  if (!store.get("xitcoin", ref)) {
    store.observe({ sourceChain: "xitcoin", sourceRef: ref, routeId: manifest.routeId,
      blockHeight: 10, blockHash: `0x${"aa".repeat(32)}`, transactionHash: `0x${"bb".repeat(32)}`, messageIndex: 0,
      payload: { requestId: ref, destination: base.request.payload.recipient, amount: patch.amount ?? "10" } });
    const transfer = store.transition("xitcoin", ref, "finalized");
    const request = buildTransferApprovalRequest({ transfer, routeId: manifest.routeId,
      cronosRouteId: cronosRouteId(manifest.routeId), cronosChainId: 338, cronosVault: evidence.identity.vault,
      signerSetVersion: 1, deadlineUnix: 2_000_000_000 });
    store.persistApprovalRequest("xitcoin", ref, request);
    for (const approval of sign(request)) store.recordApproval("xitcoin", ref, approval);
    store.transition("xitcoin", ref, "approved");
  }
  const request = store.approvalRequest("xitcoin", ref);
  const approvals = store.approvals("xitcoin", ref).map(({ signer, digest, signature }) => ({ signer, digest, signature }));
  const plan = prepareCronosRelease({ ...evidence, request, approvals });
  const signedHex = signedBytes(plan);
  return { store, evidence, sourceRef: ref, signedHex, signed: inspectCronosSignedTransaction(plan, signedHex) };
}
