import { types } from "node:util";
import { buildApprovalRequest, verifyApproval } from "./approvals.js";

// Snapshot untrusted in-process inputs without invoking getters, toJSON or proxies.
// Transport allocation must be bounded separately, before JSON parsing.
export function destinationSnapshot(input) {
  let remaining = 32_768;
  let nodes = 512;
  function copy(value, depth) {
    if (--nodes < 0 || depth > 6) throw new Error();
    if (typeof value === "string") {
      remaining -= value.length;
      if (remaining < 0) throw new Error();
      return value;
    }
    if (typeof value === "boolean" || value === null) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (!value || typeof value !== "object" || types.isProxy(value)) throw new Error();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 64) throw new Error();
    const result = array ? [] : {};
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key.length > 64 || key === "__proto__") throw new Error();
      if (array && key !== String(result.length)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      result[key] = copy(descriptor.value, depth + 1);
    }
    if (array && result.length !== value.length) throw new Error();
    return Object.freeze(result);
  }
  return copy(input, 0);
}

export function exactFields(value, fields) {
  if (!value || Array.isArray(value) || typeof value !== "object"
      || Object.keys(value).length !== fields.length || fields.some((key) => !Object.hasOwn(value, key))) throw new Error();
}

export function decimal(value, bits, positive = true) {
  if (typeof value !== "string" || value.length > 78 || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error();
  const number = BigInt(value);
  if ((positive && number === 0n) || number >= (1n << BigInt(bits))) throw new Error();
  return number;
}

export function verifiedDestinationQuorum(request, approvals, authorizedSigners, nowUnix) {
  exactFields(request, ["version", "direction", "digest", "deadlineUnix", "payload"]);
  const expected = buildApprovalRequest(request);
  if (request.version !== expected.version || request.digest !== expected.digest
      || request.deadlineUnix !== expected.deadlineUnix
      || !Number.isSafeInteger(nowUnix) || nowUnix < 0) throw new Error();
  if (!Array.isArray(approvals) || approvals.length < 2 || approvals.length > 3) throw new Error();
  const verified = approvals.map((response) => {
    exactFields(response, ["signer", "digest", "signature"]);
    return verifyApproval({ request, response, authorizedSigners, nowUnix });
  });
  // Approval protocol v1 orders authorized recovered addresses numerically,
  // independent of the supplied set's enumeration. Never repair caller order.
  for (let i = 1; i < verified.length; i++) {
    if (BigInt(verified[i - 1].signer) >= BigInt(verified[i].signer)) throw new Error();
  }
  if (new Set(verified.map((a) => a.signer)).size !== verified.length) throw new Error();
  return Object.freeze(verified);
}

export function validateSourceEvidence(value) {
  exactFields(value, ["blockHeight", "blockHash", "transactionHash", "eventIndex"]);
  if (!Number.isSafeInteger(value.blockHeight) || value.blockHeight < 1
      || !Number.isSafeInteger(value.eventIndex) || value.eventIndex < 0
      || !/^0x[0-9a-f]{64}$/.test(value.blockHash)
      || !/^0x[0-9a-f]{64}$/.test(value.transactionHash)) throw new Error();
}

export function decimalOrSafeInteger(value, bits) {
  return decimal(typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value, bits);
}
