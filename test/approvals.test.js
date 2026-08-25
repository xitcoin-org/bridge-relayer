import { randomBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { SigningKey, computeAddress } from "ethers";

import { RemoteSignerClient, buildApprovalRequest, collectApprovalQuorum, verifyApproval } from "../src/approvals.js";
import { DIRECTION_INBOUND, DIRECTION_OUTBOUND } from "../src/protocol.js";

function signer() {
  const key = new SigningKey(randomBytes(32));
  return {
    address: computeAddress(key.publicKey),
    approve(request) { return { signer: this.address, digest: request.digest, signature: key.sign(request.digest).serialized }; },
  };
}

function inbound(deadlineUnix = 2_000_000_000) {
  return buildApprovalRequest({ direction: DIRECTION_INBOUND, payload: {
    routeId: "cronos-xitcoin-xtc-v1", sourceChainId: "25", sourceRef: `0x${"aa".repeat(32)}`,
    nonce: "7", destination: "xtc1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg32rdvg9",
    amount: "1000000000000000000", deadlineUnix,
  } });
}

function outbound(deadline = 2_000_000_000) {
  return buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
    chainId: 25, vault: "0x1111111111111111111111111111111111111111",
    sourceBurnId: `0x${"bb".repeat(32)}`, recipient: "0x2222222222222222222222222222222222222222",
    amount: "1000000000000000000", signerSetVersion: 4, deadline,
  } });
}

test("builds canonical inbound and outbound approval requests", () => {
  assert.match(inbound().digest, /^0x[0-9a-f]{64}$/);
  assert.match(outbound().digest, /^0x[0-9a-f]{64}$/);
  assert.notEqual(inbound().digest, outbound().digest);
});

test("collects a deterministic two-of-three authorized quorum", async () => {
  const signers = [signer(), signer(), signer()];
  const clients = signers.map((item, index) => ({ identity: `signer-${index + 1}`, async approve(value) { return item.approve(value); } }));
  const approvals = await collectApprovalQuorum({ clients, request: inbound(), authorizedSigners: signers.map((item) => item.address), nowUnix: 1_900_000_000 });
  assert.equal(approvals.length, 2);
  assert.deepEqual(approvals.map((item) => item.signer), [...approvals].map((item) => item.signer).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
});

test("keeps two-of-three availability when one signer is offline", async () => {
  const signers = [signer(), signer(), signer()];
  const clients = signers.map((item, index) => ({
    identity: `signer-${index + 1}`,
    async approve(value) {
      if (index === 2) throw new Error("offline");
      return item.approve(value);
    },
  }));
  const approvals = await collectApprovalQuorum({ clients, request: outbound(), authorizedSigners: signers.map((item) => item.address), nowUnix: 1_900_000_000 });
  assert.equal(approvals.length, 2);
});

test("rejects duplicate, unauthorized, expired and wrong-domain approvals", async () => {
  const signers = [signer(), signer(), signer()];
  const request = inbound();
  const duplicateClients = [1, 2].map((number) => ({ identity: `duplicate-${number}`, async approve(value) { return signers[0].approve(value); } }));
  await assert.rejects(() => collectApprovalQuorum({ clients: duplicateClients, request, authorizedSigners: signers.map((item) => item.address), nowUnix: 1_900_000_000 }), /duplicate signer/);
  const outsider = signer();
  assert.throws(() => verifyApproval({ request, response: outsider.approve(request), authorizedSigners: signers.map((item) => item.address), nowUnix: 1_900_000_000 }), /authorized signer/);
  const expired = inbound(100);
  assert.throws(() => verifyApproval({ request: expired, response: signers[0].approve(expired), authorizedSigners: signers.map((item) => item.address), nowUnix: 101 }), /expired/);
  assert.throws(() => verifyApproval({ request, response: signers[0].approve(outbound()), authorizedSigners: signers.map((item) => item.address), nowUnix: 1_900_000_000 }), /digest mismatch/);
});

test("remote signer transport requires safe URLs and bounded JSON", async () => {
  assert.throws(() => new RemoteSignerClient({ url: "http://signer.example", identity: "one" }), /HTTPS/);
  assert.throws(() => new RemoteSignerClient({ url: "https://user:secret@signer.example", identity: "one" }), /credentials/);
  const client = new RemoteSignerClient({ url: "http://127.0.0.1:9000/approve", identity: "local-test", allowHttp: true,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "2" }, async text() { return "{}"; } }),
  });
  assert.deepEqual(await client.approve(inbound()), {});
});
