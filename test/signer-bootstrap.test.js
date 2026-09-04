import assert from "node:assert/strict";
import test from "node:test";

import { buildSignerRuntime, loadSignerConfig, validateSignerConfig } from "../src/signer-bootstrap.js";

const CONFIG = Object.freeze({
  version: 1,
  identity: "signer-1",
  expectedAddress: "0xF54f893fc9b983589d3812a0F1F318d593763E55",
  keystorePath: "/var/lib/xitcoin-bridge/signer-1/keystore.json",
  listen: { host: "127.0.0.1", port: 43101 },
  policy: {
    routeId: "cronos-testnet-xitcoin-testnet",
    cronosRouteId: "0x21121c16b53a726056a6683f00c7eb4da5501ce8a2abc8a4677e06f1e94b5cd9",
    cronosChainId: 338,
    cronosVault: "0x1111111111111111111111111111111111111111",
    maximumAmount: "1000",
    maximumDeadlineSeconds: 300,
  },
  cronos: {
    rpcUrls: ["https://cronos-a.example.test", "https://cronos-b.example.test"],
    confirmations: 64,
  },
  xitcoin: {
    rpcUrls: ["https://xitcoin-a.example.test", "http://127.0.0.1:41657"],
    chainId: "xitcoin-testnet-v2-1",
    safetyLag: 1,
    allowLoopbackHttp: true,
  },
});

test("accepts only a strict pinned testnet signer configuration", () => {
  const config = validateSignerConfig(CONFIG);
  assert.equal(config.identity, "signer-1");
  assert.equal(config.policy.cronosChainId, 338);
  assert.equal(config.policy.cronosRouteId, "0x21121c16b53a726056a6683f00c7eb4da5501ce8a2abc8a4677e06f1e94b5cd9");
  assert.equal(config.xitcoin.chainId, "xitcoin-testnet-v2-1");
  assert.throws(() => validateSignerConfig({ ...CONFIG, unexpected: true }), /unsupported/);
  assert.throws(() => validateSignerConfig({ ...CONFIG, identity: "signer-4" }), /canonical/);
  assert.throws(() => validateSignerConfig({ ...CONFIG, policy: { ...CONFIG.policy, cronosChainId: 25 } }), /must be 338/);
  assert.throws(() => validateSignerConfig({ ...CONFIG, policy: { ...CONFIG.policy, routeId: "cronos-xitcoin-xtc-v1" } }), /not canonical/);
  assert.throws(() => validateSignerConfig({ ...CONFIG, policy: { ...CONFIG.policy, cronosRouteId: `0x${"66".repeat(32)}` } }), /not canonical/);
  assert.throws(() => validateSignerConfig({ ...CONFIG, xitcoin: { ...CONFIG.xitcoin, chainId: "wrong" } }), /not canonical/);
});

test("loads only a root-owned non-writable regular config without following links", async () => {
  let flags;
  let closed = false;
  const config = await loadSignerConfig("/etc/xitcoin-bridge/signer-1.json", {
    open: async (_path, openFlags) => {
      flags = openFlags;
      return {
        async stat() { return { uid: 0, mode: 0o100644, size: 100, isFile: () => true }; },
        async readFile() { return JSON.stringify(CONFIG); },
        async close() { closed = true; },
      };
    },
  });
  assert.equal(config.identity, "signer-1");
  assert.ok(flags > 0);
  assert.equal(closed, true);
  await assert.rejects(() => loadSignerConfig("relative.json"), /could not be loaded/);
  await assert.rejects(() => loadSignerConfig("/etc/config.json", {
    open: async () => ({
      async stat() { return { uid: 1000, mode: 0o100644, size: 10, isFile: () => true }; },
      async readFile() { return JSON.stringify(CONFIG); },
      async close() {},
    }),
  }), /could not be loaded/);
});

test("composes both independent watchers and starts only after credentials load", async () => {
  const calls = [];
  const fakeServer = { close() {} };
  const runtime = await buildSignerRuntime(CONFIG, {
    credentialsDirectory: "/run/credentials/xitcoin-bridge-signer-1.service",
    connectCronos: async (options) => { calls.push(["cronos", options]); return ["c1", "c2"]; },
    connectXitcoin: (options) => { calls.push(["xitcoin", options]); return ["x1", "x2"]; },
    makeCronosWatcher: (options) => ({ kind: "cronos", ...options }),
    makeXitcoinWatcher: (options) => ({ kind: "xitcoin", ...options }),
    makeVerifier: (watchers) => { calls.push(["verifier", watchers]); return async () => ({ canonical: true, finalized: true }); },
    makeService: async (options) => { calls.push(["service", options]); return { approve: async () => ({}) }; },
    makeHandler: async (options) => { calls.push(["handler", options]); return async () => {}; },
    startServer: async (options) => { calls.push(["server", options]); return fakeServer; },
  });
  assert.equal(runtime.server, fakeServer);
  assert.equal(calls.find(([name]) => name === "cronos")[1].chainId, 338);
  assert.equal(calls.find(([name]) => name === "xitcoin")[1].allowHttp, true);
  assert.equal(calls.find(([name]) => name === "verifier")[1].cronosRouteId, CONFIG.policy.cronosRouteId);
  assert.equal(calls.find(([name]) => name === "service")[1].keystoreCredentialPath, "/run/credentials/xitcoin-bridge-signer-1.service/keystore-password");
  assert.equal(calls.find(([name]) => name === "handler")[1].transportCredentialPath, "/run/credentials/xitcoin-bridge-signer-1.service/transport-token");
  assert.deepEqual(calls.find(([name]) => name === "server")[1].host, "127.0.0.1");
  assert.equal(calls.find(([name]) => name === "verifier")[1].cronosWatcher.routeId, CONFIG.policy.cronosRouteId);
});
