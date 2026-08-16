import test from "node:test";
import assert from "node:assert/strict";
import { Interface, id } from "ethers";

import {
  CronosFinalizedWatcher,
  FinalityViolation,
  XitcoinFinalizedWatcher,
} from "../src/watchers.js";

const blockHash = `0x${"11".repeat(32)}`;
const txHash = `0x${"22".repeat(32)}`;
const depositId = `0x${"33".repeat(32)}`;
const route = id("cronos-xitcoin-xtc-v1");
const vault = "0x1111111111111111111111111111111111111111";
const depositor = "0x2222222222222222222222222222222222222222";
const recipient = "0x3333333333333333333333333333333333333333";
const iface = new Interface([
  "event Deposited(bytes32 indexed depositId,bytes32 indexed routeId,address indexed depositor,address recipient,uint256 amount,uint256 nonce)",
]);
const encoded = iface.encodeEventLog(iface.getEvent("Deposited"), [depositId, route, depositor, recipient, 500n, 7n]);
const log = {
  address: vault,
  blockNumber: 100,
  blockHash,
  transactionHash: txHash,
  index: 2,
  topics: encoded.topics,
  data: encoded.data,
};

function cronosProvider(overrides = {}) {
  const receiptLog = { address: vault, index: 2, topics: encoded.topics, data: encoded.data };
  return {
    async getBlockNumber() { return 200; },
    async getBlock(height) { return { number: height, hash: blockHash }; },
    async getLogs() { return [log]; },
    async getTransactionReceipt() {
      return { status: 1, blockNumber: 100, blockHash, logs: [receiptLog] };
    },
    ...overrides,
  };
}

test("Cronos watcher accepts only an agreed and finalized canonical deposit", async () => {
  const watcher = new CronosFinalizedWatcher({
    providers: [cronosProvider(), cronosProvider()],
    vault,
    routeId: route,
    confirmations: 64,
  });
  assert.equal(await watcher.latestFinalizedHeight(), 136);
  const [record] = await watcher.events(100, 100);
  assert.equal(record.sourceRef, depositId.slice(2));
  assert.equal(record.payload.depositId, depositId);
  assert.equal(record.payload.amount, "500");
  assert.equal(record.payload.nonce, "7");
  assert.match(record.payload.destination, /^xitcoin1/);
  assert.equal(await watcher.verifyCanonicalEvent(record), true);
});

test("Cronos watcher tolerates tip lag and stops on deep reorganization", async () => {
  const disagreeing = cronosProvider({ async getBlockNumber() { return 201; } });
  const watcher = new CronosFinalizedWatcher({ providers: [cronosProvider(), disagreeing], vault, routeId: route });
  assert.equal(await watcher.latestFinalizedHeight(), 136);

  const reorged = cronosProvider({ async getBlock(height) { return { number: height, hash: `0x${"44".repeat(32)}` }; } });
  const reorgWatcher = new CronosFinalizedWatcher({ providers: [reorged, reorged], vault, routeId: route });
  const record = new CronosFinalizedWatcher({ providers: [cronosProvider(), cronosProvider()], vault, routeId: route });
  const [deposit] = await record.events(100, 100);
  await assert.rejects(() => reorgWatcher.verifyCanonicalEvent(deposit), FinalityViolation);
});

const outbound = {
  routeId: "cronos-xitcoin-xtc-v1",
  blockHeight: 90,
  blockHash,
  transactionHash: txHash,
  messageIndex: 0,
  requestId: depositId,
  sender: "xitcoin1sender",
  destination: recipient,
  amount: "900",
  nonce: "4",
};

function xitcoinClient(overrides = {}) {
  return {
    async status() { return { chainId: "xitcoin-testnet-2026-1", height: 100 }; },
    async block(height) { return { height, hash: blockHash }; },
    async outboundTransfers() { return [outbound]; },
    async outboundTransfer() { return outbound; },
    ...overrides,
  };
}

test("Xitcoin watcher requires matching finalized messages from independent clients", async () => {
  const watcher = new XitcoinFinalizedWatcher({
    clients: [xitcoinClient(), xitcoinClient()],
    chainId: "xitcoin-testnet-2026-1",
    routeId: outbound.routeId,
    safetyLag: 2,
  });
  assert.equal(await watcher.latestFinalizedHeight(), 98);
  const [record] = await watcher.events(90, 90);
  assert.equal(record.sourceRef, depositId);
  assert.equal(record.payload.requestId, depositId);
  assert.equal(await watcher.verifyCanonicalEvent(record), true);
});

test("Xitcoin watcher stops on chain identity and event disagreement", async () => {
  const wrongChain = xitcoinClient({ async status() { return { chainId: "wrong", height: 100 }; } });
  const identityWatcher = new XitcoinFinalizedWatcher({
    clients: [wrongChain, wrongChain], chainId: "xitcoin-testnet-2026-1", routeId: outbound.routeId,
  });
  await assert.rejects(() => identityWatcher.latestFinalizedHeight(), FinalityViolation);

  const changed = xitcoinClient({ async outboundTransfers() { return [{ ...outbound, amount: "901" }]; } });
  const disagreementWatcher = new XitcoinFinalizedWatcher({
    clients: [xitcoinClient(), changed], chainId: "xitcoin-testnet-2026-1", routeId: outbound.routeId,
  });
  await assert.rejects(() => disagreementWatcher.events(90, 90), /RPC disagreement/);
});
