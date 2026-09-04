import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { FetchRequest, JsonRpcProvider, getAddress, isHexString } from "ethers";

function positiveInteger(value, label, minimum = 1) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

function normalizeUrl(value, { allowHttp = false } = {}) {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.username || url.password) throw new Error("RPC credentials must not be embedded in URLs");
  if (url.protocol !== "https:" && !(allowHttp && loopback && url.protocol === "http:")) {
    throw new Error("RPC URL must use HTTPS");
  }
  url.hash = "";
  return url;
}

function uniqueUrls(values, options) {
  if (!Array.isArray(values) || values.length < 2) throw new Error("at least two independent RPC URLs are required");
  const urls = values.map((value) => normalizeUrl(value, options));
  const origins = new Set(urls.map((url) => url.origin));
  if (origins.size !== urls.length) throw new Error("RPC URLs must use independent origins");
  return urls;
}

function hash(value, label) {
  const normalized = String(value).startsWith("0x") ? String(value) : `0x${value}`;
  if (!isHexString(normalized, 32)) throw new Error(`${label} must contain 32 bytes`);
  return normalized.toLowerCase();
}

export async function connectCronosProviders({
  urls,
  chainId = 25,
  timeoutMs = 10_000,
  allowHttp = false,
  providerFactory,
}) {
  const expectedChainId = BigInt(positiveInteger(chainId, "Cronos chain ID"));
  const rpcUrls = uniqueUrls(urls, { allowHttp });
  const makeProvider = providerFactory ?? ((url) => {
    const request = new FetchRequest(url);
    request.timeout = positiveInteger(timeoutMs, "timeout");
    return new JsonRpcProvider(
      request,
      { chainId: Number(expectedChainId), name: "cronos" },
      { staticNetwork: true, batchMaxCount: 1 },
    );
  });
  const providers = rpcUrls.map((url) => makeProvider(url.toString(), { timeoutMs }));
  const networks = await Promise.all(providers.map((provider) => provider.getNetwork()));
  if (networks.some((network) => BigInt(network.chainId) !== expectedChainId)) {
    throw new Error("unexpected Cronos chain ID");
  }
  return providers;
}

async function fetchWithEthers(target, { headers = {} } = {}, timeoutMs = 10_000) {
  const request = new FetchRequest(target.toString());
  request.method = "GET";
  request.timeout = positiveInteger(timeoutMs, "timeout");

  for (const [name, value] of Object.entries(headers)) {
    request.setHeader(name, value);
  }

  const response = await request.send();

  return Object.freeze({
    ok: response.statusCode >= 200 && response.statusCode < 300,
    status: response.statusCode,
    headers: Object.freeze({
      get(name) {
        return response.headers[String(name).toLowerCase()] ?? null;
      },
    }),
    async text() {
      return response.bodyText;
    },
  });
}

export class CometBftHttpClient {
  constructor({
    url,
    chainId,
    decodeBlock,
    decodeTransaction,
    timeoutMs = 10_000,
    maxResponseBytes = 8 * 1024 * 1024,
    allowHttp = false,
    fetchImpl = null,
  }) {
    if (!chainId) throw new Error("Xitcoin chain ID is required");
    if (typeof decodeBlock !== "function" || typeof decodeTransaction !== "function") {
      throw new Error("canonical Xitcoin decoders are required");
    }
    if (fetchImpl !== null && typeof fetchImpl !== "function") throw new Error("fetch implementation is invalid");
    this.url = normalizeUrl(url, { allowHttp });
    this.chainId = String(chainId);
    this.decodeBlock = decodeBlock;
    this.decodeTransaction = decodeTransaction;
    this.timeoutMs = positiveInteger(timeoutMs, "timeout");
    this.maxResponseBytes = positiveInteger(maxResponseBytes, "maximum response size");
    this.fetch = fetchImpl ?? ((target, options) => fetchWithEthers(target, options, this.timeoutMs));
  }

