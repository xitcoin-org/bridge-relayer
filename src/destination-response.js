import { readBoundedText, withDeadline } from "./bounded-response.js";
import { destinationSnapshot } from "./destination-validation.js";

// Transport-independent response boundary. The injected reader must honor abort
// and enforce endpoint identity/redirect policy; no endpoint is connected here.
export async function readDestinationResponse(readResponse, options = {}) {
  let timeoutMs, maxBytes;
  try {
    const limits = destinationSnapshot(options);
    if (!limits || Array.isArray(limits) || typeof limits !== "object"
        || Object.keys(limits).some((key) => !["timeoutMs", "maxBytes"].includes(key))) throw new Error();
    timeoutMs = Object.hasOwn(limits, "timeoutMs") ? limits.timeoutMs : 5000;
    maxBytes = Object.hasOwn(limits, "maxBytes") ? limits.maxBytes : 32768;
    if (typeof readResponse !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32768) throw new Error();
  } catch { throw new Error("invalid destination response"); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response, reading = false;
  try {
    response = await withDeadline(() => readResponse(controller.signal), controller.signal);
    if (!response || response.ok !== true) throw new Error();
    reading = true;
    const body = await readBoundedText(response, { maxBytes, signal: controller.signal });
    return destinationSnapshot(JSON.parse(body));
  } catch { throw new Error("invalid destination response"); }
  finally {
    if (response && !reading) {
      try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
    }
    controller.abort(); clearTimeout(timer);
  }
}
