import { types } from "node:util";

// Input must come from bounded JSON parsing. Transport MUST enforce streaming
// byte limits and an overall timeout before parsing; this is not a transport.
export function inspectXitcoinReplayStatus(expectedId, response) {
  try {
    if (typeof expectedId !== "string" || !/^[0-9a-f]{64}$/.test(expectedId)
        || !response || typeof response !== "object" || types.isProxy(response)
        || Object.getPrototypeOf(response) !== Object.prototype) throw new Error();
    const keys = Reflect.ownKeys(response);
    if (keys.length !== 2 || !keys.includes("attestation_id") || !keys.includes("processed")) throw new Error();
    const id = Object.getOwnPropertyDescriptor(response, "attestation_id");
    const processed = Object.getOwnPropertyDescriptor(response, "processed");
    if (!Object.hasOwn(id, "value") || !Object.hasOwn(processed, "value")
        || !id.enumerable || !processed.enumerable || id.value !== expectedId
        || typeof processed.value !== "boolean") throw new Error();
    // Exactly two scalar fields: depth 1 and at most 103 serialized ASCII bytes.
    return Object.freeze({ processed: processed.value, finalized: false, mayBroadcast: false,
      blocker: "canonical_transaction_and_finality_evidence_missing" });
  } catch { throw new Error("invalid Xitcoin replay status"); }
}
