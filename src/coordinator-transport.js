import { isAbsolute, join } from "node:path";

import { RemoteSignerClient } from "./approvals.js";
import { createBearerCredentialHeader } from "./secure-keystore.js";

function credentialDirectory(value) {
  const directory = String(value ?? "");
  if (!isAbsolute(directory)) throw new Error("systemd credentials directory must be absolute");
  return directory;
}

function signerDefinitions(values) {
  if (!Array.isArray(values) || values.length !== 3) throw new Error("exactly three signer transports are required");
  const identities = new Set();
  const ports = new Set();
  return values.map((value, offset) => {
    const identity = String(value?.identity ?? "").trim();
    if (identity !== `signer-${offset + 1}` || identities.has(identity)) throw new Error("signer transport identity is invalid");
    identities.add(identity);
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/v1/approve" || url.search || url.hash) {
      throw new Error("signer transport must use the canonical loopback endpoint");
    }
    const port = Number(url.port);
    if (port !== 43_101 + offset || ports.has(port)) throw new Error("signer transport port is invalid");
    ports.add(port);
    return Object.freeze({ identity, url: url.toString() });
  });
}

export async function createCredentialedSignerClients({
  signers,
  credentialsDirectory,
  expectedOwnerUid = process.geteuid(),
  loadHeader = createBearerCredentialHeader,
  clientFactory = (options) => new RemoteSignerClient(options),
  fetchImpl = globalThis.fetch,
}) {
  if (typeof loadHeader !== "function" || typeof clientFactory !== "function") {
    throw new Error("coordinator transport dependencies are required");
  }
  const directory = credentialDirectory(credentialsDirectory);
  const definitions = signerDefinitions(signers);
  return Promise.all(definitions.map(async (definition, offset) => {
    const authorizationHeader = await loadHeader({
      credentialPath: join(directory, `signer-${offset + 1}-transport-token`),
      expectedOwnerUid,
    });
    return clientFactory({ ...definition, allowHttp: true, authorizationHeader, fetchImpl });
  }));
}
