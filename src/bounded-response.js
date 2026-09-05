import { Buffer } from "node:buffer";

// A deadline must settle the caller even when an injected dependency ignores
// AbortSignal. Such dependencies remain trusted to release their own resources.
export async function withDeadline(operation, signal) {
  if (signal.aborted) throw new Error("signer request timed out");
  let abort;
  const expired = new Promise((_, reject) => {
    abort = () => reject(new Error("signer request timed out"));
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
    throw new Error("signer response requires a readable byte stream");
  }
  const reader = response.body.getReader();
  let complete = false;
  try {
    const declared = response.headers?.get?.("content-length");
    if (declared !== null && declared !== undefined
        && (!/^(0|[1-9][0-9]*)$/.test(declared) || BigInt(declared) > BigInt(maxBytes))) {
      throw new Error("signer response exceeds size limit or has invalid content length");
    }
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await withDeadline(() => reader.read(), signal);
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array)) throw new Error("signer response is not a byte stream");
      if (value.byteLength > maxBytes - length) throw new Error("signer response exceeds size limit");
      length += value.byteLength;
      if (value.byteLength) chunks.push(Buffer.from(value));
    }
    // Count decoded transport bytes, not characters or compressed wire length.
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length));
  } finally {
    if (!complete) {
      // Cancellation must not turn a rejected read into an unbounded wait.
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    }
    reader.releaseLock();
  }
}
