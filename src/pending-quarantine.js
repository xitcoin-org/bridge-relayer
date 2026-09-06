import { SignedIntentJournal } from "./signed-intent.js";
import { BroadcastIntentJournal } from "./broadcast-intent.js";
import { destinationSnapshot, exactFields } from "./destination-validation.js";
import { validateSubmitterManifest } from "./submitter-manifest.js";

// Recovery only: permanently block known custody without requiring an unexpired
// approval or pretending a chain lookup established whether it was sent.
// Commit uncertainty in custody FIRST. Failure in the second journal cannot
// restore permission, remove bytes, replace an intent or advance RelayStore.
export function quarantineCronosPending(input) {
  try {
    exactFields(input, ["signedJournal", "intentJournal", "manifest", "transferId"]);
    const { signedJournal, intentJournal, transferId } = input;
    if (!(signedJournal instanceof SignedIntentJournal)
        || !(intentJournal instanceof BroadcastIntentJournal)) throw new Error();
    const manifest = validateSubmitterManifest(destinationSnapshot(input.manifest));
    signedJournal.assertManifest(manifest);
    intentJournal.assertManifest(manifest);
    const custody = signedJournal.inspect(transferId);
    // Absence is not evidence of non-submission. Do not create empty custody.
    if (!custody.found) throw new Error();
    signedJournal.markUncertain(transferId);
    intentJournal.reserve({ transferId, approvalDigest: custody.approvalDigest,
      transactionDigest: custody.transactionDigest });
    intentJournal.markUncertain(transferId);
    return Object.freeze({ state: "uncertain", transferId,
      transactionHash: custody.transactionHash, mayBroadcast: false,
      finalized: false, mayRetry: false,
      blocker: "authenticated_transaction_status_and_finality_required" });
  } catch {
    throw new Error("pending custody quarantine unavailable");
  }
}
