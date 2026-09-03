import { Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { SigningKey, computeAddress } from "ethers";

import { buildApprovalRequest } from "../src/approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND } from "../src/protocol.js";
import { IsolatedSignerService, authorizeSignerRequest, createSignerHttpHandler, createSignerPolicy } from "../src/signer-service.js";

const KEY = new SigningKey(`0x${"11".repeat(32)}`);
const ADDRESS = computeAddress(KEY.publicKey);
const VAULT = "0x1111111111111111111111111111111111111111";

function inbound(overrides = {}) {
  return buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: { routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: `0x${"aa".repeat(32)}`, nonce: "7", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9", amount: "1000000000000000000", deadlineUnix: 1_900_000_300, ...overrides } });
}

function outbound(overrides = {}) {
  return buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: { routeId: "cronos-xitcoin-xtc-v1", chainId: 25, vault: VAULT, sourceBurnId: `0x${"bb".repeat(32)}`, recipient: "0x2222222222222222222222222222222222222222", amount: "1000000000000000000", signerSetVersion: 4, deadline: 1_900_000_300, ...overrides } });
}

function policy() {
  return createSignerPolicy({ routeIds: ["cronos-xitcoin-xtc-v1"], cronosChainIds: [25], cronosVaults: [VAULT], maximumAmount: "2000000000000000000", maximumDeadlineSeconds: 600 });
}

test("authorizes only the pinned route, chain, vault, amount and deadline", () => {
  assert.equal(authorizeSignerRequest({ request: inbound(), policy: policy(), nowUnix: 1_900_000_000 }).digest, inbound().digest);
  assert.equal(authorizeSignerRequest({ request: outbound(), policy: policy(), nowUnix: 1_900_000_000 }).digest, outbound().digest);
  assert.throws(() => authorizeSignerRequest({ request: inbound({ routeId: "other-route" }), policy: policy(), nowUnix: 1_900_000_000 }), /route/);
  assert.throws(() => authorizeSignerRequest({ request: inbound({ amount: "3000000000000000000" }), policy: policy(), nowUnix: 1_900_000_000 }), /amount/);
  assert.throws(() => authorizeSignerRequest({ request: outbound({ vault: "0x3333333333333333333333333333333333333333" }), policy: policy(), nowUnix: 1_900_000_000 }), /vault/);
  assert.throws(() => authorizeSignerRequest({ request: outbound({ routeId: "other-route" }), policy: policy(), nowUnix: 1_900_000_000 }), /route/);
  assert.throws(() => authorizeSignerRequest({ request: inbound({ deadlineUnix: 1_900_001_000 }), policy: policy(), nowUnix: 1_900_000_000 }), /deadline/);
});

test("signs only after independent canonical finality verification", async () => {
  const service = new IsolatedSignerService({ identity: "signer-one", signerAddress: ADDRESS, policy: policy(), verifySource: async (request) => ({ canonical: true, finalized: true, digest: request.digest }), signDigest: async (digest) => KEY.sign(digest).serialized });
  const approval = await service.approve(inbound(), { nowUnix: 1_900_000_000 });
  assert.equal(approval.signer, ADDRESS);
  assert.equal(approval.digest, inbound().digest);
  const unsafe = new IsolatedSignerService({ identity: "signer-two", signerAddress: ADDRESS, policy: policy(), verifySource: async () => ({ canonical: true, finalized: false }), signDigest: async (digest) => KEY.sign(digest).serialized });
  await assert.rejects(() => unsafe.approve(inbound(), { nowUnix: 1_900_000_000 }), /canonical and finalized/);
});

test("rejects a signature from an account other than the configured signer", async () => {
  const wrong = new SigningKey(`0x${"22".repeat(32)}`);
  const service = new IsolatedSignerService({ identity: "signer-one", signerAddress: ADDRESS, policy: policy(), verifySource: async () => ({ canonical: true, finalized: true }), signDigest: async (digest) => wrong.sign(digest).serialized });
  await assert.rejects(() => service.approve(inbound(), { nowUnix: 1_900_000_000 }), /wrong account/);
});

function responseCapture() {
  return { status: 0, headers: {}, body: "", writeHead(status, headers = {}) { this.status = status; this.headers = headers; return this; }, end(body = "") { this.body += body; } };
}

test("HTTP boundary requires authorization and bounded JSON", async () => {
  const service = { async approve(request) { return { accepted: request.digest }; } };
  const handler = createSignerHttpHandler({ service, authorize: async (request) => request.headers.authorization === "test-only", maximumRequestBytes: 4096 });
  const denied = Readable.from([JSON.stringify(inbound())]);
  Object.assign(denied, { method: "POST", url: "/v1/approve", headers: {} });
  const deniedResponse = responseCapture();
  await handler(denied, deniedResponse);
  assert.equal(deniedResponse.status, 401);
  assert.equal(deniedResponse.body, '{"error":"request_rejected"}');
  const encoded = JSON.stringify(inbound());
  const allowed = Readable.from([encoded]);
  Object.assign(allowed, { method: "POST", url: "/v1/approve", headers: { authorization: "test-only", "content-length": String(Buffer.byteLength(encoded)) } });
  const allowedResponse = responseCapture();
  await handler(allowed, allowedResponse);
  assert.equal(allowedResponse.status, 200);
  assert.equal(JSON.parse(allowedResponse.body).accepted, inbound().digest);
});