  async request(path, parameters = {}) {
    const target = new URL(path, this.url);
    for (const [key, value] of Object.entries(parameters)) target.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    let body;
    try {
      response = await this.fetch(target, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Xitcoin RPC returned HTTP ${response.status}`);
      const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
      if (declaredLength > this.maxResponseBytes) throw new Error("Xitcoin RPC response exceeds size limit");
      body = await response.text();
      if (Buffer.byteLength(body) > this.maxResponseBytes) throw new Error("Xitcoin RPC response exceeds size limit");
    } finally {
      clearTimeout(timer);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("Xitcoin RPC returned invalid JSON");
    }
    if (payload.error) throw new Error(`Xitcoin RPC error: ${payload.error.message ?? "unknown error"}`);
    if (!payload.result) throw new Error("Xitcoin RPC response has no result");
    return payload.result;
  }

  async status() {
    const result = await this.request("/status");
    const chainId = String(result.node_info?.network ?? "");
    const height = positiveInteger(result.sync_info?.latest_block_height, "Xitcoin height", 0);
    if (chainId !== this.chainId) throw new Error("unexpected Xitcoin chain ID");
    if (![false, "false"].includes(result.sync_info?.catching_up)) {
      throw new Error("Xitcoin RPC is still catching up");
    }
    return { chainId, height };
  }

  async block(height) {
    const expectedHeight = positiveInteger(height, "Xitcoin block height", 0);
    const result = await this.request("/block", { height: expectedHeight });
    const actualHeight = positiveInteger(result.block?.header?.height, "Xitcoin block height", 0);
    if (actualHeight !== expectedHeight) throw new Error("Xitcoin RPC returned the wrong block height");
    const transactions = result.block?.data?.txs ?? [];
    if (!Array.isArray(transactions)) throw new Error("Xitcoin block transactions must be an array");
    const transactionHashes = transactions.map((encoded) => {
      const bytes = Buffer.from(String(encoded), "base64");
      if (bytes.length === 0) throw new Error("Xitcoin block contains an invalid transaction");
      return `0x${createHash("sha256").update(bytes).digest("hex")}`;
    });
    return {
      height: actualHeight,
      hash: hash(result.block_id?.hash, "Xitcoin block hash"),
      transactionHashes,
    };
  }

  async blockResults(height) {
    const expectedHeight = positiveInteger(height, "Xitcoin block height", 0);
    const result = await this.request("/block_results", { height: expectedHeight });
    const actualHeight = positiveInteger(result.height, "Xitcoin block results height", 0);
    if (actualHeight !== expectedHeight) throw new Error("Xitcoin RPC returned results for the wrong height");
    return result;
  }

  async outboundTransfers(fromHeight, toHeight) {
    const from = positiveInteger(fromHeight, "from height", 0);
    const to = positiveInteger(toHeight, "to height", 0);
    if (to < from) throw new Error("invalid Xitcoin scan range");
    const records = [];
    for (let height = from; height <= to; height += 1) {
      const [block, results] = await Promise.all([this.block(height), this.blockResults(height)]);
      const decoded = await this.decodeBlock({
        height,
        blockHash: block.hash,
        transactionHashes: block.transactionHashes,
        results,
      });
      if (!Array.isArray(decoded)) throw new Error("Xitcoin block decoder must return an array");
      records.push(...decoded.map((item) => ({ ...item, blockHeight: height, blockHash: block.hash })));
    }
    return records;
  }

  async outboundTransfer(transactionHash, messageIndex) {
    const transaction = hash(transactionHash, "Xitcoin transaction hash");
    const index = positiveInteger(messageIndex, "message index", 0);
    const result = await this.request("/tx", { hash: transaction, prove: "false" });
    const height = positiveInteger(result.height, "Xitcoin transaction height", 0);
    const block = await this.block(height);
    const decoded = await this.decodeTransaction({ transactionHash: transaction, height, blockHash: block.hash, result });
    if (!Array.isArray(decoded)) throw new Error("Xitcoin transaction decoder must return an array");
    const record = decoded.find((item) => Number(item.messageIndex ?? 0) === index);
    return record ? { ...record, blockHeight: height, blockHash: block.hash, transactionHash: transaction } : null;
  }
}

export function connectXitcoinClients({ urls, allowHttp = false, ...options }) {
  return uniqueUrls(urls, { allowHttp }).map((url) => new CometBftHttpClient({
    ...options,
    url: url.toString(),
    allowHttp,
  }));
}

function textAttribute(value) {
  const text = String(value ?? "");
  if (!/^[\x20-\x7e]+$/.test(text)) throw new Error("invalid Xitcoin event attribute encoding");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) {
    const bytes = Buffer.from(text, "base64");
    const decoded = bytes.toString("utf8");
    const roundTrip = bytes.toString("base64");
    if (roundTrip === text && /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  }
  return text;
}

function attributes(event) {
  const result = new Map();
  for (const attribute of event.attributes ?? []) {
    const key = textAttribute(attribute.key);
    if (result.has(key)) throw new Error(`duplicate Xitcoin event attribute ${key}`);
    result.set(key, textAttribute(attribute.value));
  }
  return result;
}

function outboundEvent(event, transactionHash, fallbackMessageIndex = 0) {
  if (textAttribute(event.type) !== "bridge_outbound_burned") return null;
  const values = attributes(event);
  const required = ["request_id", "route_id", "sender", "destination", "amount", "nonce"];
  if (required.some((key) => !values.has(key))) throw new Error("incomplete Xitcoin outbound event");
  const requestId = hash(values.get("request_id"), "Xitcoin request ID");
  const amount = values.get("amount");
  const nonce = values.get("nonce");
  if (!/^[1-9][0-9]*$/.test(amount)) throw new Error("invalid Xitcoin outbound amount");
  if (!/^[1-9][0-9]*$/.test(nonce)) throw new Error("invalid Xitcoin outbound nonce");
  const messageIndexText = values.get("msg_index") ?? String(fallbackMessageIndex);
  return {
    routeId: values.get("route_id"),
    transactionHash: hash(transactionHash, "Xitcoin transaction hash"),
    messageIndex: positiveInteger(messageIndexText, "message index", 0),
    requestId,
    sender: values.get("sender"),
    destination: getAddress(values.get("destination")),
    amount,
    nonce,
  };
}

export function decodeXitcoinOutboundBlock({ transactionHashes, results }) {
  const txResults = results?.txs_results ?? [];
  if (!Array.isArray(txResults) || !Array.isArray(transactionHashes)) {
    throw new Error("invalid Xitcoin block results");
  }
  if (txResults.length !== transactionHashes.length) {
    throw new Error("Xitcoin transaction and result counts disagree");
  }
  const decoded = [];
  txResults.forEach((result, transactionIndex) => {
    if (Number(result.code ?? 0) !== 0) return;
    let fallbackMessageIndex = 0;
    for (const event of result.events ?? []) {
      const record = outboundEvent(event, transactionHashes[transactionIndex], fallbackMessageIndex);
      if (record) {
        decoded.push(record);
        fallbackMessageIndex += 1;
      }
    }
  });
  return decoded;
}

export function decodeXitcoinOutboundTransaction({ transactionHash, result }) {
  if (Number(result?.tx_result?.code ?? 0) !== 0) return [];
  const decoded = [];
  let fallbackMessageIndex = 0;
  for (const event of result?.tx_result?.events ?? []) {
    const record = outboundEvent(event, transactionHash, fallbackMessageIndex);
    if (record) {
      decoded.push(record);
      fallbackMessageIndex += 1;
    }
  }
  return decoded;
}
