import { createHash } from "node:crypto";

const HASH_RE = /^(?:0x)?[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const DIRECTIONS = Object.freeze(["cronos_to_xitcoin", "xitcoin_to_cronos"]);
const STOP_CODES = new Set([
  "rpc_disagreement",
  "deep_reorganization",
  "signer_quorum_lost",
  "destination_mismatch",
  "duplicate_broadcast",
  "readiness_lost",
  "finality_failed",
]);

function text(value, label) {
  const result = String(value ?? "").trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function integer(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return result;
}

function digest(value, label) {
  const result = text(value, label).toLowerCase();
  if (!HASH_RE.test(result)) throw new Error(`${label} must be a SHA-256 or transaction hash`);
  return result.replace(/^0x/, "");
}

function amount(value, label = "amount") {
  const result = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(result)) throw new Error(`${label} must be a positive integer string`);
  return BigInt(result);
}

export function validateCanaryPlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("canary plan is required");
  const releaseCommit = text(plan.releaseCommit, "release commit");
  if (!COMMIT_RE.test(releaseCommit)) throw new Error("release commit must be immutable");
  const decisionId = digest(plan.decisionId, "decision id");
  const preflightDigest = digest(plan.preflightDigest, "preflight digest");
  const routeId = text(plan.routeId, "route id");
  if (routeId !== "cronos-xitcoin-xtc-v1") throw new Error("canary route is not canonical");
  const cronosChainId = text(plan.cronosChainId, "Cronos chain id");
  if (cronosChainId !== "25") throw new Error("Cronos chain id must be 25");
  const xitcoinChainId = text(plan.xitcoinChainId, "Xitcoin chain id");
  if (xitcoinChainId !== "xitcoin-testnet-1") {
    throw new Error("Xitcoin Testnet chain id must be xitcoin-testnet-1");
  }
  const startsAtUnix = integer(plan.startsAtUnix, "start time");
  const expiresAtUnix = integer(plan.expiresAtUnix, "expiry time");
  if (expiresAtUnix <= startsAtUnix || expiresAtUnix - startsAtUnix > 3600) throw new Error("canary window must be at most one hour");
  const maximumTransfers = integer(plan.maximumTransfers, "maximum transfers");
  if (maximumTransfers !== 2) throw new Error("exactly two canary transfers are required");
  const maximumAmount = amount(plan.maximumAmount, "maximum amount");
  const directions = Array.isArray(plan.directions) ? [...plan.directions] : [];
  if (directions.length !== DIRECTIONS.length || directions.some((value, index) => value !== DIRECTIONS[index])) {
    throw new Error("both canonical directions are required in order");
  }
  return Object.freeze({ releaseCommit, decisionId, preflightDigest, routeId, cronosChainId, xitcoinChainId, startsAtUnix, expiresAtUnix, maximumTransfers, maximumAmount, directions: DIRECTIONS });
}

export class CanarySession {
  constructor({ plan, nowUnix = () => Math.floor(Date.now() / 1000) }) {
    this.plan = validateCanaryPlan(plan);
    if (typeof nowUnix !== "function") throw new Error("canary clock is required");
    this.nowUnix = nowUnix;
    this.state = "planned";
    this.evidence = [];
    this.transactionHashes = new Set();
    this.failureCode = null;
  }

  authorize({ preflightPassed, preflightDigest }) {
    if (this.state !== "planned") throw new Error("canary authorization is not repeatable");
    const now = this.nowUnix();
    if (now < this.plan.startsAtUnix || now > this.plan.expiresAtUnix) throw new Error("canary authorization window is closed");
    if (preflightPassed !== true || digest(preflightDigest, "preflight digest") !== this.plan.preflightDigest) {
      throw new Error("matching successful preflight is required");
    }
    this.state = "authorized";
  }

  recordFinalizedTransfer(record) {
    if (this.state !== "authorized" && this.state !== "executing") throw new Error("canary is not authorized");
    if (this.nowUnix() > this.plan.expiresAtUnix) return this.halt("readiness_lost");
    const direction = text(record?.direction, "direction");
    if (direction !== this.plan.directions[this.evidence.length]) return this.halt("destination_mismatch");
    const value = amount(record?.amount);
    if (value > this.plan.maximumAmount) return this.halt("destination_mismatch");
    if (record?.sourceFinalized !== true || record?.destinationFinalized !== true || record?.canonical !== true) return this.halt("finality_failed");
    if (record?.duplicateBroadcasts !== 0) return this.halt("duplicate_broadcast");
    const sourceTxHash = digest(record?.sourceTxHash, "source transaction hash");
    const destinationTxHash = digest(record?.destinationTxHash, "destination transaction hash");
    if (sourceTxHash === destinationTxHash || this.transactionHashes.has(sourceTxHash) || this.transactionHashes.has(destinationTxHash)) {
      return this.halt("duplicate_broadcast");
    }
    if (this.evidence.length >= this.plan.maximumTransfers) return this.halt("duplicate_broadcast");
    this.transactionHashes.add(sourceTxHash);
    this.transactionHashes.add(destinationTxHash);
    this.state = "executing";
    this.evidence.push(Object.freeze({ direction, amount: value.toString(), sourceTxHash, destinationTxHash, finalized: true, canonical: true }));
    return true;
  }

  halt(code) {
    if (!STOP_CODES.has(code)) throw new Error("unknown canary stop code");
    this.state = "halted";
    this.failureCode = code;
    return false;
  }

  complete() {
    if (this.state !== "executing" || this.evidence.length !== this.plan.maximumTransfers) throw new Error("complete canary evidence is required");
    this.state = "completed";
    return this.report();
  }

  report() {
    const evidence = this.evidence.map((item) => ({ ...item }));
    const body = JSON.stringify({ version: 1, releaseCommit: this.plan.releaseCommit, decisionId: this.plan.decisionId, state: this.state, failureCode: this.failureCode, evidence });
    return Object.freeze({
      version: 1,
      releaseCommit: this.plan.releaseCommit,
      decisionId: this.plan.decisionId,
      state: this.state,
      passed: this.state === "completed",
      failureCode: this.failureCode,
      evidence: Object.freeze(evidence.map(Object.freeze)),
      reportDigest: createHash("sha256").update(body).digest("hex"),
    });
  }
}
