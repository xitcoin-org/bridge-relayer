import assert from "node:assert/strict";
import test from "node:test";

import { createCredentialedSignerClients } from "../src/coordinator-transport.js";

const signers = [1, 2, 3].map((index) => ({
  identity: `signer-${index}`,
  url: `http://127.0.0.1:${43_100 + index}/v1/approve`,
}));

test("loads three distinct systemd credentials for canonical loopback signers", async () => {
  const loaded = [];
  const clients = await createCredentialedSignerClients({
    signers,
    credentialsDirectory: "/run/credentials/coordinator",
    expectedOwnerUid: 1001,
    loadHeader: async (options) => {
      loaded.push(options);
      return async () => `Bearer ${"a".repeat(32)}`;
    },
    clientFactory: (options) => options,
  });
  assert.equal(clients.length, 3);
  assert.deepEqual(loaded, [1, 2, 3].map((index) => ({
    credentialPath: `/run/credentials/coordinator/signer-${index}-transport-token`,
    expectedOwnerUid: 1001,
  })));
  assert.deepEqual(clients.map((client) => client.identity), ["signer-1", "signer-2", "signer-3"]);
  assert.ok(clients.every((client) => client.allowHttp === true));
});

test("rejects noncanonical, reordered and remote signer transports", async () => {
  const options = {
    credentialsDirectory: "/run/credentials/coordinator",
    loadHeader: async () => async () => `Bearer ${"a".repeat(32)}`,
    clientFactory: (value) => value,
  };
  await assert.rejects(() => createCredentialedSignerClients({ ...options, signers: signers.slice(0, 2) }), /exactly three/);
  await assert.rejects(() => createCredentialedSignerClients({ ...options, signers: [signers[1], signers[0], signers[2]] }), /identity/);
  await assert.rejects(() => createCredentialedSignerClients({ ...options, signers: [signers[0], signers[1], { identity: "signer-3", url: "https://remote.example/v1/approve" }] }), /loopback/);
  await assert.rejects(() => createCredentialedSignerClients({ ...options, signers, credentialsDirectory: "relative" }), /absolute/);
});
