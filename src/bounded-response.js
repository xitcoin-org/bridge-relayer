import { Buffer } from "node:buffer";
import { signerTransportError } from "./signer-transport-error.js";

// A deadline must settle the caller even when an injected dependency ignores
// AbortSignal. Such dependencies remain trusted to release their own resources.
export async function withDeadline(operation, signal) {
  if (signal.aborted) throw signerTransportError("TIMEOUT");
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(signerTransportError("TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), expired]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function readBoundedText(response, { maxBytes, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid response size limit");
  if (!response.body || typeof response.body.getReader !== "function") {
    throw signerTransportError("STREAM");
  }
  const reader = response.body.getReader();
  let complete = false;
  try {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined
        && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
      throw signerTransportError("LENGTH");
    }
    const chunks = [];
    let length = 0;
    let reads = 0;
    while (true) {
      // Immediately resolved empty reads can starve timers without consuming
      // the byte budget. Bound reads as well as bytes, including the final done.
      if (++reads > Math.min(maxBytes, 65_535) + 1) throw signerTransportError("SIZE");
      const { done, value } = await withDeadline(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw signerTransportError("STREAM");
      if (value.byteLength > maxBytes - length) throw signerTransportError("SIZE");
      length += value.byteLength;
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    // Count decoded transport bytes, not characters or compressed wire length.
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
    } catch {
      throw signerTransportError("ENCODING");
    }
  } finally {
    if (!complete) {
      // Cancellation must not turn a rejected read into an unbounded wait.
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    }
    try { reader.releaseLock(); } catch {}
  }
}
