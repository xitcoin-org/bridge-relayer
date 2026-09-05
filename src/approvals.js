import { readBoundedText, withDeadline } from "./bounded-response.js";
import {
  Signature,
  getAddress,
  isHexString,
  recoverAddress,
} from "ethers";

import {
  DIRECTION_INBOUND,
  DIRECTION_OUTBOUND,
  attestationDigest,
  releaseDigest,
} from "./protocol.js";

export const APPROVAL_PROTOCOL_VERSION = 1;

function positiveInteger(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function signerSet(values) {
  if (!Array.isArray(values) || values.length !== 3) {
    throw new Error("exactly three authorized signers are required");
  }
  const normalized = values.map((value) => getAddress(value));
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== 3) {
    throw new Error("authorized signers must be distinct");
  }
  return normalized;
}

function deadlineOf(direction, payload) {
  return positiveInteger(
    direction === DIRECTION_INBOUND ? payload.deadlineUnix : payload.deadline,
    "approval deadline",
  );
}

export function buildApprovalRequest({ direction, payload }) {
  if (![DIRECTION_INBOUND, DIRECTION_OUTBOUND].includes(direction)) {
    throw new Error("invalid approval direction");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("approval payload is required");
  }
  const digest = direction === DIRECTION_INBOUND
    ? attestationDigest({ ...payload, direction })
    : releaseDigest(payload);
  return Object.freeze({
    version: APPROVAL_PROTOCOL_VERSION,
    direction,
    digest: digest.toLowerCase(),
    deadlineUnix: deadlineOf(direction, payload),
    payload: structuredClone(payload),
  });
}

export function verifyApproval({ request, response, authorizedSigners, nowUnix = Math.floor(Date.now() / 1000) }) {
  const expected = buildApprovalRequest(request);
  if (expected.deadlineUnix < positiveInteger(nowUnix, "current time", 0)) {
    throw new Error("approval request has expired");
  }
  if (!response || typeof response !== "object") throw new Error("invalid approval response");
  if (String(response.digest).toLowerCase() !== expected.digest) {
    throw new Error("approval digest mismatch");
  }
  if (!isHexString(response.signature, 65)) throw new Error("approval signature must contain 65 bytes");
  const signature = Signature.from(response.signature);
  const recovered = getAddress(recoverAddress(expected.digest, signature));
  const allowed = signerSet(authorizedSigners);
  if (!allowed.some((signer) => signer === recovered)) throw new Error("approval is not from an authorized signer");
  if (response.signer && getAddress(response.signer) !== recovered) {
    throw new Error("approval signer does not match the signature");
  }
  return Object.freeze({ signer: recovered, digest: expected.digest, signature: signature.serialized });
}

export async function collectApprovalQuorum({
  clients,
  request,
  authorizedSigners,
  threshold = 2,
  nowUnix = Math.floor(Date.now() / 1000),
}) {
  const allowed = signerSet(authorizedSigners);
  const required = positiveInteger(threshold, "approval threshold");
  if (required > allowed.length) throw new Error("approval threshold exceeds signer set");
  if (!Array.isArray(clients) || clients.length < required) {
    throw new Error("insufficient independent signer clients");
  }
  const identities = clients.map((client) => String(client.identity ?? "").trim());
  if (identities.some((identity) => !identity) || new Set(identities).size !== identities.length) {
    throw new Error("signer clients must have distinct identities");
  }
  const expected = buildApprovalRequest(request);
  if (expected.deadlineUnix < positiveInteger(nowUnix, "current time", 0)) {
    throw new Error("approval request has expired");
  }
  const responses = await Promise.allSettled(clients.map((client) => client.approve(expected)));
  const approvals = responses
    .filter((response) => response.status === "fulfilled")
    .map((response) => verifyApproval({
      request: expected,
      response: response.value,
      authorizedSigners: allowed,
      nowUnix,
    }));
  const unique = new Map();
  for (const approval of approvals) {
    const key = approval.signer.toLowerCase();
    if (unique.has(key)) throw new Error("duplicate signer approval");
    unique.set(key, approval);
  }
  if (unique.size < required) throw new Error("approval quorum not reached");
  return [...unique.values()]
    .sort((left, right) => left.signer.toLowerCase().localeCompare(right.signer.toLowerCase()))
    .slice(0, required);
}

function approvalUrl(value, allowHttp) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.username || url.password) throw new Error("signer credentials must not be embedded in URLs");
  if (url.protocol !== "https:" && !(allowHttp && loopback && url.protocol === "http:")) {
    throw new Error("signer URL must use HTTPS");
  }
  url.hash = "";
  return url;
}

export class RemoteSignerClient {
  constructor({ url, identity, timeoutMs = 10_000, maxResponseBytes = 16_384, allowHttp = false,
    authorizationHeader, fetchImpl = globalThis.fetch }) {
    this.url = approvalUrl(url, allowHttp);
    this.identity = String(identity ?? this.url.origin).trim();
    if (!this.identity) throw new Error("signer identity is required");
    if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
    if (typeof authorizationHeader !== "function") throw new Error("signer transport authentication is required");
    this.timeoutMs = positiveInteger(timeoutMs, "signer timeout");
    this.maxResponseBytes = positiveInteger(maxResponseBytes, "maximum signer response size");
    this.fetch = fetchImpl;
    this.authorizationHeader = authorizationHeader;
  }

  async approve(request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let body;
    try {
      const authorization = String(await withDeadline(() => this.authorizationHeader(), controller.signal));
      if (!authorization.startsWith("Bearer ") || authorization.length < 39 || /[\r\n]/.test(authorization)) {
        throw new Error("signer transport authentication is invalid");
      }
      const response = await withDeadline(() => this.fetch(this.url, {
        method: "POST",
        headers: { accept: "application/json", authorization, "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: controller.signal,
      }), controller.signal);
      if (!response.ok) throw new Error(`signer returned HTTP ${response.status}`);
      body = await readBoundedText(response, { maxBytes: this.maxResponseBytes, signal: controller.signal });
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error("signer returned invalid JSON");
    }
  }
}
