import { createServer as createServerDefault } from "node:http";

import { createSignerHttpHandler, IsolatedSignerService } from "./signer-service.js";
import { createBearerCredentialAuthorizer, createEncryptedKeystoreDigestSigner } from "./secure-keystore.js";

function positiveInteger(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function loopbackHost(value) {
  const host = String(value ?? "127.0.0.1");
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("signer listener must use a loopback address");
  return host;
}

export async function createSecureSignerService({
  identity,
  expectedAddress,
  keystorePath,
  keystoreCredentialPath,
  policy,
  verifySource,
  loadSigner = createEncryptedKeystoreDigestSigner,
}) {
  if (typeof loadSigner !== "function") throw new Error("secure signer loader is required");
  const key = await loadSigner({
    keystorePath,
    credentialPath: keystoreCredentialPath,
    expectedAddress,
  });
  return new IsolatedSignerService({
    identity,
    signerAddress: key.signerAddress,
    policy,
    verifySource,
    signDigest: key.signDigest,
  });
}

export async function createSecureSignerHandler({
  service,
  transportCredentialPath,
  maximumRequestBytes = 16_384,
  loadAuthorizer = createBearerCredentialAuthorizer,
}) {
  if (typeof loadAuthorizer !== "function") throw new Error("transport credential loader is required");
  const authorize = await loadAuthorizer({ credentialPath: transportCredentialPath });
  return createSignerHttpHandler({ service, authorize, maximumRequestBytes });
}

export async function startLoopbackSignerServer({
  handler,
  host = "127.0.0.1",
  port,
  backlog = 32,
  createServer = createServerDefault,
}) {
  if (typeof handler !== "function" || typeof createServer !== "function") {
    throw new Error("signer HTTP dependencies are required");
  }
  const address = loopbackHost(host);
  const listenPort = positiveInteger(port, "signer listener port");
  if (listenPort > 65_535) throw new Error("signer listener port is invalid");
  const queue = positiveInteger(backlog, "signer listener backlog");
  const server = createServer(handler);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  await new Promise((resolve, reject) => {
    const failed = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen({ host: address, port: listenPort, backlog: queue, exclusive: true });
  });
  return server;
}
