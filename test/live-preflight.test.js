import assert from "node:assert/strict";
import test from "node:test";

import { createHostInspectors, createLiveNetworkProbe } from "../src/live-preflight.js";

const manifest = Object.freeze({
  cronosChainId: "338",
  xitcoinChainId: "xitcoin-testnet-v2-1",
  cronosRpcUrls: ["https://cronos-a.invalid", "https://cronos-b.invalid"],
  xitcoinRpcUrls: ["https://xitcoin-a.invalid", "https://xitcoin-b.invalid"],
  cronosVaultAddress: "0x1c94273C0b199b139D82da3786C9eCbE189D5919",
});

function vaultSnapshot(overrides = {}) {
  return {
    paused: async () => true,
    routeId: async () => `0x${"21".repeat(32)}`,
    asset: async () => "0x21c2B745302353DB64C7bbf5c67B13BdA5b1Da5c",
    guardian: async () => "0x8c88dC1A17e5aaC97C5132D3daeb951e974D8368",
    signerSetVersion: async () => 1n,
    signers: async () => [
      "0xF54f893fc9b983589d3812a0F1F318d593763E55",
      "0xD97756eFCeE4190Cfa8493C3B9c1789Caffc4edc",
      "0xF2a037BA8F0e210F0f1E97eFB4F903C98e9bff2E",
    ],
    maxReleaseAmount: async () => 100n,
    dailyReleaseLimit: async () => 500n,
    ...overrides,
  };
}

test("host inspectors reject interactive and unlocked identities", async () => {
  const inspectors = createHostInspectors({
    readPasswd: async () => "bridge:x:1001:1001::/nonexistent:/bin/bash\n",
    exec: async (command) => command === "passwd" ? { stdout: "bridge P" } : { stdout: "bridge" },
  });
  assert.deepEqual(await inspectors.inspectIdentity("bridge"), { exists: true, locked: false, interactive: true });
});

test("live network probe requires identical Cronos vault state", async () => {
  const providers = [{ getCode: async () => "0x01" }, { getCode: async () => "0x01" }];
  let created = 0;
  const probe = createLiveNetworkProbe(manifest, {
    connectCronos: async () => providers,
    contractFactory: () => vaultSnapshot(created++ === 1 ? { paused: async () => false } : {}),
  });
  await assert.rejects(() => probe("cronos"), /RPC disagreement/);
});

test("live network probe accepts two agreeing Cronos RPC origins", async () => {
  const providers = [{ getCode: async () => "0x01" }, { getCode: async () => "0x01" }];
  const probe = createLiveNetworkProbe(manifest, {
    connectCronos: async () => providers,
    contractFactory: () => vaultSnapshot(),
  });
  const result = await probe("cronos");
  assert.equal(result.independent, true);
  assert.equal(result.chainId, "338");
  assert.equal(result.vault.paused, true);
});

test("live network probe checks both Xitcoin RPC clients", async () => {
  const seen = [];
  const probe = createLiveNetworkProbe(manifest, {
    xitcoinClientFactory: (url) => ({ status: async () => {
      seen.push(url);
      return { chainId: "xitcoin-testnet-v2-1", height: 100 };
    } }),
  });
  const result = await probe("xitcoin");
  assert.equal(result.independent, true);
  assert.equal(seen.length, 2);
});

test("live network probe forwards the explicit loopback-only transport policy", async () => {
  const configured = { ...manifest, allowLoopbackHttp: true, xitcoinRpcUrls: ["http://127.0.0.1:41657", "http://127.0.0.1:42657"] };
  const options = [];
  const probe = createLiveNetworkProbe(configured, {
    xitcoinClientFactory: (url) => {
      options.push(url);
      return { status: async () => ({ chainId: "xitcoin-testnet-v2-1", height: 100 }) };
    },
  });
  await probe("xitcoin");
  assert.deepEqual(options, configured.xitcoinRpcUrls);
});
