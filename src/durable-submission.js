import { isDeepStrictEqual } from "node:util";
import { RelayStore } from "./store.js";
import { BroadcastIntentJournal } from "./broadcast-intent.js";
import { SignedIntentJournal } from "./signed-intent.js";
import { prepareCronosRelease, inspectCronosSignedTransaction } from "./cronos-destination.js";
import { buildTransferApprovalRequest } from "./coordinator.js";
import { cronosRouteId } from "./protocol.js";
import { destinationSnapshot, exactFields } from "./destination-validation.js";
import { validateSubmitterManifest } from "./submitter-manifest.js";

// Offline integration only. Reserve custody first, digest journal second. A crash
// between commits can leave extra blocking custody, never broadcast permission.
// RelayStore is held under BEGIN IMMEDIATE while its immutable request is checked.
export function reserveStoredCronosIntent(input) {
  let locked = false, store;
  try {
    let signedJournal, intentJournal, manifest, sourceRef, evidence, signedHex;
    ({ store, signedJournal, intentJournal, manifest, sourceRef, evidence, signedHex } = input);
    if (!(store instanceof RelayStore) || !(signedJournal instanceof SignedIntentJournal)
        || !(intentJournal instanceof BroadcastIntentJournal)) throw new Error();
    const config = validateSubmitterManifest(destinationSnapshot(manifest));
    if (config.destination !== "cronos" || typeof sourceRef !== "string" || !/^0x[0-9a-f]{64}$/.test(sourceRef)) throw new Error();
    signedJournal.assertManifest(config); intentJournal.assertManifest(config);
    const supplied = destinationSnapshot(evidence);
    exactFields(supplied, ["authorizedSigners", "nowUnix", "identity", "state", "transaction", "limits"]);
    store.database.exec("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE"); locked = true;
    const size = store.database.prepare("SELECT length(payload) AS p, length(approval_request) AS r FROM transfers WHERE source_chain = 'xitcoin' AND source_ref = ?").get(sourceRef);
    if (!size || !size.r || size.p > 32768 || size.r > 32768) throw new Error();
    const transfer = store.get("xitcoin", sourceRef);
    if (transfer.state !== "approved" || transfer.destination_ref !== null) throw new Error();
    const request = destinationSnapshot(store.approvalRequest("xitcoin", sourceRef));
    const rebuilt = buildTransferApprovalRequest({ transfer: { ...transfer, state: "finalized" },
      routeId: config.routeId, cronosRouteId: cronosRouteId(config.routeId), cronosChainId: config.cronosChainId,
      cronosVault: supplied.identity.vault, signerSetVersion: request.payload.signerSetVersion,
      deadlineUnix: request.deadlineUnix });
    if (!isDeepStrictEqual(request, rebuilt)) throw new Error();
    const count = store.database.prepare("SELECT count(*) AS n FROM approvals WHERE source_chain = 'xitcoin' AND source_ref = ?").get(sourceRef).n;
    if (count < 2 || count > 3) throw new Error();
    const approvals = store.approvals("xitcoin", sourceRef).map(({ signer, digest, signature }) => ({ signer, digest, signature }));
    const plan = prepareCronosRelease({ ...supplied, request, approvals });
    const signed = inspectCronosSignedTransaction(plan, signedHex);
    if (signed.transferId !== sourceRef) throw new Error();
    const reservation = signedJournal.reserve(signed);
    const intent = intentJournal.reserve({ transferId: signed.transferId, approvalDigest: signed.approvalDigest,
      transactionDigest: signed.transactionDigest });
    // Preserve uncertainty from either journal without introducing a reset API.
    if (reservation.state === "uncertain" || intent.state === "uncertain") {
      signedJournal.markUncertain(sourceRef); intentJournal.markUncertain(sourceRef);
    }
    store.database.exec("COMMIT"); locked = false;
    return Object.freeze({ state: reservation.state === "uncertain" || intent.state === "uncertain" ? "uncertain" : "reserved",
      transactionHash: signed.transactionHash, mayBroadcast: false, finalized: false });
  } catch {
    if (locked) { try { store.database.exec("ROLLBACK"); } catch {} }
    throw new Error("durable destination reservation unavailable");
  }
}
