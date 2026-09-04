import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { SigningKey, computeAddress } from "ethers";

import { createSignerPolicy } from "../src/signer-service.js";
import { createSecureSignerHandler, createSecureSignerService, startLoopbackSignerServer } from "../src/signer-runtime.js";

const KEY = new SigningKey(`0x${"51".repeat(32)}`);
const ADDRESS = computeAddress(KEY.publicKey);
const VAULT = "0x1111111111111111111111111111111111111111";

function policy() {
  return createSignerPolicy({
    routeIds: ["cronos-xitcoin-xtc-v1"],
    cronosChainIds: [338],
    cronosVaults: [VAULT],
    maximumAmount: "1000",
  });
}

test("composes an isolated service from the secure key loader", async () => {
  let loaded;
  const service = await createSecureSignerService({
    identity: "signer-1",
    expectedAddress: ADDRESS,
    keystorePath: "/state/keystore.json",
    keystoreCredentialPath: "/run/credentials/keystore-password",
    policy: policy(),
    verifySource: async () => ({ canonical: true, finalized: true }),
    loadSigner: async (options) => {
      loaded = options;
      return { signerAddress: ADDRESS, signDigest: async (digest) => KEY.sign(digest).serialized };
    },
  });
  assert.equal(service.identity, "signer-1");
  assert.deepEqual(loaded, {
    keystorePath: "/state/keystore.json",
    credentialPath: "/run/credentials/keystore-password",
    expectedAddress: ADDRESS,
  });
});

test("loads transport authorization before creating the bounded handler", async () => {
  let credentialPath;
  const handler = await createSecureSignerHandler({
    service: { approve: async () => ({ ok: true }) },
    transportCredentialPath: "/run/credentials/transport-token",
    loadAuthorizer: async (options) => {
      credentialPath = options.credentialPath;
      return async () => true;
    },
  });
  assert.equal(typeof handler, "function");
  assert.equal(credentialPath, "/run/credentials/transport-token");
});

class FakeServer extends EventEmitter {
  listen(options) { this.options = options; queueMicrotask(() => this.emit("listening")); }
}

test("starts only on a literal loopback listener with bounded HTTP settings", async () => {
  const fake = new FakeServer();
  const server = await startLoopbackSignerServer({
    handler: async () => {},
    host: "127.0.0.1",
    port: 43101,
    createServer: () => fake,
  });
  assert.equal(server.options.host, "127.0.0.1");
  assert.equal(server.options.port, 43101);
  assert.equal(server.options.exclusive, true);
  assert.equal(server.requestTimeout, 15_000);
  await assert.rejects(() => startLoopbackSignerServer({ handler: async () => {}, host: "0.0.0.0", port: 43101 }), /loopback/);
  await assert.rejects(() => startLoopbackSignerServer({ handler: async () => {}, host: "localhost", port: 43101 }), /loopback/);
});
