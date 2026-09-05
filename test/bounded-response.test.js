import assert from "node:assert/strict";
import test from "node:test";
import { RemoteSignerClient } from "../src/approvals.js";

function client(fetchImpl, options = {}) {
  return new RemoteSignerClient({ url: "https://signer.invalid/approve", identity: "offline-mock",
    authorizationHeader: async () => `Bearer ${"a".repeat(32)}`,
    maxResponseBytes: 16, timeoutMs: 50, fetchImpl, ...options });
}
function streamed(chunks, headers = {}) {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers });
  return { response, cancelled: () => cancelled };
}
const bytes = (value) => new TextEncoder().encode(value);

test("signer bounds chunked and falsely declared responses before accumulating excess", async () => {
  for (const headers of [{}, { "content-length": "2" }]) {
    const stream = streamed([bytes("1234567890"), bytes("1234567890")], headers);
    await assert.rejects(client(async () => stream.response).approve({}), /size limit/);
    assert.equal(stream.cancelled(), true);
  }
});
test("signer rejects oversized or malformed content length and cancels", async () => {
  for (const length of ["17", "-1", "2e1", "unknown"]) {
    const stream = streamed([bytes("{}")], { "content-length": length });
    await assert.rejects(client(async () => stream.response).approve({}), /content length/);
    assert.equal(stream.cancelled(), true);
  }
});
test("signer accepts exact byte limit and split UTF-8, rejects malformed UTF-8 and JSON", async () => {
  const encoded = bytes('{"x":"é"}');
  assert.deepEqual(await client(async () => streamed([encoded.slice(0,7), encoded.slice(7)]).response,
    { maxResponseBytes: encoded.length }).approve({}), { x: "é" });
  await assert.rejects(client(async () => streamed([new Uint8Array([255])]).response).approve({}), /encoded data/);
  await assert.rejects(client(async () => new Response("{")).approve({}), /invalid JSON/);
  await assert.rejects(client(async () => ({ ok: true, text: async () => "{}" })).approve({}), /byte stream/);
});
test("signer deadline covers credentials, headers and stalled response body", async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(client(never, { authorizationHeader: never }).approve({}), /timed out/);
  await assert.rejects(client(never).approve({}), /timed out/);
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull: never, cancel() { cancelled = true; } }));
  await assert.rejects(client(async () => response).approve({}), /timed out/);
  assert.equal(cancelled, true);
});
test("signer rejects HTTP failure without parsing response content", async () => {
  await assert.rejects(client(async () => new Response("{}", { status: 503 })).approve({}), /HTTP failure/);
});
