// Evidence: docs/evidence/xitcoin-query.proto and its pinned source in ADAPTERS.md.
// A replay flag is not transaction or finality evidence, including when false.
export function inspectXitcoinReplayStatus(expectedId, response) {
  if (typeof expectedId !== "string" || !/^[0-9a-f]{64}$/.test(expectedId)
      || !response || typeof response !== "object" || Array.isArray(response)
      || Object.keys(response).length !== 2
      || response.attestation_id !== expectedId || typeof response.processed !== "boolean"
      || Object.keys(response).some((key) => !["attestation_id", "processed"].includes(key))) {
    throw new Error("invalid Xitcoin replay status");
  }
  return Object.freeze({ processed: response.processed, finalized: false, mayBroadcast: false,
    blocker: "canonical_transaction_and_finality_evidence_missing" });
}
