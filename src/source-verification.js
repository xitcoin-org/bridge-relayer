import { getAddress, isHexString } from "ethers";

import { buildApprovalRequest } from "./approvals.js";
import { cronosRouteId, DIRECTION_INBOUND, DIRECTION_OUTBOUND, normalizeBytes32, validateRouteId } from "./protocol.js";

function positiveInteger(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function hash(value, label) {
  if (!isHexString(value, 32)) throw new Error(`${label} must contain 32 bytes`);
  return String(value).toLowerCase();
}

function evidence(payload, direction) {
  const value = payload?.sourceEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("canonical source evidence is required");
  }
  return Object.freeze({
    blockHeight: positiveInteger(value.blockHeight, "source block height", 1),
    blockHash: hash(value.blockHash, "source block hash"),
    transactionHash: hash(value.transactionHash, "source transaction hash"),
    eventIndex: positiveInteger(value.eventIndex, "source event index"),
    indexField: direction === DIRECTION_INBOUND ? "logIndex" : "messageIndex",
  });
}

function sameText(left, right) {
  return String(left) === String(right);
}

function matchesEvidence(record, expected) {
  return Number(record.blockHeight) === expected.blockHeight &&
    String(record.blockHash).toLowerCase() === expected.blockHash &&
    String(record.transactionHash).toLowerCase() === expected.transactionHash &&
    Number(record[expected.indexField]) === expected.eventIndex;
}

function matchingInbound(record, payload, expected) {
  const sourceRef = normalizeBytes32(payload.sourceRef);
  return matchesEvidence(record, expected) &&
    normalizeBytes32(record.payload?.depositId) === sourceRef &&
    normalizeBytes32(record.routeId) === cronosRouteId(validateRouteId(payload.routeId)).toLowerCase() &&
    sameText(record.payload?.destination, payload.destination) &&
    sameText(record.payload?.amount, payload.amount) &&
    sameText(record.payload?.nonce, payload.nonce);
}

function matchingOutbound(record, payload, expected) {
  return matchesEvidence(record, expected) &&
    normalizeBytes32(record.payload?.requestId) === normalizeBytes32(payload.sourceBurnId) &&
    sameText(record.routeId, validateRouteId(payload.routeId)) &&
    getAddress(record.payload?.destination) === getAddress(payload.recipient) &&
    sameText(record.payload?.amount, payload.amount);
}

export function createCanonicalSourceVerifier({ cronosWatcher, xitcoinWatcher }) {
  if (!cronosWatcher || typeof cronosWatcher.events !== "function" || typeof cronosWatcher.verifyCanonicalEvent !== "function") {
    throw new Error("Cronos source watcher is required");
  }
  if (!xitcoinWatcher || typeof xitcoinWatcher.events !== "function" || typeof xitcoinWatcher.verifyCanonicalEvent !== "function") {
    throw new Error("Xitcoin source watcher is required");
  }

  return async function verifyCanonicalSource(request) {
    const canonical = buildApprovalRequest(request);
    const expected = evidence(canonical.payload, canonical.direction);
    const watcher = canonical.direction === DIRECTION_INBOUND ? cronosWatcher : xitcoinWatcher;
    const records = await watcher.events(expected.blockHeight, expected.blockHeight);
    const matches = records.filter((record) => canonical.direction === DIRECTION_INBOUND
      ? matchingInbound(record, canonical.payload, expected)
      : matchingOutbound(record, canonical.payload, expected));

    if (matches.length !== 1) throw new Error("canonical source event does not match approval request");
    await watcher.verifyCanonicalEvent(matches[0]);
    return Object.freeze({ canonical: true, finalized: true, digest: canonical.digest });
  };
}
