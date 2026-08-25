import { Interface, getAddress, isHexString } from "ethers";

import { evmAddressToBech32 } from "./address.js";
import { normalizeBytes32 } from "./protocol.js";

const depositInterface = new Interface([
  "event Deposited(bytes32 indexed depositId,bytes32 indexed routeId,address indexed depositor,address recipient,uint256 amount,uint256 nonce)",
]);
const depositTopic = depositInterface.getEvent("Deposited").topicHash;

function integer(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function hash(value, label) {
  if (!isHexString(value, 32)) throw new Error(`${label} must contain 32 bytes`);
  return value.toLowerCase();
}

function stable(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function requireAgreement(values, label) {
  if (values.length === 0) throw new Error(`no ${label} source configured`);
  const expected = stable(values[0]);
  if (values.some((value) => stable(value) !== expected)) throw new Error(`${label} RPC disagreement`);
  return values[0];
}

export class FinalityViolation extends Error {
  constructor(message) {
    super(message);
    this.name = "FinalityViolation";
  }
}

export class SourceWatcher {
  async latestFinalizedHeight() { throw new Error("latestFinalizedHeight must be implemented"); }
  async events() { throw new Error("events must be implemented"); }
  async verifyCanonicalEvent() { throw new Error("verifyCanonicalEvent must be implemented"); }
}

export class CronosFinalizedWatcher extends SourceWatcher {
  constructor({ providers, vault, routeId, xitcoinPrefix = "xtc", confirmations = 64, maxBatch = 500 }) {
    super();
    if (!Array.isArray(providers) || providers.length < 2) {
      throw new Error("at least two independent Cronos providers are required");
    }
    this.providers = providers;
    this.vault = getAddress(vault);
    this.routeId = normalizeBytes32(routeId);
    this.xitcoinPrefix = xitcoinPrefix;
    this.confirmations = integer(confirmations, "confirmations", 1);
    this.maxBatch = integer(maxBatch, "max batch", 1);
  }

  async latestFinalizedHeight() {
    const tips = await Promise.all(this.providers.map((provider) => provider.getBlockNumber()));
    const normalized = tips.map((tip) => integer(tip, "Cronos height"));
    const tip = Math.min(...normalized);
    return Math.max(0, tip - this.confirmations);
  }

  async canonicalBlock(height) {
    const blocks = await Promise.all(this.providers.map((provider) => provider.getBlock(height)));
    if (blocks.some((block) => !block)) throw new FinalityViolation(`Cronos block ${height} unavailable`);
    return requireAgreement(
      blocks.map((block) => ({ number: Number(block.number), hash: hash(block.hash, "block hash") })),
      `Cronos block ${height}`,
    );
  }

  decode(log) {
    const decoded = depositInterface.parseLog({ topics: log.topics, data: log.data });
    if (!decoded || decoded.name !== "Deposited") throw new Error("unexpected Cronos log");
    const routeId = normalizeBytes32(decoded.args.routeId);
    if (routeId !== this.routeId) throw new FinalityViolation("Cronos deposit route mismatch");
    const recipient = getAddress(decoded.args.recipient);
    const depositId = normalizeBytes32(decoded.args.depositId);
    const transactionHash = hash(log.transactionHash, "transaction hash");
    const logIndex = integer(log.index ?? log.logIndex, "log index");
    return {
      sourceChain: "cronos",
      sourceRef: depositId.slice(2),
      routeId,
      blockHeight: integer(log.blockNumber, "block height"),
      blockHash: hash(log.blockHash, "block hash"),
      transactionHash,
      logIndex,
      payload: {
        depositId,
        depositor: getAddress(decoded.args.depositor),
        recipient,
        destination: evmAddressToBech32(recipient, this.xitcoinPrefix),
        amount: decoded.args.amount.toString(),
        nonce: decoded.args.nonce.toString(),
      },
    };
  }

  async events(fromHeight, toHeight) {
    const from = integer(fromHeight, "from height");
    const to = integer(toHeight, "to height");
    if (to < from || to - from + 1 > this.maxBatch) throw new Error("invalid Cronos scan range");
    if (to > await this.latestFinalizedHeight()) throw new FinalityViolation("requested Cronos range is not finalized");
    const filter = { address: this.vault, topics: [depositTopic], fromBlock: from, toBlock: to };
    const batches = await Promise.all(this.providers.map((provider) => provider.getLogs(filter)));
    requireAgreement(batches.map((logs) => logs.map((log) => ({
      blockHash: String(log.blockHash).toLowerCase(),
      transactionHash: String(log.transactionHash).toLowerCase(),
      index: Number(log.index ?? log.logIndex),
      topics: log.topics.map((topic) => topic.toLowerCase()),
      data: log.data.toLowerCase(),
    }))), "Cronos logs");
    return batches[0].map((log) => this.decode(log));
  }

  async verifyCanonicalEvent(record) {
    const block = await this.canonicalBlock(record.blockHeight);
    if (block.hash !== record.blockHash.toLowerCase()) throw new FinalityViolation("Cronos finalized block hash changed");
    const receipts = await Promise.all(this.providers.map((provider) => provider.getTransactionReceipt(record.transactionHash)));
    if (receipts.some((receipt) => !receipt || Number(receipt.status) !== 1)) {
      throw new FinalityViolation("Cronos deposit receipt unavailable or reverted");
    }
    const receipt = requireAgreement(receipts.map((item) => ({
      blockNumber: Number(item.blockNumber),
      blockHash: String(item.blockHash).toLowerCase(),
      status: Number(item.status),
      logs: item.logs.map((log) => ({
        address: String(log.address).toLowerCase(),
        index: Number(log.index ?? log.logIndex),
        topics: log.topics.map((topic) => topic.toLowerCase()),
        data: log.data.toLowerCase(),
      })),
    })), "Cronos receipt");
    if (receipt.blockNumber !== record.blockHeight || receipt.blockHash !== record.blockHash.toLowerCase()) {
      throw new FinalityViolation("Cronos receipt moved to another block");
    }
    const log = receipt.logs.find((item) => item.index === record.logIndex && item.address === this.vault.toLowerCase());
    if (!log) throw new FinalityViolation("Cronos deposit log disappeared");
    const canonical = this.decode({ ...log, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, transactionHash: record.transactionHash });
    if (stable(canonical.payload) !== stable(record.payload)) throw new FinalityViolation("Cronos deposit payload changed");
    return true;
  }
}

export class XitcoinFinalizedWatcher extends SourceWatcher {
  constructor({ clients, chainId, routeId, safetyLag = 1, maxBatch = 100 }) {
    super();
    if (!Array.isArray(clients) || clients.length < 2) {
      throw new Error("at least two independent Xitcoin clients are required");
    }
    if (!chainId) throw new Error("Xitcoin chain ID is required");
    this.clients = clients;
    this.chainId = chainId;
    this.routeId = routeId;
    this.safetyLag = integer(safetyLag, "safety lag");
    this.maxBatch = integer(maxBatch, "max batch", 1);
  }

  async latestFinalizedHeight() {
    const statuses = await Promise.all(this.clients.map((client) => client.status()));
    const chainIds = statuses.map((item) => String(item.chainId));
    if (chainIds.some((chainId) => chainId !== this.chainId)) {
      throw new FinalityViolation("unexpected Xitcoin chain ID");
    }
    const height = Math.min(...statuses.map((item) => integer(item.height, "Xitcoin height")));
    return Math.max(0, height - this.safetyLag);
  }

  async canonicalBlock(height) {
    const blocks = await Promise.all(this.clients.map((client) => client.block(height)));
    return requireAgreement(blocks.map((item) => ({ height: Number(item.height), hash: hash(item.hash, "Xitcoin block hash") })), `Xitcoin block ${height}`);
  }

  normalize(event) {
    if (event.routeId !== this.routeId) throw new FinalityViolation("Xitcoin outbound route mismatch");
    const transactionHash = hash(event.transactionHash, "transaction hash");
    const messageIndex = integer(event.messageIndex ?? 0, "message index");
    const requestId = normalizeBytes32(event.requestId);
    return {
      sourceChain: "xitcoin",
      sourceRef: requestId,
      routeId: event.routeId,
      blockHeight: integer(event.blockHeight, "block height"),
      blockHash: hash(event.blockHash, "block hash"),
      transactionHash,
      messageIndex,
      payload: {
        requestId,
        sender: String(event.sender),
        destination: getAddress(event.destination),
        amount: String(event.amount),
        nonce: String(event.nonce),
      },
    };
  }

  async events(fromHeight, toHeight) {
    const from = integer(fromHeight, "from height");
    const to = integer(toHeight, "to height");
    if (to < from || to - from + 1 > this.maxBatch) throw new Error("invalid Xitcoin scan range");
    if (to > await this.latestFinalizedHeight()) throw new FinalityViolation("requested Xitcoin range is not finalized");
    const batches = await Promise.all(this.clients.map((client) => client.outboundTransfers(from, to)));
    return requireAgreement(batches.map((batch) => batch.map((event) => this.normalize(event))), "Xitcoin outbound events");
  }

  async verifyCanonicalEvent(record) {
    const block = await this.canonicalBlock(record.blockHeight);
    if (block.hash !== record.blockHash.toLowerCase()) throw new FinalityViolation("Xitcoin finalized block hash changed");
    const events = await Promise.all(this.clients.map((client) => client.outboundTransfer(record.transactionHash, record.messageIndex)));
    if (events.some((event) => !event)) throw new FinalityViolation("Xitcoin outbound transfer disappeared");
    const canonical = requireAgreement(events.map((event) => this.normalize(event)), "Xitcoin outbound transaction");
    if (stable(canonical.payload) !== stable(record.payload)) throw new FinalityViolation("Xitcoin outbound payload changed");
    return true;
  }
}

export class SignerClient {
  async approve() { throw new Error("approve must be implemented"); }
}

export class DestinationSubmitter {
  async alreadyProcessed() { throw new Error("alreadyProcessed must be implemented"); }
  async submit() { throw new Error("submit must be implemented"); }
  async finalizedReceipt() { throw new Error("finalizedReceipt must be implemented"); }
}
